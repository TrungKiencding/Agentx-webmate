/**
 * Sharing the one bridge port between several copies of this server.
 *
 * The extension dials ONE port, so one process holds it: the owner. AgentX
 * starts a copy of this server in every process that loads MCP tools — the
 * desktop app's backend, the messaging gateway (which outlives the app on
 * purpose), a slash-command worker, a cron run — and the first copy to bind
 * used to keep the browser for good while every other copy's tools failed
 * with WEBMATE_PORT_IN_USE. Every other copy is now a standby: it connects to
 * the owner on PEER_PATH, over that same port, and relays its commands
 * through it, so browser tools work in every host at once.
 *
 * Priority (config.bridgePriority) decides who holds the port. A standby that
 * outranks the owner is handed it: the owner stops listening, the standby
 * binds, and only then does the owner let go of the extension, which redials
 * within a second and lands on the new owner (WebMateBridge.beginHandoff).
 * Workmate's desktop app outranks every other host, so the app's own agent
 * always drives the browser directly — even when a gateway started days
 * earlier got the port first — and a standby takes the port back as soon as
 * the app quits.
 *
 * Wire protocol, JSON text frames on ws://127.0.0.1:<port>/peer:
 *   standby -> owner   {type:'peer_hello', client, peerProtocol, serverVersion, pid, host, priority, token}
 *   owner -> standby   {type:'peer_ack', peerProtocol, serverVersion, pid, host, priority, state}
 *   owner -> standby   {type:'state', state}                          after every bridge change
 *   standby -> owner   {type:'relay', id, action, payload, timeoutMs, target}
 *   owner -> standby   {type:'relay_result', id, ok:true, result}
 *                      {type:'relay_result', id, ok:false, error:{message, status?, code?, webmateCode?, refusal?, retry?}}
 *   owner -> standby   {type:'yield'}                                  the port is yours: bind it
 *   standby -> owner   {type:'bound'} | {type:'bind_failed'}
 *
 * Trust: a peer socket carries the authority of the extension socket itself —
 * whatever sits on it can drive the person's signed-in browser. The owner
 * therefore opens it only under a Workmate pairing, to a hello carrying
 * pairing.json's token, from a native client (browser pages always send an
 * Origin header). Without a pairing file nothing relays: a standby waits for
 * the port instead, exactly as a second copy always had to.
 */

import { timingSafeEqual } from "node:crypto";
import WebSocket from "ws";

import type { ConnectionSummary, ExtensionInfo, RequestTarget } from "./bridge.js";
import {
  BridgeError,
  isWebmateErrorCode,
  refusalFrom,
  type ExtensionRefusal,
  type WebmateErrorCode,
} from "./errors.js";

export const PEER_PATH = "/peer";

/** The `client` a standby puts in its hello. A wire identifier: never rebrand it. */
export const PEER_CLIENT_ID = "webmate-mcp-peer";

export const PEER_PROTOCOL_VERSION = 1;

/**
 * What a standby may send through the owner: the run-level commands behind the
 * six tools. Workmate's own commands (update drain, reload, sign-in) stay with
 * the owner, which is the only copy that reads the commands directory.
 */
export const RELAYABLE_ACTIONS: ReadonlySet<string> = new Set([
  "cloud_run",
  "cloud_status",
  "cloud_respond",
  "cloud_abort",
]);

/** Who is on the other end of a peer socket, as its hello or ack says. */
export interface PeerIdentity {
  pid: number | null;
  host: string | null;
  priority: number;
  serverVersion: string | null;
}

/** What the owner shares with its standbys, so their status tools read true. */
export interface PeerState {
  connected: boolean;
  pairingRequired: boolean;
  /** The owner's active extension; all-null fields when nothing is attached. */
  info: ExtensionInfo;
  connections: ConnectionSummary[];
  error: string | null;
}

/** A relay failure as it crosses the peer socket. */
export interface WireError {
  message: string;
  status?: number;
  code?: "COMMAND_TIMEOUT" | "COMMAND_INTERRUPTED";
  webmateCode?: WebmateErrorCode;
  /** The extension's own refusal (license_read_only and its license); older peers ignore it. */
  refusal?: ExtensionRefusal;
  /** The owner refused before sending anything to the extension: resend once the route settles. */
  retry?: boolean;
}

/**
 * The owner refused a relayed command without sending it, because it is
 * handing the port over. Nothing reached the browser, so resending is safe.
 */
export class RelayRetryError extends BridgeError {
  constructor(message: string) {
    super(message);
    this.name = "RelayRetryError";
  }
}

const EMPTY_INFO: ExtensionInfo = {
  version: null,
  browser: null,
  installType: null,
  signedIn: null,
  protocolVersion: null,
  lastHelloAt: null,
  capabilities: [],
  instanceId: null,
};

