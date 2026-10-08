/**
 * Version facts the wire protocol carries.
 *
 * SERVER_VERSION must equal mcp-server/package.json "version" — a test pins
 * that. It is what `hello_ack.serverVersion` reports and what Workmate's
 * `workmate.json` `minServerVersion` is compared against on the extension
 * side.
 */
export const SERVER_VERSION = "1.4.0";

/**
 * Bridge protocol this server speaks. The extension announces its own number
 * in `hello`; v3 added the Workmate fields (version, browser, installType,
 * token, signedIn) and the `hello_ack` reply. Server 1.2.0 keeps v3 and adds
 * only optional pieces: `hello.instanceId`, the `session` frame, and the
 * `auth_hint` / `auth_open` actions — an extension without them still pairs.
 * Server 1.3.0 leaves the extension protocol alone; what it adds is between
 * copies of this server (the peer protocol, peer.ts PEER_PROTOCOL_VERSION).
 * Server 1.4.0 keeps both: it reads two optional fields of a failure frame —
 * the extension's own refusal `code` (EXTENSION_REFUSAL_CODES) and `license` —
 * and relays them between copies as a field 1.3.0 copies ignore.
 */
export const BRIDGE_PROTOCOL_VERSION = 3;

/**
 * The oldest protocol accepted from an extension when a Workmate pairing is
 * configured. Without a pairing file (developer checkout, store build) v2 is
 * still accepted so an older extension keeps working against a newer server.
 */
export const MIN_PAIRED_PROTOCOL_VERSION = 3;

/**
 * First extension release that speaks v3. Advisory only — sent in `hello_ack`
 * so Workmate can show "update WebMate"; the enforced check is the protocol
 * number, never the marketing version.
 */
export const MIN_EXTENSION_VERSION = "1.0.4";
