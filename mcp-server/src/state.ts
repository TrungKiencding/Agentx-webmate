/**
 * `state.json` — what this server knows about the bridge, for Workmate to
 * read.
 *
 * Workmate's desktop app watches this file (fs.watch) to render the
 * "connected · Google Chrome" line during onboarding and in Settings, and to
 * decide whether an update can be applied live. It is written whole on every
 * change, through a temp file and rename, so a reader never sees a torn JSON
 * document. Only the copy of this server that holds the bridge port writes it
 * (see peer.ts); a standby writes nothing, because the owner's file is the
 * truthful one, and a copy that is handed the port takes over the file.
 *
 * Readers should treat `listening: true` with a dead `pid` as stale — a
 * force-quit server has no chance to write its goodbye.
 */

import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface LastCommand {
  id: string;
  action: string;
  ok: boolean;
  busy?: number;
  error?: string | null;
  /** auth_hint / auth_open: one entry per browser asked (see index.ts handleAuthCommand). */
  results?: unknown[];
  /** auth_hint / auth_open: whether at least one browser ended up signed in. */
  signedIn?: boolean;
  startedAt: string;
  finishedAt: string;
}

/** One attached extension, as state.json lists it under `connections`. */
export interface ConnectionState {
  /** `hello.instanceId` (per browser profile), or a per-socket id when the extension sent none. */
  instanceId: string;
  browser: string | null;
  extensionVersion: string | null;
  installType: "workmate" | "dev" | null;
  signedIn: boolean | null;
  protocolVersion: number | null;
  lastHelloAt: string | null;
  paired: boolean;
  /** The connection commands go to when nothing names one (signed-in first, then newest). */
  active: boolean;
}

/** A copy of this server relaying through the owner (see peer.ts). */
export interface StandbyState {
  pid: number | null;
  host: string | null;
  priority: number;
}

export interface BridgeStateFields {
  pid: number;
  port: number;
  serverVersion: string;
  /** The AgentX process hosting the owner ("desktop", "gateway", …), when it said. */
  host: string | null;
  /** The owner's bridge priority; a copy that outranks it is handed the port. */
  priority: number;
  /** Copies relaying their commands through this owner. */
  standbys: StandbyState[];
  listening: boolean;
  connected: boolean;
  pairingRequired: boolean;
  // The fields below describe the active connection, for readers that know
  // one extension; `connections` lists every attached one (phase 4).
  browser: string | null;
  extensionVersion: string | null;
  installType: "workmate" | "dev" | null;
  signedIn: boolean | null;
  protocolVersion: number | null;
  lastHelloAt: string | null;
  instanceId: string | null;
  connections: ConnectionState[];
  error: string | null;
  lastCommand: LastCommand | null;
}

export interface BridgeState extends BridgeStateFields {
  schema: 1;
  updatedAt: string;
}

export const EMPTY_STATE: Omit<BridgeStateFields, "pid" | "port" | "serverVersion" | "host" | "priority"> = {
  standbys: [],
  listening: false,
  connected: false,
  pairingRequired: false,
  browser: null,
  extensionVersion: null,
  installType: null,
  signedIn: null,
  protocolVersion: null,
  lastHelloAt: null,
  instanceId: null,
  connections: [],
  error: null,
  lastCommand: null,
};

let seq = 0;

/** Write `data` to `file` atomically (temp sibling + rename), creating the directory. */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${seq++}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}

export class StateFile {
  private state: BridgeState;
  private queue: Promise<void> = Promise.resolve();
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly file: string | null,
    seed: Pick<BridgeStateFields, "pid" | "port" | "serverVersion" | "host" | "priority">,
    private readonly log: (...args: unknown[]) => void = () => {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.state = { schema: 1, ...EMPTY_STATE, ...seed, updatedAt: this.now().toISOString() };
  }

  /**
   * Keep the last command outcome already in the file when this process takes
   * the file over from a previous owner, so Workmate still finds the outcome
   * of a command that owner finished just before the port changed hands.
   */
  inheritLastCommand(): void {
    if (!this.file || this.state.lastCommand) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>;
      const last = raw?.lastCommand;
      if (last && typeof last === "object" && typeof (last as LastCommand).id === "string") {
        this.state = { ...this.state, lastCommand: last as LastCommand };
      }
    } catch {
      /* no file yet, or unreadable: nothing to keep */
    }
  }

  /** Current in-memory state (what the next write will contain). */
  current(): BridgeState {
    return { ...this.state };
  }

  /** Merge a change in and schedule a write on the next tick (coalesces bursts). */
  update(patch: Partial<BridgeStateFields>): void {
    this.state = { ...this.state, ...patch, updatedAt: this.now().toISOString() };
    if (!this.file) return;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 0);
    this.timer.unref?.();
  }

  /** Write the current state now. Serialised; safe to call from shutdown. */
  flush(): Promise<void> {
    if (!this.file || !this.dirty) return this.queue;
    this.dirty = false;
    const snapshot = this.state;
    const file = this.file;
    this.queue = this.queue
      .then(() => writeJsonAtomic(file, snapshot))
      .catch((error) => {
        this.log(`could not write ${file}: ${error instanceof Error ? error.message : String(error)}`);
      });
    return this.queue;
  }
}
