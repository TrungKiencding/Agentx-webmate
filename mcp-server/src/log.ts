/**
 * stderr logging — stdout is the MCP stdio transport and must stay clean.
 *
 * Every line names this process, and the AgentX host that started it when the
 * host said (AGENTX_MCP_HOST). Several copies of this server usually write to
 * one file — AgentX sends every MCP server's stderr to the account's
 * mcp-stderr.log — and "which copy said that?" is the first question whenever
 * the bridge port changes hands.
 */

import { BRAND } from "./brand.generated.js";
import { config } from "./config.js";

export const LOG_PREFIX =
  `[${BRAND.serverName}-mcp pid=${process.pid}` + (config.bridgeHost ? ` host=${config.bridgeHost}]` : "]");

export function log(...args: unknown[]): void {
  console.error(LOG_PREFIX, ...args);
}
