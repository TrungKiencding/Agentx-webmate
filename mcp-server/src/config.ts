/**
 * Runtime configuration, all environment-driven.
 *
 * Every setting is read from `<BRAND>_<NAME>` (e.g. WEBMATE_BRIDGE_PORT) first,
 * then from the other spellings this server has shipped under (WEBMATE_*,
 * upstream WEBBRAIN_*), so a snippet copied from any of those docs keeps
 * working. When several are set, the branded name wins.
 *
 * The bridge port intentionally defaults to 17374, NOT 17373. The Cloud
 * sidecar owns 17373 and the LM Studio plugin owns 17375, and the extension's
 * `cloud-bridge.js` holds exactly one outbound socket — so it can be pointed
 * at one controller at a time, never several. Using a distinct port keeps the
 * failure mode obvious ("nothing connected") instead of two processes
 * fighting over one listener.
 */

import { homedir } from "node:os";
import path from "node:path";

import { BRAND } from "./brand.generated.js";

const PREFIXES = [...new Set([BRAND.envPrefix, "WEBMATE_", "WEBBRAIN_"])];

/**
 * Resolve `<PREFIX><suffix>` across the accepted prefixes. Returns the variable
 * name that was actually set so error messages point at the right spelling.
 */
function readEnv(suffix: string, env: NodeJS.ProcessEnv = process.env): { name: string; raw: string } | null {
  for (const prefix of PREFIXES) {
    const name = `${prefix}${suffix}`;
    const raw = env[name];
    if (raw) return { name, raw };
  }
  return null;
}

function parseIntFromEnv(name: string, raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== raw.trim()) {
    throw new Error(`${name} must be an integer, got: ${raw}`);
  }
  return parsed;
}

/** Ports carry a 16-bit ceiling. Durations must NOT — see durationFromEnv. */
function portFromEnv(suffix: string, fallback: number): number {
  const found = readEnv(suffix);
  if (!found) return fallback;
  const parsed = parseIntFromEnv(found.name, found.raw);
  if (parsed <= 0 || parsed > 65535) {
    throw new Error(`${found.name} must be a valid TCP port (1-65535), got: ${found.raw}`);
  }
  return parsed;
}

/**
 * Millisecond durations. Deliberately separate from portFromEnv: reusing the
 * port validator here rejected every timeout above 65535ms, including the
 * five-minute default this file itself documents.
 */
function durationFromEnv(suffix: string, fallback: number): number {
  const found = readEnv(suffix);
  if (!found) return fallback;
  const parsed = parseIntFromEnv(found.name, found.raw);
  if (parsed <= 0) {
    throw new Error(
      `${found.name} must be a positive duration in milliseconds, got: ${found.raw}`,
    );
  }
  return parsed;
}

/** Like durationFromEnv, but 0 is a legal value meaning "disabled". */
function optionalDurationFromEnv(suffix: string, fallback: number): number {
  const found = readEnv(suffix);
  if (!found) return fallback;
  const parsed = parseIntFromEnv(found.name, found.raw);
  if (parsed < 0) {
    throw new Error(
      `${found.name} must be a non-negative duration in milliseconds (0 disables), got: ${found.raw}`,
    );
  }
  return parsed;
}

/** Any integer, negative included (priorities). */
function intFromEnv(suffix: string, fallback: number): number {
  const found = readEnv(suffix);
  if (!found) return fallback;
  return parseIntFromEnv(found.name, found.raw);
}

function stringFromEnv(suffix: string, fallback: string): string {
  return readEnv(suffix)?.raw || fallback;
}

/**
 * The AgentX process this server runs under, as that process says in
 * `AGENTX_MCP_HOST` ("desktop" for the Workmate app's own backend, "gateway"
 * for the messaging gateway, …). Null for any other MCP host.
 */
export function hostFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.AGENTX_MCP_HOST || "").trim();
  return raw ? raw.slice(0, 40) : null;
}

/**
 * Bridge priority AgentX Workmate's desktop app gets without configuring
 * anything. The app is where the person works, so its agent drives the browser
 * directly and every other copy relays through it.
 */
