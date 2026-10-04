/**
 * Who is listening on the bridge port — for the messages a standby shows, and
 * to recognise an older copy of this server that its AgentX host restarts.
 *
 * POSIX only (lsof, ps), read-only apart from retireOutdatedServer, and
 * bounded: a missing or slow tool degrades to "unknown" rather than delaying
 * anything.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { BRAND } from "./brand.generated.js";

const run = promisify(execFile);
const TOOL_TIMEOUT_MS = 1_000;
const posix = () => process.platform === "darwin" || process.platform === "linux";

export interface PortHolder {
  pid: number;
  command: string | null;
}

/** The process listening on `port`, or null when unknown. */
export async function findPortHolder(port: number): Promise<PortHolder | null> {
  if (!posix()) return null;
  try {
    // -F pc emits one field per line: `p<pid>` then `c<command>`.
    const { stdout } = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-F", "pc"], {
      timeout: TOOL_TIMEOUT_MS,
    });
    const pid = Number(/^p(\d+)$/m.exec(stdout)?.[1]);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, command: /^c(.+)$/m.exec(stdout)?.[1] ?? null };
  } catch {
    return null;
  }
}

/** "PID 123 (node)", "PID 123", or null. */
export function describeHolder(holder: PortHolder | null): string | null {
  if (!holder) return null;
  return holder.command ? `PID ${holder.pid} (${holder.command})` : `PID ${holder.pid}`;
}

async function psField(pid: number, field: "command" | "ppid"): Promise<string | null> {
  try {
    const { stdout } = await run("ps", ["-o", `${field}=`, "-p", String(pid)], { timeout: TOOL_TIMEOUT_MS });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** A command line that runs this server: the single-file bundle AgentX ships, or a checkout's build. */
export function isWebmateServerCommand(command: string): boolean {
  return command.includes(BRAND.bundleFile) || /mcp-server[\\/]dist[\\/]index\.js/.test(command);
}

/**
 * Whether `pid` is a copy of this server that an AgentX host supervises: its
 * parent is AgentX's stdio watchdog (tools/mcp_stdio_watchdog.py), so the host
 * notices when it exits and starts it again — from the bundle now on disk.
 */
export async function isSupervisedWebmateServer(pid: number): Promise<boolean> {
  if (!posix()) return false;
  const command = await psField(pid, "command");
  if (!command || !isWebmateServerCommand(command)) return false;
  const parent = Number(await psField(pid, "ppid"));
  if (!Number.isInteger(parent) || parent <= 1) return false;
  const parentCommand = await psField(parent, "command");
  return Boolean(parentCommand?.includes("mcp_stdio_watchdog"));
}
