# AgentX Workmate integration contract

How AgentX Workmate installs, pairs with, and updates this extension without a
browser store. Workmate's side of the contract lives in
`apps/desktop/electron/webmate/` and `hermes_cli/` of the Workmate repository;
this page is the single place both sides are written down.

## Files on the user's machine

Everything sits in one machine-level folder — `<AgentX root>/webmate/`, which is
`~/.agentx/webmate/` on macOS/Linux and `%LOCALAPPDATA%\agentx\webmate\` on
Windows. It is *not* under `accounts/<slug>/`: the extension belongs to the
machine, not to a signed-in account. Deleting the folder removes every trace.

| Path | Written by | Purpose |
|---|---|---|
| `AgentX WebMate/` | Workmate | The unpacked extension folder the browser is pointed at (contents of `agentx-webmate-chrome-<ver>.zip`). The name never changes because Chrome stores the absolute path; versions are swapped by two renames. |
| `AgentX WebMate/workmate.json` | Workmate | Read by the extension before every dial (see below). |
| `pairing.json` | Workmate (0600) | The pairing token the MCP server checks against `hello.token`. |
| `state.json` | MCP server | What the bridge knows: listening, connected, browser, extension version, sign-in, last command outcome. Temp + rename; Workmate watches it. |
| `commands/<uuid>.json` | Workmate | One command per file for the running server (`prepare_update`, `reload`, `resume`); consumed on pick-up. |
| `versions/<ver>/`, `versions/prev/` | Workmate | Staging for the next version and the previous one (rollback). |
| `update-check.json` | Workmate | Cache of the last feed check, including any version waiting for the browser to close. |

The MCP server resolves the folder as `WEBMATE_DIR` (Workmate sets it when it
registers the server) → `AGENTX_HOME` with the `accounts/<slug>` and
`profiles/<name>` layers stripped → the platform default.

## `workmate.json`

```json
{ "schema": 1, "wsUrl": "ws://127.0.0.1:17374/extension", "token": "<base64, 32 bytes>",
  "installId": "<uuid>", "workmateVersion": "0.21.0", "minServerVersion": "1.1.0" }
```

`src/chrome/src/offscreen/cloud-bridge.js` fetches it with
`chrome.runtime.getURL('workmate.json')` before every dial. Missing file ⇒
developer/store install: the Settings URL is used, no token is sent, and the
server's `hello_ack` is accepted with any token. Present ⇒ `wsUrl` must pass the
same loopback check as the Settings URL (else the Settings URL is used and the
error is shown in the status line), the token is sent, and a `hello_ack` whose
`token` differs closes the socket with a sixty-second hold-off.

## `pairing.json`

```json
{ "schema": 1, "token": "<same token>", "port": 17374, "installId": "<uuid>", "createdAt": "<ISO>" }
```

Read by the MCP server on every handshake (`WEBMATE_PAIRING_FILE` overrides the
path). Present ⇒ `hello.protocolVersion ≥ 3` and `hello.token === token` are
required; anything else is closed with code 1008 and a reason. Absent ⇒ the
pre-Workmate behaviour: v2 hellos accepted, no token. A present but unreadable
file rejects every handshake — it never degrades to "no authentication".

## Bridge protocol v3

```json
{ "type": "hello", "client": "webbrain-extension", "protocolVersion": 3,
  "version": "1.0.4", "browser": "Chrome 152", "installType": "workmate",
  "token": "<from workmate.json, absent in dev>", "signedIn": true,
  "capabilities": ["saved_workflows_v1", "run_modes_v1", "scheduled_jobs_v1", "workmate_update_v1"],
  "status": { … } }
```

`client` is the upstream wire identifier and must not change. `browser` comes
from `navigator.userAgentData.brands` (UA string fallback). `signedIn` reflects
the AgentX session in `chrome.storage.local`; `null` when storage cannot answer.

The server replies once per socket:

```json
{ "type": "hello_ack", "serverVersion": "1.1.0", "protocolVersion": 3,
  "token": "<echo of the pairing token, or null>", "minExtensionVersion": "1.0.4", "minProtocol": 3 }
