/**
 * Command files from Workmate.
 *
 * Workmate needs to tell the running server two things during an extension
 * update — "stop taking new runs and tell me when you are idle" and "reload
 * the extension now" — without this server opening a second port. A file per
 * command in `<webmate dir>/commands/` does that: Workmate writes
 * `<uuid>.json` (temp + rename, so it appears whole), this watcher picks it
 * up, deletes it, runs the action over the bridge, and records the outcome as
 * `lastCommand` in state.json for Workmate to correlate by id.
 *
 *   { "id": "<uuid>", "action": "prepare_update" | "reload" | "resume"
 *                    | "auth_hint" | "auth_open", "payload"?: { ... } }
 *
 * The two sign-in actions (phase 4) carry `payload.loginHint` (the account
 * email Workmate is signed in as) and optionally `payload.instanceId` to
 * address one attached browser; see index.ts handleWorkmateCommand.
 *
 * fs.watch is the fast path; a slow poll backs it up because directory
 * watching is best-effort on every platform this ships to.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, unlink, watch as fsWatch } from "node:fs/promises";
import path from "node:path";

export const COMMAND_ACTIONS = ["prepare_update", "reload", "resume", "auth_hint", "auth_open"] as const;
export type CommandAction = (typeof COMMAND_ACTIONS)[number];

export interface WorkmateCommand {
  id: string;
  action: CommandAction;
  payload: Record<string, unknown>;
  file: string;
}

export interface CommandOutcome {
  ok: boolean;
  busy?: number;
  error?: string | null;
  [key: string]: unknown;
}

export interface CommandWatcherOptions {
  dir: string | null;
  handle: (command: WorkmateCommand) => Promise<CommandOutcome>;
  onResult: (command: WorkmateCommand, outcome: CommandOutcome, timing: { startedAt: string; finishedAt: string }) => void;
  log?: (...args: unknown[]) => void;
  pollMs?: number;
  now?: () => Date;
}

/** Parse one command file's text. Returns null (with a reason) for junk. */
export function parseCommand(text: string, file: string): { command: WorkmateCommand | null; reason?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { command: null, reason: `not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { command: null, reason: "not an object" };
  const record = raw as Record<string, unknown>;
  const action = String(record.action || "");
  if (!(COMMAND_ACTIONS as readonly string[]).includes(action)) {
    return { command: null, reason: `unknown action '${action}'` };
  }
  const stem = path.basename(file, ".json");
  const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : stem;
  const payload =
    record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
      ? (record.payload as Record<string, unknown>)
      : {};
  return { command: { id, action: action as CommandAction, payload, file } };
}

export class CommandWatcher {
  private readonly dir: string | null;
  private readonly handle: CommandWatcherOptions["handle"];
  private readonly onResult: CommandWatcherOptions["onResult"];
  private readonly log: (...args: unknown[]) => void;
  private readonly pollMs: number;
  private readonly now: () => Date;
  private watcherAbort: AbortController | null = null;
  private poll: NodeJS.Timeout | null = null;
  private scanning: Promise<void> = Promise.resolve();
  private stopped = false;
  private inFlight = new Set<string>();

  constructor(options: CommandWatcherOptions) {
    this.dir = options.dir;
    this.handle = options.handle;
    this.onResult = options.onResult;
    this.log = options.log ?? (() => {});
    this.pollMs = options.pollMs ?? 2_000;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Start (or restart) watching. Only the server that holds the bridge port
   * runs this — the commands act on the extension attached to it — so a
   * server that gains the port starts here and one that hands it over stops.
   */
  async start(): Promise<void> {
    if (!this.dir || this.watcherAbort) return;
    this.stopped = false;
    const dir = this.dir;
    // Claimed before the first await, so a second start() or a stop() in the
    // meantime sees it.
    const abort = new AbortController();
    this.watcherAbort = abort;
    try {
      await mkdir(dir, { recursive: true });
    } catch (error) {
      this.log(`cannot create ${dir}: ${error instanceof Error ? error.message : String(error)}`);
      if (this.watcherAbort === abort) this.watcherAbort = null;
      return;
    }
    if (abort.signal.aborted) return;
    void this.watchLoop(dir, abort.signal);
    this.poll = setInterval(() => void this.scan(), this.pollMs);
    this.poll.unref?.();
    await this.scan();
  }

  stop(): void {
    this.stopped = true;
    this.watcherAbort?.abort();
    this.watcherAbort = null;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  /** Resolve once no command is running (their outcomes recorded), or after `timeoutMs`. */
  async drain(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.inFlight.size > 0) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return true;
  }

  private async watchLoop(dir: string, signal: AbortSignal): Promise<void> {
    try {
      for await (const _event of fsWatch(dir, { signal })) {
        void this.scan();
      }
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") return;
      // Not fatal: the poll keeps commands flowing, just more slowly.
      this.log(`fs.watch on ${dir} stopped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Process every command file present, oldest first, one at a time. */
  scan(): Promise<void> {
    this.scanning = this.scanning.then(() => this.scanNow()).catch(() => {});
    return this.scanning;
  }

  private async scanNow(): Promise<void> {
    if (!this.dir || this.stopped || !existsSync(this.dir)) return;
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    const files: Array<{ file: string; mtimeMs: number }> = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith(".") || name.endsWith(".tmp")) continue;
      const file = path.join(this.dir, name);
      if (this.inFlight.has(file)) continue;
      try {
        files.push({ file, mtimeMs: (await stat(file)).mtimeMs });
      } catch {
        /* vanished between readdir and stat */
      }
    }
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const { file } of files) {
      if (this.stopped) return;
      await this.runOne(file);
    }
  }

  private async runOne(file: string): Promise<void> {
    this.inFlight.add(file);
    try {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        return;
      }
      // Claim by deletion before acting, so a crash mid-command cannot replay
      // a reload on the next start.
      try {
        await unlink(file);
      } catch {
        return;
      }
      const { command, reason } = parseCommand(text, file);
      if (!command) {
        this.log(`ignored command file ${path.basename(file)}: ${reason}`);
        return;
      }
      const startedAt = this.now().toISOString();
      let outcome: CommandOutcome;
      try {
        outcome = await this.handle(command);
      } catch (error) {
        outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      this.onResult(command, outcome, { startedAt, finishedAt: this.now().toISOString() });
    } finally {
      this.inFlight.delete(file);
    }
  }
}
