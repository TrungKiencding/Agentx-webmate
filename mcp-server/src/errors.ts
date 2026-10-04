/**
 * Structured error codes the six tools attach to their failures.
 *
 * AgentX Workmate watches tool results for these strings and turns them into
 * a card ("Workmate wants to use your browser — install WebMate?") instead of
 * letting the agent paraphrase a stack of plumbing text. Each code therefore
 * appears twice in a failing result: as the prefix of the human-readable
 * text and as `structuredContent.code`. Keep the list in sync with
 * `apps/desktop/electron/webmate/` in the Workmate repository.
 *
 *   WEBMATE_DISABLED       reserved for the host — when Workmate has the MCP
 *                          server switched off this process never runs, so
 *                          the host raises this one itself.
 *   WEBMATE_NOT_INSTALLED  Workmate pairing is configured but no extension
 *                          folder exists, so nothing can ever dial in.
 *   WEBMATE_NOT_CONNECTED  installed (or dev mode) but no browser attached.
 *   WEBMATE_OUTDATED       the attached extension speaks a protocol too old
 *                          for this server.
 *   WEBMATE_NOT_SIGNED_IN  attached, but nobody is signed in to the extension
 *                          so it has no model to run with.
 *   WEBMATE_PORT_IN_USE    another process holds the bridge port.
 */
export const WEBMATE_ERROR_CODES = [
  "WEBMATE_DISABLED",
  "WEBMATE_NOT_INSTALLED",
  "WEBMATE_NOT_CONNECTED",
  "WEBMATE_OUTDATED",
  "WEBMATE_NOT_SIGNED_IN",
  "WEBMATE_PORT_IN_USE",
] as const;

export type WebmateErrorCode = (typeof WEBMATE_ERROR_CODES)[number];

export function isWebmateErrorCode(value: unknown): value is WebmateErrorCode {
  return typeof value === "string" && (WEBMATE_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * A failed bridge command. `code` says whether the command reached the
 * extension at all; `webmateCode` is the structured code Workmate reacts to.
 */
export class BridgeError extends Error {
  readonly status?: number;
  readonly code?: "COMMAND_TIMEOUT" | "COMMAND_INTERRUPTED";
  /** Structured code Workmate reacts to (see WEBMATE_ERROR_CODES). */
  readonly webmateCode?: WebmateErrorCode;
  constructor(
    message: string,
    status?: number,
    code?: "COMMAND_TIMEOUT" | "COMMAND_INTERRUPTED",
    webmateCode?: WebmateErrorCode,
  ) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
    this.code = code;
    this.webmateCode = webmateCode;
  }
}