```

While an accepted extension is attached, a second connection to the same port
is *held* until its own hello passes the same checks; only then does it take
over (the first socket is closed with 1000 "Superseded"). A rejected hello
(v2, wrong token, unknown client) or ten seconds of silence closes the newcomer
alone. So a developer checkout, a store copy, or the person's own browser once a
Workmate window exists can dial 17374 all day without knocking the
Workmate-installed copy off — before this rule the merely-connected newcomer
superseded first and was refused second, and `state.json.connected` flapped
every few seconds on a machine that had both. While nothing has completed a
handshake, the latest connection still wins, as before.

Two bridge actions were added for updates (`ALLOWED_BRIDGE_ACTIONS` in the
extension, `BridgeAction` in the server):

- `workmate_prepare_update` → the extension stops accepting new runs (503
  "about to update") and answers `{ ok: true, draining: true, busy: <n> }`. Idempotent;
  `{ resume: true }` lifts the drain. The drain also clears itself after five
  minutes so a Workmate that dies mid-update cannot wedge the browser.
- `workmate_reload` → answers `{ ok: true }` and calls `chrome.runtime.reload()`
  250 ms later, after the ack has crossed the socket.

  Verified on Chrome 152: for an extension the user loaded through
  `chrome://extensions` the reload happens in place and the extension re-dials
  within seconds. For an extension loaded through CDP `Extensions.loadUnpacked`
  (the phase-3 "Workmate browser window", and `test/workmate-install-e2e.mjs`)
  the reload **unloads it for good** — no service worker, no targets afterwards.
  That mode must call `Extensions.loadUnpacked` again after swapping the folder
  instead of relying on the reload; the ID stays the same because of the
  manifest `key`.

## `state.json`

```json
{ "schema": 1, "pid": 4242, "port": 17374, "serverVersion": "1.1.0",
  "listening": true, "connected": true, "pairingRequired": true,
  "browser": "Chrome 152", "extensionVersion": "1.0.4", "installType": "workmate",
  "signedIn": true, "protocolVersion": 3, "lastHelloAt": "<ISO>", "error": null,
  "lastCommand": { "id": "<uuid>", "action": "prepare_update", "ok": true, "busy": 0,
                   "error": null, "startedAt": "<ISO>", "finishedAt": "<ISO>" },
  "updatedAt": "<ISO>" }
```

Written only by the process that holds the port. A reader that sees
`listening: true` with a dead `pid` is looking at a force-quit server's last
words. Since server 1.3.0 the file also carries `host` (the AgentX process
running the holder, from `AGENTX_MCP_HOST`: `desktop`, `gateway`, …),
`priority`, and `standbys: [{pid, host, priority}]` — the other copies of the
server relaying through the holder.

## Several copies of the server (1.3.0)

AgentX runs one copy of the MCP server per process that loads MCP tools: the
desktop backend, the messaging gateway (detached, so it outlives the app), slash
workers. The copy that holds the port is the owner; every other copy connects
to it on `ws://127.0.0.1:17374/peer` with a `peer_hello` carrying the pairing
token, and relays `cloud_run` / `cloud_status` / `cloud_respond` /
`cloud_abort` through it (`mcp-server/src/peer.ts` has the frames). The
desktop's copy (`AGENTX_MCP_HOST=desktop`, priority 100) outranks the rest:
when it joins an owner of lower priority, that owner finishes the Workmate
commands it already picked up, stops listening, waits for the desktop's copy to
bind, drains in-flight commands and releases the extension with close code
1012 — the extension redials at once and lands on the desktop's copy, which
from then on writes `state.json` and consumes `commands/`. When the owner exits,
a standby takes the port. Without `pairing.json` nothing relays and a standby
retries the port every `WEBMATE_BIND_RETRY_MS`.

## Commands

Workmate writes `commands/<uuid>.json` (temp + rename):

```json
{ "id": "<uuid>", "action": "prepare_update" | "reload" | "resume" }
```

The server deletes the file on pick-up, runs the action, and records the
outcome as `state.json.lastCommand`. `prepare_update` polls the extension until
`busy` reaches 0 or `WEBMATE_PREPARE_UPDATE_TIMEOUT_MS` (60 s) passes; with no
extension attached it reports `ok: false, error: "WEBMATE_NOT_CONNECTED"`, which
Workmate reads as "browser closed — swap the folder now".

## Structured error codes

Every failing tool result starts with one of these and repeats it as
`structuredContent.code`:

`WEBMATE_NOT_INSTALLED` (pairing configured, no extension folder) ·
`WEBMATE_NOT_CONNECTED` · `WEBMATE_OUTDATED` · `WEBMATE_NOT_SIGNED_IN`
(extension refused the run for lack of a model, or `hello.signedIn` is false) ·
`WEBMATE_PORT_IN_USE`. `WEBMATE_DISABLED` is raised by Workmate itself when the
server is switched off.