export const DESKTOP_BRIDGE_PRIORITY = 100;

/** Default priority for a host: the desktop app outranks everything else. */
export function defaultPriorityForHost(host: string | null): number {
  return host === "desktop" ? DESKTOP_BRIDGE_PRIORITY : 0;
}

/**
 * A file/dir setting that Workmate can point elsewhere, or switch off with
 * the literal `off` (used by tests that must not touch the real profile).
 */
function optionalPathFromEnv(suffix: string, fallback: string): string | null {
  const found = readEnv(suffix);
  if (!found) return fallback;
  const raw = found.raw.trim();
  if (!raw || raw.toLowerCase() === "off") return null;
  return path.resolve(raw);
}

/**
 * Root of the AgentX install on this platform, mirroring
 * `_get_platform_default_hermes_home()` in Workmate's hermes_constants.py:
 * `~/.agentx` on POSIX, `%LOCALAPPDATA%\agentx` on Windows.
 */
export function platformAgentxRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (platform === "win32") {
    const local = (env.LOCALAPPDATA || "").trim();
    if (local) return path.join(local, "agentx");
    return path.join(home, "AppData", "Local", "agentx");
  }
  return path.join(home, ".agentx");
}

/**
 * Climb out of Workmate's `accounts/<slug>` and `profiles/<name>` layers.
 * AGENTX_HOME as passed to a gateway is per account; the extension folder is
 * per machine, so it anchors at the install root above those layers. Mirrors
 * `_strip_home_scoping_segments()` in hermes_constants.py.
 */
export function stripHomeScopingSegments(home: string, pathModule: typeof path = path): string {
  let current = pathModule.resolve(home);
  if (pathModule.basename(pathModule.dirname(current)) === "profiles") {
    current = pathModule.dirname(pathModule.dirname(current));
  }
  if (pathModule.basename(pathModule.dirname(current)) === "accounts") {
    current = pathModule.dirname(pathModule.dirname(current));
  }
  return current;
}

/**
 * Where Workmate keeps everything WebMate-related on this machine:
 * `<root>/webmate` with the extension folder, pairing.json, state.json and the
 * commands directory inside. Resolution: WEBMATE_DIR (Workmate sets it when
 * it registers this server) → AGENTX_HOME stripped of account/profile layers
 * → the platform default root.
 */
export function resolveWebmateDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const explicit = readEnv("DIR", env);
  if (explicit) return path.resolve(explicit.raw.trim());
  const agentxHome = (env.AGENTX_HOME || "").trim();
  const root = agentxHome ? stripHomeScopingSegments(agentxHome) : platformAgentxRoot(env, platform, home);
  return path.join(root, "webmate");
}

const webmateDir = resolveWebmateDir();
const bridgeHost = hostFromEnv();