const str = (value: unknown, max = 200): string | null =>
  typeof value === "string" && value ? value.slice(0, max) : null;
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
const int = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;

export function parseIdentity(raw: Record<string, unknown>): PeerIdentity {
  return {
    pid: int(raw.pid),
    host: str(typeof raw.host === "string" ? raw.host.trim() : null, 40),
    priority: int(raw.priority) ?? 0,
    serverVersion: str(raw.serverVersion, 40),
  };
}

function parseInfo(raw: unknown): ExtensionInfo {
  if (!raw || typeof raw !== "object") return { ...EMPTY_INFO, capabilities: [] };
  const r = raw as Record<string, unknown>;
  return {
    version: str(r.version, 40),
    browser: str(r.browser, 80),
    installType: r.installType === "workmate" || r.installType === "dev" ? r.installType : null,
    signedIn: bool(r.signedIn),
    protocolVersion: int(r.protocolVersion),
    lastHelloAt: str(r.lastHelloAt, 40),
    capabilities: Array.isArray(r.capabilities)
      ? r.capabilities.filter((c): c is string => typeof c === "string").slice(0, 50)
      : [],
    instanceId: str(r.instanceId, 120),
  };
}

/** The owner's shared state, defensively parsed (fields default to "nothing attached"). */
export function parseState(raw: unknown): PeerState {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const connections = Array.isArray(r.connections)
    ? r.connections.slice(0, 20).map((entry): ConnectionSummary => {
        const c = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
        const info = parseInfo(c);
        return {
          ...info,
          instanceId: info.instanceId ?? "",
          paired: c.paired === true,
          active: c.active === true,
          acceptedAt: str(c.acceptedAt, 40) ?? "",
        };
      })
    : [];
  return {
    connected: r.connected === true,
    pairingRequired: r.pairingRequired === true,
    info: parseInfo(r.info),
    connections,
    error: str(r.error, 2_000),
  };
}

