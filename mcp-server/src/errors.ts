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
 * Refusals the extension itself answers with a code of its own: a state of
 * the person's account, not of the WebMate plumbing, so they sit outside the
 * WEBMATE_* set above. A failing tool result leads with the code and repeats
 * it as `structuredContent.code`, exactly as the extension spelled it.
 *
 *   license_read_only  the AgentX license of the account signed in to the
 *                      extension is read-only (no license, not started yet,
 *                      expired or revoked). Retrying does not help until it
 *                      changes; the license object rides along as
 *                      `structuredContent.license` so Workmate can say why.
 */
export const EXTENSION_REFUSAL_CODES = ["license_read_only"] as const;

export type ExtensionRefusalCode = (typeof EXTENSION_REFUSAL_CODES)[number];

export function isExtensionRefusalCode(value: unknown): value is ExtensionRefusalCode {
  return typeof value === "string" && (EXTENSION_REFUSAL_CODES as readonly string[]).includes(value);
}

/** An extension refusal and what it carried. */
export interface ExtensionRefusal {
  code: ExtensionRefusalCode;
  /** The AgentX license object (`license_read_only`), passed on untouched. */
  license?: Record<string, unknown>;
}

/**
 * The refusal a failure frame carries — the extension's `{ ok: false, error,
 * status, code, license }`, or its relayed form — or undefined. Unknown codes
 * are dropped rather than trusted.
 */
export function refusalFrom(frame: unknown): ExtensionRefusal | undefined {
  if (!frame || typeof frame !== "object") return undefined;
  const raw = frame as Record<string, unknown>;
  if (!isExtensionRefusalCode(raw.code)) return undefined;
  const license =
    raw.license && typeof raw.license === "object" && !Array.isArray(raw.license)
      ? (raw.license as Record<string, unknown>)
      : undefined;
  return { code: raw.code, ...(license ? { license } : {}) };
}

/**
 * A failed bridge command. `code` says whether the command reached the
 * extension at all; `webmateCode` is the structured code Workmate reacts to;
 * `refusal` is the extension's own reason, when it gave one.
 */
export class BridgeError extends Error {
  readonly status?: number;
  readonly code?: "COMMAND_TIMEOUT" | "COMMAND_INTERRUPTED";
  /** Structured code Workmate reacts to (see WEBMATE_ERROR_CODES). */
  readonly webmateCode?: WebmateErrorCode;
  /** The extension refused for a reason of its own (see EXTENSION_REFUSAL_CODES). */
  readonly refusal?: ExtensionRefusal;
  constructor(
    message: string,
    status?: number,
    code?: "COMMAND_TIMEOUT" | "COMMAND_INTERRUPTED",
    webmateCode?: WebmateErrorCode,
    refusal?: ExtensionRefusal,
  ) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
    this.code = code;
    this.webmateCode = webmateCode;
    this.refusal = refusal;
  }
}
