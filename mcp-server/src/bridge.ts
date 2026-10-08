/**
 * Bridge server — the local endpoint the branded extension connects OUT to.
 *
 * Direction matters: a Manifest V3 extension cannot listen on a socket, so
 * `src/chrome/src/offscreen/cloud-bridge.js` dials out from an offscreen
 * document and we host the listener. That also means every command below is
 * initiated by us and answered by the extension.
 *
 * Wire protocol:
 *   extension -> us   {type:'hello', client, protocolVersion, capabilities, status,
 *                      // v3 adds:
 *                      version, browser, installType, token?, signedIn, instanceId?}
 *   us -> extension   {type:'hello_ack', serverVersion, token|null, minExtensionVersion, minProtocol}
 *   extension -> us   {type:'session', signedIn}          (sign-in changed after the hello)
 *   us -> extension   {id, action, payload}
 *   extension -> us   {id, ok:true,  result}
 *                     {id, ok:false, error, status?}
 *
 * The extension spreads `payload` over the message it forwards to its own
 * background worker, so payload keys become top-level fields there. Send the
 * exact field names `cloud-runs.js` reads.
 *
 * Paired mode: when Workmate has written a pairing file (see pairing.ts) the
 * hello must speak v3 and carry the pairing token, and we echo the token back
 * so the extension can tell us apart from any other local process on the
 * port. Without the file, v2 hellos are accepted exactly as before — that is
 * the developer checkout and the store build.
 *
 * Several extensions at once (phase 4): every socket that completes a valid
 * hello is kept, keyed by `hello.instanceId` (a per-profile id; a per-socket
 * id when an older extension sends none). The person's own browser and the
 * Workmate browser window therefore attach side by side instead of knocking
 * each other off every few seconds. Commands go to the connection that owns
 * the run they name, else to the "active" one — signed in first, then the
 * most recent hello — and `webmate_connection` lists them all. A reconnect
 * from the same instance replaces only its own previous socket.
 *
 * Several copies of this server at once: the port has one owner, and every
 * other copy is a standby that relays through it (see peer.ts). `role()` says
 * which this process is; `request()` works the same either way.
 */

import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { BRAND } from "./brand.generated.js";
import { config } from "./config.js";
import { BridgeError, refusalFrom } from "./errors.js";
import { describeHolder, findPortHolder, isSupervisedWebmateServer } from "./holder.js";
import { log } from "./log.js";
import { readPairing as readPairingFile, type Pairing } from "./pairing.js";
import {
  PEER_CLIENT_ID,
  PEER_PATH,
  PEER_PROTOCOL_VERSION,
  RELAYABLE_ACTIONS,
  RelayRetryError,
  UpstreamLink,
  errorToWire,
  parseIdentity,
  sameToken,
  type PeerIdentity,
  type PeerState,
} from "./peer.js";
import {
  BRIDGE_PROTOCOL_VERSION,
  MIN_EXTENSION_VERSION,
  MIN_PAIRED_PROTOCOL_VERSION,
  SERVER_VERSION,
} from "./version.js";

export { BridgeError };

/**
 * The `client` value the extension puts in its hello frame. This is a wire
 * identifier inherited from upstream WebBrain — the brand build deliberately
 * preserves protocol tokens, so every branded build still sends exactly this
 * string. Do not "rebrand" it or every handshake is rejected.
 */
export const EXTENSION_CLIENT_ID = "webbrain-extension";

/** Actions present in the extension's ALLOWED_BRIDGE_ACTIONS set. */
export type BridgeAction =
  | "cloud_run"
  | "cloud_status"
  | "cloud_respond"
  | "cloud_abort"
  | "workmate_prepare_update"
  | "workmate_reload"
  | "auth_hint"
  | "auth_open";

export interface CloudSnapshot {
  runId: string;
  status: "running" | "needs_user_input" | "aborting" | "completed" | "failed" | "aborted";
  mode?: "ask" | "act";
  /** The permission mode the run executed at. '' when it used the browser's standing one. */
  permissionMode?: string;
  tabId?: number;
  task?: string;
  structured?: boolean;
  pendingInput?: {
    clarifyId?: string;
    clarify_id?: string;
    question?: string;
    [key: string]: unknown;
  } | null;
  result?: unknown;
  summary?: string;
  content?: string;
  finalUrl?: string;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
  updates?: unknown[];
  [key: string]: unknown;
}

/** What the attached extension said about itself in `hello`. */
export interface ExtensionInfo {
  version: string | null;
  browser: string | null;
  installType: "workmate" | "dev" | null;
  signedIn: boolean | null;
  protocolVersion: number | null;
  lastHelloAt: string | null;
  capabilities: string[];
  /** `hello.instanceId`, or the per-socket stand-in; null when nothing is attached. */
  instanceId: string | null;
}

const NO_EXTENSION: ExtensionInfo = {
  version: null,
  browser: null,
  installType: null,
  signedIn: null,
  protocolVersion: null,
  lastHelloAt: null,
  capabilities: [],
  instanceId: null,
};

/** One attached extension, as listed by `connections()` and state.json. */
export interface ConnectionSummary extends ExtensionInfo {
  instanceId: string;
  paired: boolean;
  /** The connection commands go to when nothing names one. */
  active: boolean;
  acceptedAt: string;
}

/** Everything state.json needs, read after any `onChange` notification. */
export interface BridgeSnapshot extends ExtensionInfo {
  listening: boolean;
  connected: boolean;
  pairingRequired: boolean;
  error: string | null;
  connections: ConnectionSummary[];
}

/**
 * Where this process stands on the bridge port. `owner` holds it and talks to
 * the extension; `standby` relays through the owner or waits for the port;
 * `idle` has not started, or has stopped.
 */
export type BridgeRole = "idle" | "owner" | "standby";

/** How a command from this process reaches the browser right now. */
export type BridgeRoute =
  | { kind: "direct" }
  | { kind: "relay"; owner: PeerIdentity }
  | { kind: "none"; reason: string | null };

export const TERMINAL_STATUSES = new Set(["completed", "failed", "aborted"]);

interface Connection {
  key: string;
  socket: WebSocket;
  info: ExtensionInfo;
  paired: boolean;
  acceptedAt: number;
  missedPongs: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  connection: Connection;
}

/** Another copy of this server, relaying through this one. */
interface Peer {
  socket: WebSocket;
  identity: PeerIdentity;
}

/** This owner handing the port to a peer that outranks it. */
interface Handoff {
  peer: Peer;
  /** `preparing`: the host winds down; `yielded`: the listener is closed and the peer is binding. */
  phase: "preparing" | "yielded";
  timer: NodeJS.Timeout | null;
}

/** Where a command goes; see `request()`. */
export interface RequestTarget {
  /** A specific attached extension (`ConnectionSummary.instanceId`). */
  instanceId?: string;
  /**
   * Let the call wait longer than `commandTimeoutMs`. Only for actions the
   * extension is known to answer slowly on purpose (a silent sign-in).
   */
  unclamped?: boolean;
}

/**
 * The bridge port was already taken by something that is not a bridge. Kept
 * for callers of earlier releases: start() no longer throws it, because a
 * copy that cannot bind now waits as a standby instead (see peer.ts).
 */
export class PortInUseError extends Error {
  readonly port: number;
  constructor(port: number) {
    super(`Port ${port} is already in use.`);
    this.name = "PortInUseError";
    this.port = port;
  }
}

/**
 * The message the agent relays when the port is held by something this copy
 * cannot relay through. Written to be acted on without further investigation:
 * it names the likely cause, explains why the browser still claims to be
 * connected, and gives both ways out.
 */