## Extension ID

`brand/brand.config.json` → `manifestOverrides.chrome.key` pins the ID
(`product.extensionId`, currently `pfadeibckkgklmmjghiikadphihbpape`) so it is
the same whether the folder is loaded from `~/.agentx/webmate/AgentX WebMate`,
a checkout's `brand-dist/chrome`, or a store. Workmate reads
`extensions.settings[<id>]` in the browser profile's `Secure Preferences` to
tell "installed", "installed but disabled" and "not installed" apart.
`minimum_chrome_version` is 121 — the first Chrome without the developer-mode
nag bubble. The private half of the key stays outside the repository
(`~/.agentx/webmate-keys/manifest-key.pem` on the maintainer's machine); a key
that does not match `product.extensionId` fails `npm run brand:build`.

## Update feed — `release.json`

```json
{ "schema": 1, "version": "1.0.4", "publishedAt": "<ISO>",
  "chrome": { "url": "https://github.com/astralxkienlt/agentx-webmate/releases/download/v1.0.4/agentx-webmate-chrome-1.0.4.zip",
              "sha256": "<hex>", "bytes": 5230000 },
  "minWorkmate": "0.21.0", "minProtocol": 3,
  "notes": { "vi": "…", "en": "…" },
  "signature": "ed25519:<base64>" }
```

`scripts/build-zip.mjs` writes the unsigned document to `dist/release.json`
(sha256 and size from the Chrome zip, floor from `brand.config.json`
`workmate`, notes from the version's CHANGELOG section);
`scripts/sign-release.mjs` signs it with the Ed25519 key in the
`WEBMATE_RELEASE_SIGNING_KEY` secret and checks the result against
`scripts/release-signing-key.pub.pem`, the public key compiled into Workmate.
The signature covers the canonical JSON (sorted keys, no whitespace) of every
field except `signature`. Both release workflows commit the signed file to
`dist/release.json` and `release.json` at the repository root, and attach it to
the GitHub Release; Workmate polls
`https://raw.githubusercontent.com/astralxkienlt/agentx-webmate/main/release.json`.

Workmate installs a release only when the sha256 matches the zip and the
signature verifies. There is no "install anyway" button.

## Signed in together (phase 4)

Workmate signs the person in to AgentX in a browser, then installs this
extension into the same browser — and the side panel should not ask them to
sign in again. Three pieces make that hold:

**`auth_hint` / `auth_open` bridge actions.** Both are in the extension's
`ALLOWED_BRIDGE_ACTIONS` and the server's `BridgeAction`, and both are
answered by `src/agentx/workmate-auth.js` in the background:

- `auth_hint { loginHint }` runs an authorize request with `prompt=none` and
  `login_hint=<email>` through `chrome.identity.launchWebAuthFlow`
  (`interactive: false`, redirect `https://<extension id>.chromiumapp.org/`,
  PKCE). It succeeds only when the profile already holds a Keycloak SSO
  session for the account; it then provisions the gateway key exactly as the
  panel's sign-in does. Answers: `{ ok: true, outcome: "signed-in" |
  "already-signed-in" | "login-required", signedIn, email?, code?, message? }`
  (a failure carries `ok: false, outcome: "error", code, message` — the code
  is never sent as `error`, which the offscreen bridge reserves for protocol
  failures); a
  `login-required` answer is held for sixty seconds so a retrying Workmate
  does not spin the identity flow. `{ ok: false, outcome: "unsupported" }`
  means no `chrome.identity` (the Firefox build, an old Chrome).
- `auth_open { loginHint }` starts the interactive sign-in (a tab on
  Keycloak, loopback redirect, the same flow as the panel's button) with the
  email pre-filled and answers `{ ok: true, outcome: "opened" }` as soon as
  the tab is up — the person may take minutes, so the end of it reaches
  Workmate through the `session` frame below, not through this reply
  (`in-progress` while a tab is already open; `already-signed-in` when the
  panel is signed in as that account). The key is installed when the flow
  ends.

The Chrome manifest gains the `identity` permission for this
(`manifestOverrides.chrome.addPermissions`, a union with the upstream list —
Firefox gets none). **The Keycloak client `agentx-workmate` must list
`https://pfadeibckkgklmmjghiikadphihbpape.chromiumapp.org/*` among its Valid
Redirect URIs**, or Keycloak answers `invalid_request` and the silent path
degrades to `login-required` (the interactive sign-in and everything else keep
working).

**Several browsers on one server.** A v3 hello may carry `instanceId`, a
random id minted once per browser profile (`WORKMATE_INSTANCE_ID_KEY` in
chrome.storage.local). The server keeps every socket whose hello passed,
keyed by that id (a per-socket id when an older extension sends none), so the
person's own browser and the Workmate browser window attach side by side
instead of superseding each other every few seconds. A reconnect from the
same instance replaces only its own previous socket. Commands go to the
browser that owns the run they name (learned from `cloud_run`, `cloud_status`
lists, `cloud_respond`, `cloud_abort` replies), else to the *active* one:
signed in first, then the most recent hello. `webmate_connection` lists every
attached browser; `webmate_status` without a run id lists runs from all of
them.

**`session` frames.** The background watches the AgentX session record and
relays a change to the offscreen bridge (`cloud-bridge-session`), which sends
`{ "type": "session", "signedIn": true | false }` on its open socket. The
server updates that connection's `signedIn` in place — so after a sign-in
through the panel, through `auth_hint`, or a sign-out, `state.json` and
`webmate_connection` are right without a reconnect.

`state.json` gains `instanceId` (of the active connection) and
`connections: [{ instanceId, browser, extensionVersion, installType,
signedIn, protocolVersion, lastHelloAt, paired, active }]`; the top-level
fields keep describing the active connection for readers that know one
extension. Two more command files exist:

```json
{ "id": "<uuid>", "action": "auth_hint", "payload": { "loginHint": "<email>", "instanceId"?: "<id>", "force"?: true } }
{ "id": "<uuid>", "action": "auth_open", "payload": { "loginHint": "<email>", "instanceId"?: "<id>" } }
```

`auth_hint` asks every attached browser nobody is signed in to (or the one
named); `auth_open` opens one interactive sign-in in the named browser, else
the active one. The outcome lands in `lastCommand` with `results: [{
instanceId, browser, ok, outcome, signedIn, email?, error?, message? }]` and
`signedIn` (any browser signed in). A browser that answered "signed in" is
marked so at once. `WEBMATE_AUTH_TIMEOUT_MS` (90 s) bounds one browser's
answer.

The side panel's sign-in gate arms its storage listener from the start, so a
panel sitting on "Đăng nhập để bắt đầu" unlocks by itself when the background
signs in.

## Developer checkout

Nothing changes for a `brand-dist/chrome` load: no `workmate.json`, so the
Settings URL and no token; `node mcp-server/dist/index.js` without a
`pairing.json` accepts the v3 hello exactly as it accepted v2. The server does
write `state.json` into `<AgentX root>/webmate/` — set `WEBMATE_STATE_FILE=off`
(and `WEBMATE_COMMANDS_DIR=off`) to keep a scratch server out of it.

**Once Workmate has run on the machine** it has written
`<AgentX root>/webmate/pairing.json`, and every server that resolves that
folder — including a checkout's `dist/index.js` that a Workmate account config
points at — runs paired and rejects a `brand-dist/chrome` load with
"Bridge protocol v3 required / Pairing token mismatch". To keep developing
against the dev build, copy the machine's
`<AgentX root>/webmate/AgentX WebMate/workmate.json` into `brand-dist/chrome/`
and Reload the extension: `brand:build` preserves that file across rebuilds and
`build:zip` refuses to package a tree that contains it. Delete it (or
`pairing.json`) to go back to unpaired dev mode. Every test that spawns or
constructs the server sets `WEBMATE_DIR` to a scratch directory for the same
reason.

Tests: `npm test` (extension side: `test/run.js` offscreen-bridge cases,
`test/workmate-install.test.mjs`, `test/agentx-auth.test.mjs` for the silent
sign-in and the Workmate hooks), `cd mcp-server && npm test` (server side:
`test/pairing.test.mjs`, `test/commands.test.mjs`, `test/bridge-multi.test.mjs`
for several browsers at once), and the opt-in real-Chrome
acceptance run `node test/workmate-install-e2e.mjs` (loads brand-dist/chrome
into a throwaway profile on port 17398 and walks dev mode, pairing, token
mismatch, the update hooks and the stdio server).