/** Compare a presented token with the pairing token without leaking where they differ. */
export function sameToken(presented: unknown, expected: string): boolean {
  if (typeof presented !== "string") return false;
  const left = Buffer.from(presented, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function errorToWire(error: unknown): WireError {
  if (error instanceof BridgeError) {
    return {
      message: error.message,
      ...(error.status !== undefined ? { status: error.status } : {}),
      ...(error.code ? { code: error.code } : {}),
      ...(error.webmateCode ? { webmateCode: error.webmateCode } : {}),
      ...(error.refusal ? { refusal: error.refusal } : {}),
    };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

export function errorFromWire(raw: unknown): BridgeError {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const message = str(r.message, 4_000) ?? "The bridge owner reported an unknown error.";
  if (r.retry === true) return new RelayRetryError(message);
  const code = r.code === "COMMAND_TIMEOUT" || r.code === "COMMAND_INTERRUPTED" ? r.code : undefined;
  const webmateCode = isWebmateErrorCode(r.webmateCode) ? r.webmateCode : undefined;
  return new BridgeError(message, int(r.status) ?? undefined, code, webmateCode, refusalFrom(r.refusal));
}

/** How a standby's attempt to reach the port holder ended. */
export type UpstreamOutcome =
  | { kind: "ack"; link: UpstreamLink }
  /** Nobody listens any more, or the holder is handing the port on (1012): try the port again shortly. */
  | { kind: "gone" }
  /** A WebMate server from before the peer protocol: 1.2.x closes any path but the extension's with 1008 "Unexpected path". */
  | { kind: "legacy"; reason: string }
  /** A WebMate server that will not relay for this copy (no Workmate pairing, wrong token). */
  | { kind: "refused"; reason: string }
  /** Whatever holds the port is not a WebMate bridge at all. */
  | { kind: "foreign"; reason: string };

export interface UpstreamConnectOptions {
  url: string;
  hello: Record<string, unknown>;
  timeoutMs: number;
}

interface PendingRelay {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * A standby's socket to the owner: relays commands, mirrors the owner's
 * state, and hears when the port is being handed over to this copy.
 */
export class UpstreamLink {
  readonly owner: PeerIdentity;
  state: PeerState;
  private pending = new Map<number, PendingRelay>();
  private nextId = 1;
  private closed = false;
  /**
   * The owner may send `yield` in the same read as its `peer_ack`, before
   * anyone has subscribed; like `closed`, it is remembered and delivered late.
   */
  private yielded = false;
  private stateListeners: Array<() => void> = [];
  private yieldListeners: Array<() => void> = [];
  private closeListeners: Array<() => void> = [];

  /** Dial the port holder and say hello; settles once it acks, refuses or turns out unable to relay. */
  static connect(options: UpstreamConnectOptions): Promise<UpstreamOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      // A native client: `ws` sends no Origin unless asked, and the owner insists on that.
      const socket = new WebSocket(options.url, { handshakeTimeout: options.timeoutMs, perMessageDeflate: false });
      const finish = (outcome: UpstreamOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (outcome.kind !== "ack") {
          try {
            socket.terminate();
          } catch {
            /* already gone */
          }
        }
        resolve(outcome);
      };
      const timer = setTimeout(
        () => finish({ kind: "foreign", reason: "it did not answer as a WebMate bridge" }),
        options.timeoutMs,
      );
      timer.unref?.();

      socket.on("open", () => {
        try {
          socket.send(JSON.stringify(options.hello));
        } catch {
          /* the close handler reports it */
        }
      });
      socket.on("message", (raw) => {
        if (settled) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.type === "peer_ack") finish({ kind: "ack", link: new UpstreamLink(socket, msg) });
      });
      socket.on("unexpected-response", (_request, response) => {
        finish({ kind: "foreign", reason: `it answered the WebSocket upgrade with HTTP ${response.statusCode}` });
      });
      socket.on("close", (code, reasonBuffer) => {
        const reason = reasonBuffer.toString();
        if (code === 1012) finish({ kind: "gone" });
        else if (code === 1008 && /unexpected path/i.test(reason)) finish({ kind: "legacy", reason });
        else if (code === 1008) finish({ kind: "refused", reason: reason || "refused" });
        else finish({ kind: "foreign", reason: reason || `it closed the connection (code ${code})` });
      });
      // Also keeps a late socket error from becoming an uncaught exception.
      socket.on("error", (error) => {
        if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") finish({ kind: "gone" });
        else finish({ kind: "foreign", reason: error.message });
      });
    });
  }

  private constructor(
    private readonly socket: WebSocket,
    ack: Record<string, unknown>,
  ) {
    this.owner = parseIdentity(ack);
    this.state = parseState(ack.state);
    socket.on("message", (raw) => this.handleMessage(raw.toString()));
    socket.on("close", () => this.handleClose());
  }

  /** Whether commands can go through this link now. */
  get ready(): boolean {
    return !this.closed && this.socket.readyState === WebSocket.OPEN;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  onState(listener: () => void): void {
    this.stateListeners.push(listener);
  }

  /** Called when the owner hands the port over — at once (next tick) if it already has. */
  onYield(listener: () => void): void {
    this.yieldListeners.push(listener);
    if (this.yielded) queueMicrotask(listener);
  }

  /** Called when the link closes — at once (next tick) if it already has. */
  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
    if (this.closed) queueMicrotask(listener);
  }

  send(frame: Record<string, unknown>): void {
    if (!this.ready) return;
    try {
      this.socket.send(JSON.stringify(frame));
    } catch {
      /* the close handler cleans up */
    }
  }

  close(code = 1000, reason = ""): void {
    try {
      this.socket.close(code, reason);
    } catch {
      /* already gone */
    }
  }

  /**
   * Send one command through the owner and await its answer. `waitMs` bounds
   * the whole trip: the owner applies its own connect grace and command
   * timeout, so the caller passes both plus transit time.
   */
  relay<T>(
    action: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
    target: RequestTarget,
    waitMs: number,
  ): Promise<T> {
    if (!this.ready) {
      return Promise.reject(new RelayRetryError("The bridge owner is gone; the command was not sent."));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BridgeError(
            `The bridge owner (PID ${this.owner.pid ?? "?"}) did not answer '${action}' within ${waitMs}ms.`,
            undefined,
            "COMMAND_TIMEOUT",
          ),
        );
      }, waitMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.socket.send(
          JSON.stringify({
            type: "relay",
            id,
            action,
            payload,
            timeoutMs,
            target: target.instanceId ? { instanceId: target.instanceId } : {},
          }),
        );
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new RelayRetryError(`Could not relay '${action}': ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }

  private handleMessage(data: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.type === "state") {
      this.state = parseState(msg.state);
      for (const listener of this.stateListeners) listener();
      return;
    }
    if (msg.type === "relay_result") {
      const id = typeof msg.id === "number" ? msg.id : -1;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      if (msg.ok === true) entry.resolve(msg.result);
      else entry.reject(errorFromWire(msg.error));
      return;
    }
    if (msg.type === "yield") {
      this.yielded = true;
      for (const listener of this.yieldListeners) listener();
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      // The command may already be running in the browser: say so, as a dropped extension socket would.
      entry.reject(new BridgeError("The bridge owner went away mid-command.", undefined, "COMMAND_INTERRUPTED"));
    }
    this.pending.clear();
    for (const listener of this.closeListeners) listener();
  }
}