export async function describePortConflict(port: number): Promise<string> {
  const holder = describeHolder(await findPortHolder(port));
  return (
    `Port ${port} is already in use${holder ? ` by ${holder}` : ""}, so the ` +
    `${BRAND.extensionName} bridge could not start. Every tool here is unavailable ` +
    "until that is resolved.\n\n" +
    "This is almost always an older MCP server left running by a previous session " +
    "(a crashed or force-quit host does not always reap it). The extension is " +
    `attached to THAT process, which is why ${BRAND.productName} still shows ` +
    '"Connected" in the browser while these tools cannot reach it.\n\n' +
    `To fix: quit ${holder ?? "the process holding the port"}, then start a new ` +
    "session. Alternatively, point both sides at a free port by setting " +
    `${BRAND.envPrefix}BRIDGE_PORT and updating the extension's Cloud bridge URL.`
  );
}

/** The holder is a WebMate server from before the peer protocol: it can neither relay nor hand over. */
async function describeOutdatedHolder(port: number): Promise<string> {
  const holder = describeHolder(await findPortHolder(port));
  return (
    `Port ${port} is held by an older ${BRAND.productName} server${holder ? ` (${holder})` : ""} ` +
    "that cannot share the browser bridge with this one, so every tool here is unavailable " +
    "until it exits. The extension is attached to that process, which is why the browser " +
    'still shows "Connected".\n\n' +
    "Restarting the AgentX app or gateway that started it brings it up to date. This server " +
    "takes the port over by itself as soon as it is free."
  );
}

/** Without a Workmate pairing, copies of this server cannot relay: the port is first come, first served. */
async function describeUnpairedHolder(port: number): Promise<string> {
  const holder = describeHolder(await findPortHolder(port));
  return (
    `Port ${port} is already in use${holder ? ` by ${holder}` : ""} — most likely another copy ` +
    `of this server, which keeps the ${BRAND.extensionName} until it exits. Without a Workmate ` +
    "pairing (pairing.json) copies cannot share the bridge, so every tool here is unavailable " +
    "until then; this server takes the port over by itself as soon as it is free.\n\n" +
    `Alternatively, point both sides at a free port by setting ${BRAND.envPrefix}BRIDGE_PORT and ` +
    "updating the extension's Cloud bridge URL."
  );
}

/** The holder speaks the peer protocol but would not carry this copy's commands. */
async function describeRefusingHolder(port: number, reason: string): Promise<string> {
  const holder = describeHolder(await findPortHolder(port));
  return (
    `Port ${port} is held by another ${BRAND.productName} server${holder ? ` (${holder})` : ""} ` +
    `that refused to relay for this one: ${reason}. Every tool here is unavailable until it exits; ` +
    "this server takes the port over by itself as soon as it is free."
  );
}

function isAllowedBridgeOrigin(origin: string | string[] | undefined): boolean {
  if (origin == null) return true;
  if (Array.isArray(origin)) return false;
  try {
    const protocol = new URL(origin).protocol;
    return protocol === "chrome-extension:" || protocol === "moz-extension:";
  } catch {
    return false;
  }
}

/** Human-readable instructions for attaching the extension, reused in every "not connected" message. */
export function connectInstructions(): string {
  return (
    `Open the browser, then set ${BRAND.productName} → Settings → General → Advanced → ` +
    `Cloud bridge to ws://127.0.0.1:${config.bridgePort}${config.bridgePath} and enable it.`
  );
}

/** Same message for a Workmate-managed install, where Settings is not the fix. */
export function pairedConnectInstructions(): string {
  return (
    `Open the browser ${BRAND.productName} was installed into (Workmate → Settings → Browser ` +
    "shows which). If chrome://extensions lists it as switched off, switch it back on; " +
    "the extension reconnects on its own within a few seconds."
  );
}

/** Whether Workmate has unpacked the extension folder on this machine. */
export function extensionFolderPresent(installDir: string = config.installDir): boolean {
  return existsSync(path.join(installDir, "manifest.json"));
}

/** A connection must say hello within this long or it is dropped (attached ones are untouched). */
const CANDIDATE_HELLO_TIMEOUT_MS = 10_000;

/** Run ids learned from replies, so a later status/respond/abort goes back to the same browser. */
const MAX_REMEMBERED_RUNS = 500;

/** How long a standby waits for the port holder to answer its hello. Loopback: a live owner answers in milliseconds. */
const PEER_CONNECT_TIMEOUT_MS = 3_000;

/** A standby handed the port retries the bind this often, this many times, while the old owner's listener closes. */
const YIELD_BIND_ATTEMPTS = 20;
const YIELD_BIND_INTERVAL_MS = 100;

/** An outdated holder is asked to exit at most this many times per process (it is normally restarted once). */
const MAX_RETIREMENTS = 3;

/** Browsers only honour a few close codes from a server; 1012 (service restart) makes the extension redial at once. */
const MOVED_CLOSE_CODE = 1012;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function safeClose(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason.slice(0, 120));
  } catch {
    /* already gone */
  }
}