export const config = {
  /** Port this process listens on for the extension's outbound bridge socket. */
  bridgePort: portFromEnv("BRIDGE_PORT", 17374),

  /** Which AgentX process hosts this server (see hostFromEnv); logged and shared with peers. */
  bridgeHost,

  /**
   * Claim on the bridge port when several copies of this server run at once.
   * Only one can hold the port; the others relay through it (see peer.ts). A
   * copy that outranks the current holder is handed the port. Equal ranks keep
   * whoever came first. Defaults to 100 under Workmate's desktop app, else 0.
   */
  bridgePriority: intFromEnv("BRIDGE_PRIORITY", defaultPriorityForHost(bridgeHost)),

  /**
   * How often a copy that can neither hold the port nor relay through its
   * holder (an older server, or no Workmate pairing) tries the port again.
   * A copy that relays does not poll: it learns at once when its owner leaves.
   */
  bindRetryMs: durationFromEnv("BIND_RETRY_MS", 5_000),

  /**
   * Handing the port over (see WebMateBridge.beginHandoff): how long the
   * yielding owner waits for Workmate commands and in-flight commands to
   * finish, and how long it waits for the new owner to confirm it has bound.
   */
  handoffDrainMs: durationFromEnv("HANDOFF_DRAIN_MS", 5_000),
  handoffTimeoutMs: durationFromEnv("HANDOFF_TIMEOUT_MS", 5_000),

  /** Path segment the extension connects to. Must match the URL set in the extension's settings. */
  bridgePath: stringFromEnv("BRIDGE_PATH", "/extension"),

  /**
   * How long to wait for the extension to answer a single bridge command.
   * Starting a run returns immediately; this is not the task timeout.
   */
  commandTimeoutMs: durationFromEnv("COMMAND_TIMEOUT_MS", 30_000),

  /** Default ceiling for how long the run tool will poll before giving up. */
  defaultRunTimeoutMs: durationFromEnv("RUN_TIMEOUT_MS", 300_000),

  /** Interval between `cloud_status` polls while a run is in flight. */
  pollIntervalMs: durationFromEnv("POLL_INTERVAL_MS", 1_000),

  /**
   * How long a command waits for the extension to (re)attach before giving up
   * with "not connected".
   *
   * The extension dials US, so the moment this process binds the port it is
   * still sitting in its reconnect backoff. An MCP host that spawns this server
   * on demand would otherwise see its very first tool call fail against a
   * browser that attaches a second later.
   *
   * Keep this at or above the extension's reconnect ceiling
   * (MAX_RECONNECT_DELAY_MS in src/chrome/src/offscreen/cloud-bridge.js, 10s)
   * plus handshake headroom, so the grace always covers a full backoff cycle.
   */
  connectGraceMs: durationFromEnv("CONNECT_GRACE_MS", 12_000),

  /**
   * Grace for the `connection` diagnostic specifically. Deliberately far
   * shorter than connectGraceMs: an agent calls this tool precisely when it
   * suspects nothing is attached, and stalling that answer for a full backoff
   * cycle is worse than answering "not connected" a moment early. Long enough
   * only to cover a socket already mid-handshake.
   */
  connectProbeMs: durationFromEnv("CONNECT_PROBE_MS", 2_000),

  /**
   * WebSocket ping interval. A socket that misses two consecutive pongs is
   * terminated so `isConnected()` stops claiming a browser that is gone.
   *
   * This catches the disappearances TCP does not report — a killed or crashed
   * browser, a suspended VM — not a wedged extension: pongs are answered by the
   * browser's WebSocket stack, not by the offscreen document's JavaScript.
   * Set to 0 to disable.
   */
  heartbeatIntervalMs: optionalDurationFromEnv("HEARTBEAT_INTERVAL_MS", 15_000),

  /** Machine-level WebMate directory Workmate owns (see resolveWebmateDir). */
  webmateDir,

  /** Workmate pairing token; absent file = unauthenticated dev mode. */
  pairingFile: optionalPathFromEnv("PAIRING_FILE", path.join(webmateDir, "pairing.json")),

  /** Bridge state published for Workmate; `off` disables the writer. */
  stateFile: optionalPathFromEnv("STATE_FILE", path.join(webmateDir, "state.json")),

  /** Command files from Workmate (prepare_update / reload); `off` disables the watcher. */
  commandsDir: optionalPathFromEnv("COMMANDS_DIR", path.join(webmateDir, "commands")),

  /** The unpacked extension folder Workmate points the browser at. */
  installDir: path.join(webmateDir, BRAND.installDirName),

  /**
   * How long `prepare_update` waits for in-flight runs to finish before
   * reporting that the browser is still busy.
   */
  prepareUpdateTimeoutMs: durationFromEnv("PREPARE_UPDATE_TIMEOUT_MS", 60_000),

  /**
   * How long an `auth_hint` command waits for the extension's silent sign-in
   * (a hidden prompt=none authorize plus key provisioning — several network
   * round trips, each timeout-capped by the extension itself).
   */
  authCommandTimeoutMs: durationFromEnv("AUTH_TIMEOUT_MS", 90_000),
} as const;

/** The URL the user must paste into Settings → General → Advanced → Cloud bridge. */
export function bridgeUrl(): string {
  return `ws://127.0.0.1:${config.bridgePort}${config.bridgePath}`;
}