function sendJson(socket: WebSocket, frame: unknown): void {
  if (socket.readyState !== 1) return;
  try {
    socket.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  } catch {
    /* the close handler cleans up */
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Settle when `promise` does or after `ms`, whichever is first; never rejects. */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  await Promise.race([
    promise.catch((error) => {
      log("pre-handoff wind-down failed:", error instanceof Error ? error.message : String(error));
    }),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

export interface BridgeOptions {
  /** Injected for tests; defaults to reading config.pairingFile. */
  readPairing?: () => Promise<Pairing | null>;
  installDir?: string;
  /**
   * Called when this owner is about to hand the port to a copy that outranks
   * it. Resolve once host-side work that must finish here (Workmate commands
   * already picked up) has wound down; bounded by config.handoffDrainMs.
   */
  beforeHandoff?: () => Promise<void>;
  /** Claim on the port (see config.bridgePriority); defaults to the configured one. */
  priority?: number;
  /** The AgentX host named in logs and to peers (see config.bridgeHost). */
  host?: string | null;
}

/**
 * The connection commands go to when nothing names one: a signed-in
 * extension beats one nobody is signed in to (a run there would only fail
 * with "no model"), and among equals the most recent hello wins — the
 * browser the person just opened or reloaded. Connections arrive in the
 * order they were accepted, so two hellos within the same millisecond go to
 * the later one.
 */
export function pickActive(connections: Iterable<Connection>): Connection | null {
  let best: Connection | null = null;
  for (const candidate of connections) {
    if (!best) {
      best = candidate;
      continue;
    }
    const bestSigned = best.info.signedIn === true ? 1 : 0;
    const candidateSigned = candidate.info.signedIn === true ? 1 : 0;
    if (candidateSigned > bestSigned) best = candidate;
    else if (candidateSigned === bestSigned && candidate.acceptedAt >= best.acceptedAt) best = candidate;
  }
  return best;
}

export class WebMateBridge {
  private currentRole: BridgeRole = "idle";
  private roleListeners: Array<(role: BridgeRole) => void> = [];

  // Owner: the listening socket and everything attached to it.
  private server: http.Server | null = null;
  private readonly wss = new WebSocketServer({ noServer: true, clientTracking: false });
  /** Every socket whose hello was accepted, by socket. */
  private attached = new Map<WebSocket, Connection>();
  /** The same connections by instance key, for `request({ instanceId })` and reconnects. */
  private byKey = new Map<string, Connection>();
  /** Sockets that have connected but not yet said a valid hello. */
  private candidates = new Set<WebSocket>();
  private peers = new Set<Peer>();
  private peerCandidates = new Set<WebSocket>();
  private handoff: Handoff | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private anonymousSeq = 0;
  private runOwners = new Map<string, string>();
  private heartbeat: NodeJS.Timeout | null = null;
  private lastError: string | null = null;
  private pairingRequired = false;

  // Standby: the link to the owner, or why there is none.
  private upstream: UpstreamLink | null = null;
  private standbyReason: string | null = null;
  private lastLoggedStandby: string | null = null;
  private claiming = false;
  /** An outdated holder was asked to exit; the port should free up for the next claim. */
  private retiring = false;
  private claimTimer: NodeJS.Timeout | null = null;
  private acceptingYield = false;
  private failedYields = 0;
  private retiredHolders = new Set<number>();

  private waiters = new Set<() => void>();
  private listeners: Array<() => void> = [];
  private readonly readPairing: () => Promise<Pairing | null>;
  private readonly installDir: string;
  private readonly beforeHandoff: () => Promise<void>;
  private readonly priority: number;
  private readonly host: string | null;

  constructor(options: BridgeOptions = {}) {
    this.readPairing =
      options.readPairing ??
      (async () => (config.pairingFile ? readPairingFile(config.pairingFile) : null));
    this.installDir = options.installDir ?? config.installDir;
    this.beforeHandoff = options.beforeHandoff ?? (async () => {});
    this.priority = options.priority ?? config.bridgePriority;
    this.host = options.host === undefined ? config.bridgeHost : options.host;
  }

  /** Subscribe to state changes (listen, connect, handshake, disconnect, errors, role). */
  onChange(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener);
    };
  }

  /**
   * Subscribe to role changes. Fires again with `owner` when a handoff is
   * called off, so a host that paused work for it (beforeHandoff) resumes.
   */
  onRoleChange(listener: (role: BridgeRole) => void): () => void {
    this.roleListeners.push(listener);
    return () => {
      this.roleListeners = this.roleListeners.filter((entry) => entry !== listener);
    };
  }

  role(): BridgeRole {
    return this.currentRole;
  }

  /** How a command from this process reaches the browser right now. */
  route(): BridgeRoute {
    if (this.currentRole === "owner") return { kind: "direct" };
    if (this.upstream?.ready) return { kind: "relay", owner: this.upstream.owner };
    return { kind: "none", reason: this.standbyReason };
  }

  /**
   * Whether this process should write state.json: it holds the port and is
   * not in the middle of handing it over (the next owner writes from then on).
   */
  publishesState(): boolean {
    return this.currentRole === "owner" && this.handoff?.phase !== "yielded";
  }

  private setRole(role: BridgeRole, announce = false): void {
    if (this.currentRole === role && !announce) return;
    this.currentRole = role;
    for (const listener of this.roleListeners) {
      try {
        listener(role);
      } catch (error) {
        log("role listener failed:", error instanceof Error ? error.message : String(error));
      }
    }
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        log("state listener failed:", error instanceof Error ? error.message : String(error));
      }
    }
    if (this.currentRole === "owner" && this.peers.size) {
      const frame = JSON.stringify({ type: "state", state: this.peerState() });
      for (const peer of this.peers) sendJson(peer.socket, frame);
    }
    for (const check of [...this.waiters]) check();
  }

  /** The connection commands default to, or null. */
  private active(): Connection | null {
    if (this.currentRole !== "owner") return null;
    return pickActive(this.attached.values());
  }

  private summarize(connection: Connection, active: Connection | null): ConnectionSummary {
    return {
      ...connection.info,
      capabilities: [...connection.info.capabilities],
      instanceId: connection.key,
      paired: connection.paired,
      active: connection === active,
      acceptedAt: new Date(connection.acceptedAt).toISOString(),
    };
  }

  /** The copies relaying through this owner (empty on a standby). */
  standbys(): PeerIdentity[] {
    if (this.currentRole !== "owner") return [];
    return [...this.peers].map((peer) => ({ ...peer.identity }));
  }

  /** The owner's state as relayed to this standby, or null when not relaying. */
  private relayedState(): PeerState | null {
    return this.currentRole === "standby" && this.upstream?.ready ? this.upstream.state : null;
  }

  /** Every attached extension, the active one first (the owner's list, on a standby). */
  connections(): ConnectionSummary[] {
    if (this.currentRole !== "owner") {
      return (this.relayedState()?.connections ?? []).map((c) => ({ ...c, capabilities: [...c.capabilities] }));
    }
    const active = this.active();
    return [...this.attached.values()]
      .map((connection) => this.summarize(connection, active))
      .sort((a, b) => Number(b.active) - Number(a.active) || b.acceptedAt.localeCompare(a.acceptedAt));
  }

  /** What state.json publishes. */
  snapshot(): BridgeSnapshot {
    return {
      ...this.info(),
      listening: this.server !== null,
      connected: this.isConnected(),
      pairingRequired: this.isPaired(),
      error: this.currentRole === "owner" ? this.lastError : (this.unavailable() ?? this.relayedState()?.error ?? null),
      connections: this.connections(),
    };
  }

  /** Facts from the active extension's hello (empty when nothing is attached). */
  info(): ExtensionInfo {
    if (this.currentRole !== "owner") {
      const relayed = this.relayedState();
      return relayed ? { ...relayed.info, capabilities: [...relayed.info.capabilities] } : { ...NO_EXTENSION, capabilities: [] };
    }
    const active = this.active();
    if (!active) return { ...NO_EXTENSION, capabilities: [] };
    return { ...active.info, capabilities: [...active.info.capabilities], instanceId: active.key };
  }

  private peerState(): PeerState {
    return {
      connected: this.isConnected(),
      pairingRequired: this.pairingRequired,
      info: this.info(),
      connections: this.connections(),
      error: this.lastError,
    };
  }

  /**
   * Record that this bridge will never attach, and why: every command then
   * fails fast with this explanation instead of waiting out a connect grace.
   * A bridge that owns the port ignores it.
   */
  markUnavailable(reason: string): void {
    if (this.currentRole === "owner") return;
    if (this.currentRole === "idle") this.currentRole = "standby";
    this.standbyReason = reason;
    this.changed();
  }

  /** Why no command can reach a browser from here — neither owning the port nor relaying — or null. */
  unavailable(): string | null {
    if (this.currentRole === "owner" || this.upstream?.ready) return null;
    return this.standbyReason;
  }

  /**
   * No route now and none on the way: a standby that neither relays nor is
   * in the middle of trying. Commands fail at once with the reason instead of
   * waiting out a grace period for a browser that cannot reach this process.
   */
  private hopeless(): boolean {
    return (
      this.currentRole === "standby" &&
      this.standbyReason !== null &&
      !this.upstream &&
      !this.claiming &&
      !this.retiring &&
      !this.acceptingYield
    );
  }

  /** Bind the port and become the owner, or join whoever holds it as a standby. */
  async start(): Promise<void> {
    if (this.currentRole !== "idle") return;
    this.currentRole = "standby";
    this.standbyReason = null;
    await this.claim();
  }

  /**
   * Open the listener. False when the port is taken; throws on any other
   * failure. The http server is our own so that closing it (a handoff) frees
   * the port while every open socket stays up.
   */
  private listen(): Promise<boolean> {
    if (this.server) return Promise.resolve(true);
    return new Promise<boolean>((resolve, reject) => {
      const server = http.createServer((_request, response) => {
        response.writeHead(426, { "Content-Type": "text/plain" });
        response.end("WebSocket upgrade required\n");
      });
      server.on("upgrade", (request, socket, head) => {
        this.wss.handleUpgrade(request, socket, head, (ws) => this.handleConnection(ws, request));
      });
      const onError = (error: NodeJS.ErrnoException) => {
        server.removeListener("listening", onListening);
        if (error.code === "EADDRINUSE") resolve(false);
        else reject(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        server.on("error", (error) => log("listener error:", error.message));
        this.server = server;
        resolve(true);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      // Bind to loopback explicitly. Never expose this listener to the network:
      // anything that can reach it can drive the user's logged-in browser.
      server.listen(config.bridgePort, "127.0.0.1");
    });
  }

  /** Stop accepting connections. The port is free at once; open sockets live on. */
  private closeListener(): void {
    const server = this.server;
    if (!server) return;
    this.server = null;
    server.close();
  }

  private handleConnection(socket: WebSocket, request: http.IncomingMessage): void {
    const url = request.url || "";
    const origin = request.headers.origin;
    if (url.split("?")[0] === PEER_PATH) {
      // Peers are other copies of this server. Native clients send no Origin,
      // and a browser page always does — so no web page reaches this socket.
      if (origin !== undefined) {
        log(`rejected a peer connection that sent Origin ${String(origin)}`);
        safeClose(socket, 1008, "Untrusted Origin");
        return;
      }
      this.adoptPeerCandidate(socket);
      return;
    }
    // Browser WebSocket clients always send Origin. Only extension pages may
    // reach this trusted-local command channel; native clients send none.
    if (!isAllowedBridgeOrigin(origin)) {
      log(`rejected WebSocket origin: ${String(origin)}`);
      safeClose(socket, 1008, "Untrusted Origin");
      return;
    }
    if (!url.startsWith(config.bridgePath)) {
      log(`rejected connection on unexpected path: ${url}`);
      safeClose(socket, 1008, "Unexpected path");
      return;
    }

    // Nothing is trusted before its hello passes: a connection earns its
    // place, and attached extensions are untouched by whatever it turns
    // out to be (see `candidates`).
    this.adoptCandidate(socket);
  }

  // ── Claiming the port (standby) ────────────────────────────────────────

  private scheduleClaim(delayMs: number): void {
    if (this.currentRole !== "standby") return;
    if (this.claimTimer) clearTimeout(this.claimTimer);
    this.claimTimer = setTimeout(() => {
      this.claimTimer = null;
      void this.claim();
    }, Math.max(0, delayMs));
    this.claimTimer.unref?.();
  }

  /** When the port frees up, a copy that outranks the rest binds first; the others give it a moment. */
  private reclaimDelay(): number {
    return this.priority > 0 ? 0 : 150 + Math.floor(Math.random() * 250);
  }

  private setStandbyReason(reason: string): void {
    this.standbyReason = reason;
    if (reason !== this.lastLoggedStandby) {
      this.lastLoggedStandby = reason;
      log(`standby: ${reason.split("\n")[0]}`);
    }
  }

  /**
   * One attempt at a route: bind the port, else relay through whoever holds
   * it, else remember why neither works and try again later.
   */
  private async claim(): Promise<void> {
    if (this.currentRole !== "standby" || this.claiming || this.upstream || this.acceptingYield) return;
    this.claiming = true;
    if (this.claimTimer) {
      clearTimeout(this.claimTimer);
      this.claimTimer = null;
    }
    let retryIn: number | null = null;
    let retired = false;
    try {
      if (await this.listen()) {
        if (this.currentRole !== "standby") {
          this.closeListener(); // stopped while binding
          return;
        }
        await this.becomeOwner();
        return;
      }
      let pairing: Pairing | null = null;
      try {
        pairing = await this.readPairing();
      } catch {
        pairing = null;
      }
      if (!pairing) {
        this.setStandbyReason(await describeUnpairedHolder(config.bridgePort));
        retryIn = config.bindRetryMs;
        return;
      }
      const outcome = await UpstreamLink.connect({
        url: `ws://127.0.0.1:${config.bridgePort}${PEER_PATH}`,
        hello: this.peerHello(pairing),
        timeoutMs: PEER_CONNECT_TIMEOUT_MS,
      });
      if (this.currentRole !== "standby") {
        if (outcome.kind === "ack") outcome.link.close(1000, "No longer needed");
        return;
      }
      if (outcome.kind === "ack") {
        this.adoptUpstream(outcome.link);
        return;
      }
      if (outcome.kind === "gone") {
        // The owner left between our bind and our dial, or is handing the port on.
        retryIn = this.reclaimDelay();
        return;
      }
      retryIn = config.bindRetryMs;
      if (outcome.kind === "legacy") {
        this.setStandbyReason(await describeOutdatedHolder(config.bridgePort));
        if (await this.retireOutdatedHolder()) {
          retired = true;
          retryIn = 500;
        }
      } else if (outcome.kind === "refused") {
        this.setStandbyReason(await describeRefusingHolder(config.bridgePort, outcome.reason));
      } else {
        this.setStandbyReason(await describePortConflict(config.bridgePort));
      }
    } catch (error) {
      this.setStandbyReason(
        `The ${BRAND.extensionName} bridge could not open port ${config.bridgePort}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      retryIn = config.bindRetryMs;
    } finally {
      this.claiming = false;
      // Until the next attempt, a command waits for the port instead of failing.
      this.retiring = retired;
      if (retryIn !== null) this.scheduleClaim(retryIn);
      this.changed();
    }
  }

  private peerHello(pairing: Pairing): Record<string, unknown> {
    return {
      type: "peer_hello",
      client: PEER_CLIENT_ID,
      peerProtocol: PEER_PROTOCOL_VERSION,
      serverVersion: SERVER_VERSION,
      pid: process.pid,
      host: this.host,
      priority: this.priority,
      token: pairing.token,
    };
  }

  private adoptUpstream(link: UpstreamLink): void {
    this.upstream = link;
    this.standbyReason = null;
    this.lastLoggedStandby = null;
    const owner = link.owner;
    log(
      `standby: relaying through the bridge owner, PID ${owner.pid ?? "?"}` +
        `${owner.host ? ` (${owner.host})` : ""}, priority ${owner.priority} ` +
        `(this copy: ${this.priority})`,
    );
    link.onState(() => {
      if (this.upstream === link) this.changed();
    });
    link.onYield(() => void this.acceptYield(link));
    link.onClose(() => {
      if (this.upstream !== link) return;
      this.upstream = null;
      if (this.currentRole === "standby") {
        log("standby: the bridge owner went away; claiming the port");
        this.scheduleClaim(this.reclaimDelay());
      }
      this.changed();
    });
    this.changed();
  }

  /** The owner is handing the port over: bind it, then tell the owner so it lets go of the extension. */
  private async acceptYield(link: UpstreamLink): Promise<void> {
    if (this.currentRole !== "standby" || this.acceptingYield) return;
    this.acceptingYield = true;
    log(`PID ${link.owner.pid ?? "?"} is handing the bridge port over`);
    try {
      for (let attempt = 0; attempt < YIELD_BIND_ATTEMPTS; attempt++) {
        if (this.currentRole !== "standby") return;
        let bound = false;
        try {
          bound = await this.listen();
        } catch (error) {
          log("could not bind the handed-over port:", error instanceof Error ? error.message : String(error));
        }
        if (bound && this.currentRole !== "standby") {
          this.closeListener(); // stopped while binding
          return;
        }
        if (bound) {
          link.send({ type: "bound" });
          // Commands already relayed finish over the link while the old owner
          // drains; new ones go direct from here on.
          if (this.upstream === link) this.upstream = null;
          this.failedYields = 0;
          await this.becomeOwner();
          return;
        }
        await sleep(YIELD_BIND_INTERVAL_MS);
      }
      link.send({ type: "bind_failed" });
      this.failedYields += 1;
      log("was handed the bridge port but could not bind it; asking again shortly");
      // Hang up and dial again: a fresh hello makes the owner (whoever that is by then) try once more.
      if (this.upstream === link) this.upstream = null;
      link.close(1000, "Could not bind");
      this.scheduleClaim(Math.min(30_000, 1_000 * 2 ** Math.min(this.failedYields, 5)));
    } finally {
      this.acceptingYield = false;
      this.changed();
    }
  }

  private async becomeOwner(): Promise<void> {
    this.standbyReason = null;
    this.lastLoggedStandby = null;
    if (this.claimTimer) {
      clearTimeout(this.claimTimer);
      this.claimTimer = null;
    }
    // The owner role first: a hello can arrive the moment the port is bound.
    this.setRole("owner");
    this.startHeartbeat();
    // Learn the pairing mode up front so state.json and the "not connected"
    // wording are right before the first hello arrives.
    try {
      this.pairingRequired = (await this.readPairing()) !== null;
    } catch (error) {
      this.pairingRequired = true;
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    if (this.currentRole !== "owner") return;
    log(
      `listening on ws://127.0.0.1:${config.bridgePort}${config.bridgePath}` +
        (this.pairingRequired ? " (Workmate pairing required)" : "") +
        ` — bridge owner, priority ${this.priority}`,
    );
    this.changed();
  }

  /**
   * Ask an older copy of this server to exit so the port can change hands.
   *
   * Only for the transition to the peer protocol: a server from before it can
   * neither relay nor hand over, so without this a gateway started before an
   * update would keep the browser from the desktop app until it restarted.
   * Narrow on purpose — this copy must outrank every other host (the desktop
   * app's), and the holder must be this server's own bundle or build running
   * under AgentX's stdio watchdog, whose host starts it again right away from
   * the bundle now on disk. Each PID is asked once, and a process at most
   * MAX_RETIREMENTS times. POSIX only; nothing else is ever signalled.
   */
  private async retireOutdatedHolder(): Promise<boolean> {
    if (this.priority <= 0 || this.retiredHolders.size >= MAX_RETIREMENTS) return false;
    const holder = await findPortHolder(config.bridgePort);
    if (!holder || holder.pid === process.pid || this.retiredHolders.has(holder.pid)) return false;
    if (!(await isSupervisedWebmateServer(holder.pid))) return false;
    this.retiredHolders.add(holder.pid);
    log(
      `asking PID ${holder.pid} to exit: an older ${BRAND.productName} server that cannot share the ` +
        "bridge port. The AgentX process that started it starts it again from the current bundle.",
    );
    try {
      process.kill(holder.pid, "SIGTERM");
      return true;
    } catch (error) {
      log(`could not signal PID ${holder.pid}:`, error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  // ── Serving peers (owner) ──────────────────────────────────────────────

  /** Park a peer connection until its hello, as `adoptCandidate` does for extensions. */
  private adoptPeerCandidate(socket: WebSocket): void {
    this.peerCandidates.add(socket);
    const timer = setTimeout(() => {
      if (!this.peerCandidates.has(socket)) return;
      this.peerCandidates.delete(socket);
      safeClose(socket, 1008, "No hello");
    }, CANDIDATE_HELLO_TIMEOUT_MS);
    timer.unref?.();

    socket.on("message", (raw) => {
      if (!this.peerCandidates.has(socket)) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type !== "peer_hello") return;
      clearTimeout(timer);
      void this.handlePeerHello(socket, msg);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      this.peerCandidates.delete(socket);
    });
    socket.on("error", (error) => {
      log("peer socket error:", error instanceof Error ? error.message : String(error));
    });
  }

  private async handlePeerHello(socket: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const verdict = await this.checkPeerHello(msg);
    if (!this.peerCandidates.has(socket) || socket.readyState !== 1) return;
    this.peerCandidates.delete(socket);
    if (!verdict.ok) {
      log(`refusing a peer: ${verdict.reason}`);
      safeClose(socket, 1008, verdict.reason);
      return;
    }
    if (this.currentRole !== "owner") {
      safeClose(socket, MOVED_CLOSE_CODE, "The bridge moved to another server");
      return;
    }

    const peer: Peer = { socket, identity: verdict.identity };
    this.peers.add(peer);
    socket.on("message", (raw) => this.handlePeerMessage(peer, raw.toString()));
    socket.on("close", () => this.handlePeerClosed(peer));
    sendJson(socket, {
      type: "peer_ack",
      peerProtocol: PEER_PROTOCOL_VERSION,
      serverVersion: SERVER_VERSION,
      pid: process.pid,
      host: this.host,
      priority: this.priority,
      state: this.peerState(),
    });
    const { pid, host, priority } = peer.identity;
    log(
      `peer attached: PID ${pid ?? "?"}${host ? ` (${host})` : ""}, priority ${priority}; ` +
        `${this.peers.size} relaying through this bridge`,
    );
    this.changed();
    if (priority > this.priority) void this.beginHandoff(peer);
  }

  /** A peer must present this machine's pairing token; without a pairing nothing relays. */
  private async checkPeerHello(
    msg: Record<string, unknown>,
  ): Promise<{ ok: true; identity: PeerIdentity } | { ok: false; reason: string }> {
    if (msg.client !== PEER_CLIENT_ID) return { ok: false, reason: `Unknown peer client ${String(msg.client)}` };
    if (typeof msg.peerProtocol !== "number" || msg.peerProtocol < 1) {
      return { ok: false, reason: "Unsupported peer protocol" };
    }
    let pairing: Pairing | null;
    try {
      pairing = await this.readPairing();
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    if (!pairing) return { ok: false, reason: "No Workmate pairing: copies of this server cannot relay" };
    if (!sameToken(msg.token, pairing.token)) return { ok: false, reason: "Pairing token mismatch" };
    return { ok: true, identity: parseIdentity(msg) };
  }

  private handlePeerMessage(peer: Peer, data: string): void {
    if (!this.peers.has(peer)) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.type === "relay") {
      void this.handleRelay(peer, msg);
      return;
    }
    if (msg.type === "bound") {
      if (this.handoff?.peer === peer) void this.completeHandoff();
      return;
    }
    if (msg.type === "bind_failed") {
      if (this.handoff?.peer === peer) void this.abortHandoff("the new owner could not bind the port");
    }
  }

  /** Run a standby's command as if it were our own, and send back the outcome. */
  private async handleRelay(peer: Peer, msg: Record<string, unknown>): Promise<void> {
    const id = typeof msg.id === "number" ? msg.id : null;
    if (id === null) return;
    const reply = (frame: Record<string, unknown>) => sendJson(peer.socket, { type: "relay_result", id, ...frame });
    const action = typeof msg.action === "string" ? msg.action : "";
    if (!RELAYABLE_ACTIONS.has(action)) {
      reply({ ok: false, error: { message: `'${action}' cannot be relayed between bridge servers.` } });
      return;
    }
    if (this.currentRole !== "owner") {
      // Handing the port over: nothing was sent, so the standby resends once it has re-homed.
      reply({ ok: false, error: { message: "The bridge is moving to another server.", retry: true } });
      return;
    }
    const payload = isRecord(msg.payload) ? msg.payload : {};
    const timeoutMs =
      typeof msg.timeoutMs === "number" && Number.isFinite(msg.timeoutMs) && msg.timeoutMs > 0
        ? msg.timeoutMs
        : config.commandTimeoutMs;
    const target: RequestTarget =
      isRecord(msg.target) && typeof msg.target.instanceId === "string" && msg.target.instanceId
        ? { instanceId: msg.target.instanceId }
        : {};
    try {
      const result = await this.request(action as BridgeAction, payload, timeoutMs, target);
      reply({ ok: true, result });
    } catch (error) {
      reply({ ok: false, error: errorToWire(error) });
    }
  }

  private handlePeerClosed(peer: Peer): void {
    if (!this.peers.delete(peer)) return;
    const { pid, host } = peer.identity;
    log(`peer detached: PID ${pid ?? "?"}${host ? ` (${host})` : ""}; ${this.peers.size} relaying through this bridge`);
    if (this.handoff?.peer === peer) void this.abortHandoff("the new owner went away");
    this.changed();
  }

  // ── Handing the port over (owner → standby) ────────────────────────────

  /**
   * Give the port to a peer that outranks this copy.
   *
   * The order keeps the browser attached throughout: the host first winds
   * down (Workmate commands this copy already picked up finish and are
   * recorded here), then the listener closes — freeing the port while every
   * open socket stays up — and the peer is told to bind. Only once it
   * confirms does this copy let the in-flight commands finish and release
   * the extension, which redials at once and lands on the new owner. If the
   * peer never confirms, this copy takes the port back.
   */
  private async beginHandoff(peer: Peer): Promise<void> {
    if (this.currentRole !== "owner" || this.handoff) return;
    const handoff: Handoff = { peer, phase: "preparing", timer: null };
    this.handoff = handoff;
    const { pid, host, priority } = peer.identity;
    log(
      `handing the bridge to PID ${pid ?? "?"}${host ? ` (${host})` : ""}, which outranks this copy ` +
        `(priority ${priority} > ${this.priority})`,
    );
    await settleWithin(this.beforeHandoff(), config.handoffDrainMs);
    if (this.handoff !== handoff) return;
    if (this.currentRole !== "owner" || !this.peers.has(peer)) {
      void this.abortHandoff("the new owner went away");
      return;
    }
    this.closeListener();
    handoff.phase = "yielded";
    sendJson(peer.socket, { type: "yield" });
    handoff.timer = setTimeout(() => void this.abortHandoff("the new owner did not confirm in time"), config.handoffTimeoutMs);
    handoff.timer.unref?.();
  }

  private async completeHandoff(): Promise<void> {
    const handoff = this.handoff;
    if (!handoff || handoff.phase !== "yielded") return;
    this.handoff = null;
    if (handoff.timer) clearTimeout(handoff.timer);
    log(`PID ${handoff.peer.identity.pid ?? "?"} holds the bridge port now; handing the extension over`);
    await this.stepDown();
  }

  private async abortHandoff(reason: string): Promise<void> {
    const handoff = this.handoff;
    if (!handoff) return;
    this.handoff = null;
    if (handoff.timer) clearTimeout(handoff.timer);
    if (this.currentRole !== "owner") return;
    if (handoff.phase === "preparing") {
      log(`handoff called off: ${reason}`);
      this.setRole("owner", true);
      return;
    }
    // The listener is closed and nobody took the port as agreed: take it back
    // so the extension, still attached here, is not stranded.
    let relistened = false;
    try {
      relistened = await this.listen();
    } catch (error) {
      log("could not reopen the bridge port:", error instanceof Error ? error.message : String(error));
    }
    if (this.currentRole !== "owner") {
      if (relistened) this.closeListener(); // stopped meanwhile
      return;
    }
    if (relistened) {
      log(`handoff called off (${reason}); keeping the bridge`);
      this.setRole("owner", true);
      this.changed();
      return;
    }
    log(`handoff called off (${reason}), and another process took the port meanwhile`);
    await this.stepDown();
  }

  /**
   * Stop being the owner: let in-flight commands finish on the still-attached
   * extension, then release everything so the extension and the peers find
   * the new owner, and join it as a standby.
   */
  private async stepDown(): Promise<void> {
    if (this.currentRole !== "owner") return;
    // From here our own new commands wait for the relay route, and relays sent
    // to us are bounced for a resend.
    this.setRole("standby");
    this.changed();
    const deadline = Date.now() + config.handoffDrainMs;
    while (this.pending.size > 0 && Date.now() < deadline) await sleep(25);
    this.closeListener();
    this.stopHeartbeat();
    this.releaseAll(MOVED_CLOSE_CODE, "The bridge moved to another server");
    this.changed();
    this.scheduleClaim(0);
  }

  /** Close every extension, candidate and peer socket and forget them. */
  private releaseAll(code: number, reason: string): void {
    this.failAllPending(
      new BridgeError(`${BRAND.extensionName} moved to another bridge server mid-command.`, undefined, "COMMAND_INTERRUPTED"),
    );
    for (const socket of this.candidates) safeClose(socket, code, reason);
    this.candidates.clear();
    for (const connection of this.attached.values()) safeClose(connection.socket, code, reason);
    this.attached.clear();
    this.byKey.clear();
    this.runOwners.clear();
    for (const socket of this.peerCandidates) safeClose(socket, code, reason);
    this.peerCandidates.clear();
    const peers = [...this.peers];
    this.peers.clear();
    for (const peer of peers) safeClose(peer.socket, code, reason);
  }

  // ── Extensions (owner) ─────────────────────────────────────────────────

  /**
   * Ping every attached extension and hang up on one that stops answering.
   *
   * Without this, a browser that vanishes without closing its TCP connection
   * (killed process, crashed renderer, suspended VM) leaves `isConnected()`
   * returning true and every command failing on the 30s command timeout
   * instead of the honest "no extension is connected".
   *
   * Pongs come from the browser's own WebSocket stack, so this proves the
   * socket is alive — not that the offscreen document's JavaScript is healthy.
   * The command timeout remains the check for that.
   */
  private startHeartbeat(): void {
    if (this.heartbeat || config.heartbeatIntervalMs <= 0) return;
    this.heartbeat = setInterval(() => {
      for (const connection of [...this.attached.values()]) {
        const socket = connection.socket;
        if (socket.readyState !== 1) continue;
        if (connection.missedPongs >= 2) {
          log(`${connection.info.browser ?? "an extension"} missed two heartbeats — dropping the socket`);
          connection.missedPongs = 0;
          try {
            socket.terminate();
          } catch {
            /* already gone */
          }
          continue;
        }
        connection.missedPongs += 1;
        try {
          socket.ping();
        } catch {
          /* the close handler will clean up */
        }
      }
    }, config.heartbeatIntervalMs);
    // Never hold the process open on the heartbeat alone: an MCP host stops
    // this server by closing stdin, and an un-unref'd interval would keep the
    // event loop — and the listening port — alive in an orphan process.
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private handleMessage(connection: Connection, data: string): void {
    if (this.attached.get(connection.socket) !== connection) return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data);
    } catch {
      log("dropped non-JSON frame from extension");
      return;
    }

    // A hello on an already-accepted socket carries nothing new (the
    // extension sends exactly one per socket); a `session` frame does.
    if (msg.type === "hello") return;
    if (msg.type === "session") {
      if (typeof msg.signedIn === "boolean" && connection.info.signedIn !== msg.signedIn) {
        connection.info.signedIn = msg.signedIn;
        log(`${connection.info.browser ?? "extension"} is now ${msg.signedIn ? "signed in" : "signed out"}`);
        this.changed();
      }
      return;
    }

    const id = typeof msg.id === "number" ? msg.id : null;
    if (id == null) return;

    const entry = this.pending.get(id);
    if (!entry || entry.connection !== connection) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);

    if (msg.ok === false) {
      const status = typeof msg.status === "number" ? msg.status : undefined;
      entry.reject(
        new BridgeError(String(msg.error || "Unknown bridge error"), status, undefined, undefined, refusalFrom(msg)),
      );
      return;
    }
    entry.resolve(msg.result);
  }

  /** Listeners for a socket that has (now) been accepted. */
  private wireSocket(connection: Connection): void {
    const socket = connection.socket;

    socket.on("pong", () => {
      if (this.attached.get(socket) !== connection) return;
      connection.missedPongs = 0;
    });

    socket.on("message", (raw) => this.handleMessage(connection, raw.toString()));

    socket.on("close", () => {
      if (this.attached.get(socket) !== connection) return;
      this.dropConnection(connection, `${BRAND.extensionName} disconnected mid-command.`);
      log(`extension disconnected (${connection.info.browser ?? connection.key})`);
      this.changed();
    });

    socket.on("error", (error) => {
      log("socket error:", error instanceof Error ? error.message : String(error));
    });
  }

  /** Forget a connection and fail the commands that were waiting on it. */
  private dropConnection(connection: Connection, reason: string): void {
    this.attached.delete(connection.socket);
    if (this.byKey.get(connection.key) === connection) this.byKey.delete(connection.key);
    for (const [runId, owner] of this.runOwners) {
      if (owner === connection.key) this.runOwners.delete(runId);
    }
    for (const [id, entry] of this.pending) {
      if (entry.connection !== connection) continue;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new BridgeError(reason, undefined, "COMMAND_INTERRUPTED"));
    }
  }

  /**
   * Park a fresh connection until its first frame — which must be a hello that
   * passes the same checks as everyone else's. A rejected hello, silence for
   * ten seconds, or a close ends only the newcomer.
   */
  private adoptCandidate(socket: WebSocket): void {
    this.candidates.add(socket);
    const timer = setTimeout(() => {
      if (!this.candidates.has(socket)) return;
      log("connection sent no hello in time — closing it");
      this.candidates.delete(socket);
      safeClose(socket, 1008, "No hello");
    }, CANDIDATE_HELLO_TIMEOUT_MS);
    timer.unref?.();

    socket.on("message", (raw) => {
      if (!this.candidates.has(socket)) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type !== "hello") return;
      clearTimeout(timer);
      void this.handleCandidateHello(socket, msg);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      this.candidates.delete(socket);
    });
    socket.on("error", (error) => {
      log("candidate socket error:", error instanceof Error ? error.message : String(error));
    });
  }

  private async handleCandidateHello(socket: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const verdict = await this.checkHello(msg);
    if (!this.candidates.has(socket) || socket.readyState !== 1) return;
    this.candidates.delete(socket);
    if (this.currentRole !== "owner") {
      // The port changed hands while this hello was being checked: redial the new owner.
      safeClose(socket, MOVED_CLOSE_CODE, "The bridge moved to another server");
      return;
    }
    if (!verdict.ok) {
      this.rejectHandshake(socket, verdict.reason);
      return;
    }
    this.acceptHello(socket, msg, verdict.pairing, verdict.protocolVersion);
  }

  private rejectHandshake(socket: WebSocket, reason: string): void {
    log(`rejecting handshake: ${reason}`);
    this.lastError = reason;
    // 1008 = policy violation. The extension backs off for a minute on it.
    safeClose(socket, 1008, reason);
    this.changed();
  }

  /** The verdict on a hello frame: accept, or the reason to refuse it. Reads the pairing file each time. */
  private async checkHello(
    msg: Record<string, unknown>,
  ): Promise<
    | { ok: true; pairing: Pairing | null; protocolVersion: number | null }
    | { ok: false; reason: string; pairingFailure: boolean }
  > {
    if (msg.client !== EXTENSION_CLIENT_ID) {
      return { ok: false, reason: `Unknown client ${String(msg.client)}`, pairingFailure: false };
    }

    let pairing: Pairing | null = null;
    try {
      pairing = await this.readPairing();
    } catch (error) {
      // A present-but-broken pairing file must fail closed: with the file on
      // disk the operator expects authentication, so an unreadable file cannot
      // quietly become "no authentication".
      this.pairingRequired = true;
      return { ok: false, reason: error instanceof Error ? error.message : String(error), pairingFailure: true };
    }
    this.pairingRequired = pairing !== null;

    const protocolVersion = typeof msg.protocolVersion === "number" ? msg.protocolVersion : null;
    if (pairing) {
      if (protocolVersion === null || protocolVersion < MIN_PAIRED_PROTOCOL_VERSION) {
        return {
          ok: false,
          pairingFailure: false,
          reason:
            `Bridge protocol v${MIN_PAIRED_PROTOCOL_VERSION} required for a Workmate-managed ` +
            `extension; this one speaks v${protocolVersion ?? "?"}. Update ${BRAND.productName}.`,
        };
      }
      if (typeof msg.token !== "string" || msg.token !== pairing.token) {
        return {
          ok: false,
          pairingFailure: false,
          reason:
            "Pairing token mismatch: this extension was not installed by the Workmate that runs this " +
            "server. Reinstall it from Workmate → Settings → Browser, or reset the token there.",
        };
      }
    }
    return { ok: true, pairing, protocolVersion };
  }

  /** Record the accepted extension, answer with hello_ack, wake anyone waiting. */
  private acceptHello(
    socket: WebSocket,
    msg: Record<string, unknown>,
    pairing: Pairing | null,
    protocolVersion: number | null,
  ): void {
    const instanceId = typeof msg.instanceId === "string" && msg.instanceId.trim() ? msg.instanceId.trim() : "";
    const key = instanceId || `socket:${++this.anonymousSeq}`;
    const info: ExtensionInfo = {
      version: typeof msg.version === "string" && msg.version ? msg.version : null,
      browser: typeof msg.browser === "string" && msg.browser ? msg.browser : null,
      installType:
        msg.installType === "workmate" || msg.installType === "dev" ? msg.installType : null,
      signedIn: typeof msg.signedIn === "boolean" ? msg.signedIn : null,
      protocolVersion,
      lastHelloAt: new Date().toISOString(),
      capabilities: Array.isArray(msg.capabilities) ? (msg.capabilities as string[]) : [],
      instanceId: key,
    };

    // The same profile dialling again (a reload, a browser restart whose old
    // socket has not been reaped yet): only its own previous socket goes.
    const previous = this.byKey.get(key);
    if (previous && previous.socket !== socket) {
      log(`${info.browser ?? key} reconnected — replacing its previous socket`);
      this.dropConnection(previous, `${BRAND.extensionName} reconnected mid-command.`);
      safeClose(previous.socket, 1000, "Superseded by a reconnect of the same extension");
    }

    const connection: Connection = {
      key,
      socket,
      info,
      paired: pairing !== null,
      acceptedAt: Date.now(),
      missedPongs: 0,
    };
    this.attached.set(socket, connection);
    this.byKey.set(key, connection);
    this.lastError = null;
    this.wireSocket(connection);

    log(
      `handshake ok — protocol v${protocolVersion}, ` +
        `${BRAND.productName} ${info.version ?? "?"} on ${info.browser ?? "unknown browser"} ` +
        `(${info.installType ?? "unknown install"}${pairing ? ", paired" : ""}, ${instanceId ? `instance ${instanceId}` : "no instance id"}), ` +
        `capabilities: ${info.capabilities.join(", ") || "none"}; ${this.attached.size} attached`,
    );

    try {
      socket.send(
        JSON.stringify({
          type: "hello_ack",
          serverVersion: SERVER_VERSION,
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          // Echoing the token is how the extension knows we read the same
          // pairing file Workmate wrote for it. Never echo an unverified token.
          token: pairing ? pairing.token : null,
          minExtensionVersion: MIN_EXTENSION_VERSION,
          minProtocol: pairing ? MIN_PAIRED_PROTOCOL_VERSION : 2,
        }),
      );
    } catch (error) {
      log("could not send hello_ack:", error instanceof Error ? error.message : String(error));
    }

    this.changed();
  }

  private failAllPending(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  // ── Reading the bridge (either role) ───────────────────────────────────

  /** Whether an extension is reachable from here: attached to us, or to the owner we relay through. */
  isConnected(): boolean {
    if (this.currentRole !== "owner") return this.relayedState()?.connected === true;
    for (const connection of this.attached.values()) {
      if (connection.socket.readyState === 1) return true;
    }
    return false;
  }

  /** Whether the named instance is attached. */
  hasConnection(instanceId: string): boolean {
    if (this.currentRole !== "owner") return this.connections().some((c) => c.instanceId === instanceId);
    const connection = this.byKey.get(instanceId);
    return Boolean(connection && connection.socket.readyState === 1);
  }

  capabilities(): string[] {
    return [...this.info().capabilities];
  }

  /** Whether a Workmate pairing file is in force (as of the last check). */
  isPaired(): boolean {
    return this.relayedState()?.pairingRequired ?? this.pairingRequired;
  }

  /**
   * Record a sign-in fact learned outside a hello (the answer to `auth_hint`).
   * The extension also relays it as a `session` frame; this only makes the
   * next status read consistent with the command outcome at once.
   */
  markSignedIn(instanceId: string, signedIn: boolean): void {
    const connection = this.byKey.get(instanceId);
    if (!connection || connection.info.signedIn === signedIn) return;
    connection.info.signedIn = signedIn;
    this.changed();
  }

  /**
   * Re-read whether a pairing file is in force. Called on the failure path
   * only, so a Workmate that installed (or removed) the pairing since this
   * server started still gets the right wording without a restart.
   */
  private async refreshPairingMode(): Promise<void> {
    try {
      this.pairingRequired = (await this.readPairing()) !== null;
    } catch {
      this.pairingRequired = true;
    }
  }

  /** notConnectedError() after refreshing the pairing mode from disk. */
  async describeNotConnected(): Promise<BridgeError> {
    await this.refreshPairingMode();
    return this.notConnectedError();
  }

  /**
   * The error a command gets when nothing is attached — worded for the way
   * this extension was installed, and coded so Workmate can act on it.
   */
  notConnectedError(): BridgeError {
    if (this.pairingRequired && !extensionFolderPresent(this.installDir)) {
      return new BridgeError(
        `${BRAND.productName} is not installed in any browser on this machine yet. ` +
          "Ask the user to install it from Workmate → Settings → Browser.",
        undefined,
        undefined,
        "WEBMATE_NOT_INSTALLED",
      );
    }
    return new BridgeError(
      `No ${BRAND.extensionName} is connected. ` +
        (this.pairingRequired ? pairedConnectInstructions() : connectInstructions()),
      undefined,
      undefined,
      "WEBMATE_NOT_CONNECTED",
    );
  }

  /**
   * Resolve true once `ready()` holds; false once no route can appear
   * (`hopeless()`) or the time is up. Re-checked on every change.
   */
  private waitUntil(ready: () => boolean, timeoutMs: number): Promise<boolean> {
    if (ready()) return Promise.resolve(true);
    if (this.hopeless() || timeoutMs <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (value: boolean) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(value);
      };
      const check = () => {
        if (ready()) finish(true);
        else if (this.hopeless()) finish(false);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.waiters.add(check);
    });
  }

  /** Resolve once an extension can be reached from here (directly or through the owner). */
  waitForExtension(timeoutMs: number): Promise<boolean> {
    return this.waitUntil(() => this.isConnected(), timeoutMs);
  }

  /** The connection a command should go to, or null. */
  private resolveTarget(payload: Record<string, unknown>, target: RequestTarget): Connection | null {
    if (target.instanceId) {
      const named = this.byKey.get(target.instanceId);
      return named && named.socket.readyState === 1 ? named : null;
    }
    const runId = typeof payload.runId === "string" ? payload.runId : typeof payload.run_id === "string" ? payload.run_id : "";
    if (runId) {
      const owner = this.runOwners.get(runId);
      const named = owner ? this.byKey.get(owner) : undefined;
      if (named && named.socket.readyState === 1) return named;
    }
    return this.active();
  }

  /** Remember which browser a run lives in, from the frames that name runs. */
  private learnRunOwners(action: BridgeAction, connection: Connection, result: unknown): void {
    const record = (runId: unknown) => {
      if (typeof runId !== "string" || !runId) return;
      this.runOwners.delete(runId);
      this.runOwners.set(runId, connection.key);
      if (this.runOwners.size > MAX_REMEMBERED_RUNS) {
        const oldest = this.runOwners.keys().next().value;
        if (oldest !== undefined) this.runOwners.delete(oldest);
      }
    };
    if (!result || typeof result !== "object") return;
    const body = result as Record<string, unknown>;
    if (action === "cloud_run" || action === "cloud_status" || action === "cloud_respond" || action === "cloud_abort") {
      record(body.runId ?? body.run_id);
    }
    if (Array.isArray(body.runs)) {
      for (const run of body.runs) {
        if (run && typeof run === "object") record((run as Record<string, unknown>).runId ?? (run as Record<string, unknown>).run_id);
      }
    }
  }

  /**
   * Send one command and await the extension's reply — directly when this
   * process holds the port, else through the owner.
   *
   * The extension dials the owner, so a command issued right after the port
   * was bound (or changed hands) arrives while the browser is still inside its
   * reconnect backoff. Failing instantly there turns an ordinary cold start
   * into a spurious "no extension is connected", so both roles wait up to
   * config.connectGraceMs for a route and a browser. A standby that knows it
   * has no route fails at once with the reason instead: that wording names
   * the process holding the port, not browser settings that are already fine.
   */
  async request<T = unknown>(
    action: BridgeAction,
    payload: Record<string, unknown> = {},
    timeoutMs = config.commandTimeoutMs,
    target: RequestTarget = {},
  ): Promise<T> {
    const deadline = Date.now() + Math.max(0, config.connectGraceMs);
    for (;;) {
      if (this.currentRole === "owner") {
        const connection = this.resolveTarget(payload, target);
        if (connection) return this.send<T>(connection, action, payload, timeoutMs, target);
        if (target.instanceId) {
          throw new BridgeError(
            `No ${BRAND.extensionName} with instance id ${target.instanceId} is connected.`,
            undefined,
            undefined,
            "WEBMATE_NOT_CONNECTED",
          );
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw await this.describeNotConnected();
        await this.waitUntil(
          () => this.currentRole !== "owner" || this.resolveTarget(payload, target) !== null,
          remaining,
        );
        continue;
      }

      const link = this.currentRole === "standby" ? this.upstream : null;
      if (link?.ready) {
        if (!RELAYABLE_ACTIONS.has(action)) {
          throw new BridgeError(
            `'${action}' goes only from the server that holds the bridge port ` +
              `(PID ${link.owner.pid ?? "?"}); this one relays through it.`,
          );
        }
        // The owner may wait out its own connect grace, then the command itself.
        const waitMs = config.connectGraceMs + Math.min(config.commandTimeoutMs, Math.max(1, timeoutMs)) + 5_000;
        try {
          return await link.relay<T>(action, payload, timeoutMs, target, waitMs);
        } catch (error) {
          if (!(error instanceof RelayRetryError) || Date.now() >= deadline) throw error;
          await this.waitUntil(() => this.upstream !== link || this.currentRole !== "standby", deadline - Date.now());
          continue;
        }
      }

      if (this.hopeless()) {
        throw new BridgeError(this.standbyReason ?? "", undefined, undefined, "WEBMATE_PORT_IN_USE");
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        if (this.standbyReason) throw new BridgeError(this.standbyReason, undefined, undefined, "WEBMATE_PORT_IN_USE");
        throw await this.describeNotConnected();
      }
      await this.waitUntil(() => this.currentRole === "owner" || Boolean(this.upstream?.ready), remaining);
    }
  }

  /** Put one command on an attached extension's socket and await the matching reply. */
  private send<T>(
    connection: Connection,
    action: BridgeAction,
    payload: Record<string, unknown>,
    timeoutMs: number,
    target: RequestTarget,
  ): Promise<T> {
    const id = this.nextId++;
    const frame = JSON.stringify({ id, action, payload });
    const responseTimeoutMs = target.unclamped
      ? Math.max(1, timeoutMs)
      : Math.max(1, Math.min(config.commandTimeoutMs, timeoutMs));

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BridgeError(
            `${BRAND.productName} did not answer '${action}' within ${responseTimeoutMs}ms.`,
            undefined,
            "COMMAND_TIMEOUT",
          ),
        );
      }, responseTimeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          this.learnRunOwners(action, connection, value);
          resolve(value as T);
        },
        reject,
        timer,
        connection,
      });

      try {
        connection.socket.send(frame);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(
          new BridgeError(
            `Failed to send '${action}': ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  }

  async stop(): Promise<void> {
    this.setRole("idle");
    if (this.claimTimer) clearTimeout(this.claimTimer);
    this.claimTimer = null;
    if (this.handoff?.timer) clearTimeout(this.handoff.timer);
    this.handoff = null;
    this.stopHeartbeat();
    this.failAllPending(new BridgeError("Bridge shutting down."));
    this.releaseAll(1001, "Server shutting down");
    const upstream = this.upstream;
    this.upstream = null;
    upstream?.close(1000, "Server shutting down");
    this.standbyReason = null;
    const server = this.server;
    this.server = null;
    if (server) {
      // Every socket is closing; wait (briefly) for the listener to finish so
      // a restart in the same process finds the port free.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        timer.unref?.();
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.changed();
  }
}
