# AgentX WebMate MCP Server

Give [AgentX Workmate](https://github.com/TrungKiencding/AgentX-Workmate) — or any other MCP client (Claude Code, Codex, Cursor) — the ability to run tasks in **your real browser session**: already signed in, cookies present, MFA already passed.

That session is the whole point. A headless automation framework starts logged out of everything and hits a login wall on the first useful page. AgentX WebMate is already inside the browser you use.

```
AgentX Workmate ──stdio──▶ agentx-webmate-mcp ──ws://127.0.0.1:17374──▶ AgentX WebMate extension ──▶ your tabs
```

## Install

### AgentX Workmate (recommended)

Workmate ships this server as one bundled file and installs the extension
itself — see [`docs/workmate-integration.md`](../docs/workmate-integration.md)
for the whole contract (folder layout, `workmate.json`, `pairing.json`,
`state.json`, command files, the signed `release.json` feed). From the CLI:

```bash
agentx mcp install webmate
```

This copies the bundled server into `~/.agentx/mcp-installs/webmate/` (no git,
no npm — the catalog entry is `install.type: bundled`) and writes an
`mcp_servers.webmate` block into the profile's `config.yaml`, launched with the
Node.js Workmate manages. Start a new session (or run `/reload-mcp`) and the six
tools appear as `mcp__webmate__webmate_run`, `mcp__webmate__webmate_extract`, and
so on. The bundled `webmate` skill teaches the agent when to reach for them
instead of its own headless `browser_*` tools.

### From a checkout (development)

```bash
cd mcp-server && npm ci && npm run build
agentx mcp add webmate --command node --args "$PWD/dist/index.js"
```

### Drop-in skill package (Workmate, Claude Code, and other MCP hosts)

`npm run build:skill` produces **one** host-neutral package with this server
bundled into **one file** (`scripts/<brand>-mcp.mjs`, ~400 KB, needs only
Node.js ≥ 20 — no clone, no npm):

- `release/<slug>-skill-<version>.zip` — unzip into your agent's skills directory
  and run `scripts/setup.py` once.

**AgentX Workmate / Hermes**

```bash
unzip agentx-webmate-skill-1.0.0.zip -d "${AGENTX_HOME:-$HOME/.agentx}/skills/autonomous-ai-agents/"
python3 "${AGENTX_HOME:-$HOME/.agentx}/skills/autonomous-ai-agents/webmate/scripts/setup.py"
```

**Claude Code**

```bash
unzip agentx-webmate-skill-1.0.0.zip -d ~/.claude/skills/
python3 ~/.claude/skills/webmate/scripts/setup.py
```

`setup.py` auto-detects every MCP host on the machine and registers with each one
it finds — Workmate (`mcp_servers.<name>` in the profile's `config.yaml` via the
Workmate Python API, the `agentx` CLI, or a backed-up direct edit), Claude Code
(`claude mcp add --transport stdio --scope user …`), and optionally any host that
reads `mcpServers` JSON (`--project DIR` writes `DIR/.mcp.json`). It also prints
a generic `mcpServers` block for Codex, Cursor, and other clients. Use
`--host workmate|claude|mcp-json` to target one host, `--home PROFILE_DIR` for a
specific Workmate profile, and `--dry-run` to preview. Reload: Workmate
`/reload-mcp` or a new session; Claude Code restart or `/mcp`. Health check:
`python3 scripts/check_bridge.py`.

The skill folder is trusted by Workmate's skill loader; only registry installs
are scanned, and a 400 KB bundle would trip that scanner's size limit — so ship
the zip, not a registry listing.

### Other MCP clients

**Claude Code**

```bash
claude mcp add --transport stdio webmate -- node /path/to/agentx-webmate/mcp-server/dist/index.js
```

**Codex / Cursor / anything reading `mcp.json`**

```json
{
  "mcpServers": {
    "webmate": {
      "command": "node",
      "args": ["/path/to/agentx-webmate/mcp-server/dist/index.js"]
    }
  }
}
```

The MCP client launches this command as a child process when it starts the
configured server; you do not need to keep a second copy running in a terminal.
After adding the configuration, restart or reconnect the MCP client if the
WebMate tools do not appear in its tool list.

## Connect the browser

> **Chromium only.** Chrome, Edge, Brave, Opera, Vivaldi. The bridge runs from the extension's **offscreen document**, and the Firefox build has none — `cloud-bridge.js` and `cloud-runs.js` live only under `src/chrome/`. See [`src/firefox/ARCHITECTURE.md`](../src/firefox/ARCHITECTURE.md).

The MCP server hosts the listener; the extension dials out to it. A Manifest V3 extension cannot listen on a socket, so the direction is fixed.

1. Install the AgentX WebMate extension (load `brand-dist/chrome` from a checkout, or the store build) and open your browser.
2. Nothing to configure: the bridge ships **enabled** and pointed at `ws://127.0.0.1:17374/extension`, which is this server's port. The status line under **AgentX WebMate → Settings → General → Advanced → Cloud bridge** reads **Connected** once the MCP server is running.
3. Ask your MCP client to call `webmate_connection` to confirm.

If a profile was pointed somewhere else, or the bridge was switched off, both live in that same Settings panel.

> **One bridge at a time.** The extension holds exactly one outbound bridge socket. The shipped default points it here, which means it is *not* pointed at the WebMate Cloud sidecar (`17373`) or the LM Studio plugin (`17375`). Switch it under **Settings → General → Advanced → Cloud bridge**.

### What keeps it attached

The extension dials out and retries with a backoff that tops out at 10 seconds, so
restarting this server reattaches the browser within seconds — no click needed.
That socket lives in the extension's offscreen document; if the browser tears
that document down, a once-a-minute alarm in the extension's service worker
rebuilds it. On this side, the listener pings the extension every 15 seconds and
hangs up on one that stops answering, so a browser that disappeared without
closing its connection is reported as detached instead of timing out every
command. A command issued while the browser is still mid-backoff waits up to
`WEBMATE_CONNECT_GRACE_MS` (12s) rather than failing immediately.

## Launch manually

For a direct launch or connection test, run:

```bash
node mcp-server/dist/index.js
```

Leave that terminal open while using the bridge. The server owns the local
listener on `127.0.0.1:17374`, and exiting it closes the bridge. Press `Ctrl+C`
to stop it. (`npm start` inside `mcp-server/` does the same thing.)

## Troubleshooting

**Connection error: WebSocket error** normally means that no process is
listening at the URL selected in WebMate. Confirm the MCP server is still
running and that Settings uses port `17374`, then check the listener:

```bash
lsof -nP -iTCP:17374 -sTCP:LISTEN
```

No output means the MCP server is not listening. Remember that an MCP host only
starts the server for the duration of a session: with Workmate, the listener
exists while a Workmate session (CLI, TUI, gateway) is running. If it is
listening but the extension does not connect, make sure another bridge
destination is not selected: WebMate Cloud uses `17373`, this MCP server uses
`17374`, and the LM Studio plugin uses `17375`. Only one can be selected at a
time. The bridge is available in Chromium browsers only, not Firefox.

Inside Workmate, `agentx mcp test webmate` spawns the server and lists its tools
without starting a chat session.

## Branding

> This README uses the `main` branch's names as the worked example: product
> **AgentX WebMate**, tools `webmate_*`, host-side `mcp__webmate__webmate_*`,
> bundle `agentx-webmate-mcp.mjs`, env `WEBMATE_*`. On the `netmind-extension`
> branch the same code builds as **netMind Extension** with `netmind_*`,
> `mcp__netmind__netmind_*`, `netmind-mcp.mjs`, `NETMIND_*` — substitute
> accordingly; nothing else differs.

Every user-visible name — server name, tool prefix, product name in messages,
`<PREFIX>_*` env vars, skill and bundle file names — is derived at build time
from the repo's [`brand/brand.config.json`](../brand/brand.config.json) by
[`scripts/brand.mjs`](scripts/brand.mjs) into the git-ignored
`src/brand.generated.ts` (`npm run build` regenerates it). A brand branch such
as `netmind-extension` therefore changes only its config: `product.shortName`
gives the tool prefix (`netmind_*`), and an optional `mcp` block overrides the
rest (`serverName`, `envPrefix`, `skillName`, `packageName`).

## Tools

| Tool | Purpose |
|---|---|
| `webmate_run` | Delegate a task. `mode='ask'` is read-only; `mode='act'` can click and type, gated by in-browser approval. |
| `webmate_extract` | Read authenticated page data into a caller-supplied JSON Schema. Always runs in read-only Ask mode. |
| `webmate_status` | Poll a run, or list every run. |
| `webmate_respond` | Answer a run sitting at `needs_user_input`. Permission requests accept exactly `once`, `always` or `deny`; anything else is rejected before it reaches the browser. |
| `webmate_abort` | Stop a run. Actions already taken are not undone. |
| `webmate_connection` | Report whether the extension is attached, and how to fix it if not. |

Hosts namespace these by server: in Workmate and Claude Code they appear as
`mcp__webmate__webmate_run` and friends.

### Permission requests

In Act mode, the first consequential action on a host (navigate, click, type,
download, …) pauses the run as `needs_user_input`. The status text reads
`PERMISSION REQUEST — AgentX WebMate wants to navigate to youtube.com` and
lists the accepted answers: `once` (this time), `always` (remember for that
host), `deny`. Send one of those exactly with `webmate_respond`. The server
refuses free text such as "yes" or "có" because the browser's gate fails closed
and would read it as deny. If the WebMate side panel is open on that tab, the
same request is shown there and can be answered in either place.

### Example

> "Open my Stripe dashboard and list last week's failed payments."

```
webmate_run(task: "open the Stripe dashboard and list last week's failed
            payments with amounts and customer emails", mode: "ask")
```

Read-only, in the tab you are already authenticated in. No API key, no headless login dance.

For predictable JSON instead of prose, give `webmate_extract` an explicit
JSON Schema:

```
webmate_extract(
  task: "list the overdue invoices visible in this account",
  output_schema: {
    type: "object",
    properties: {
      invoices: {
        type: "array",
        items: {
          type: "object",
          properties: {
            customer: { type: "string" },
            amount: { type: "number" },
            due_date: { type: "string" }
          },
          required: ["customer", "amount", "due_date"]
        }
      }
    },
    required: ["invoices"]
  }
)
```

This is still a task-level delegation through the browser agent and its normal
permission boundary; it is not a direct page-scraping primitive.

## Why six task-level tools and not 50 browser primitives

AgentX WebMate exposes roughly fifty primitives internally — `click_ax`, `type_ax`, `extract_data`, `iframe_read` and so on. This server deliberately does **not** surface them.

**Safety.** The capability × origin permission gate runs in the agent loop (`_executeToolBatch`), not inside `executeTool()`. An MCP layer calling primitives directly would sit *below* the gate and bypass every approval prompt the product is built on. Delegating a goal keeps the trust boundary in the browser, where the human is.

**Cost.** Driving a UI one primitive at a time over a socket costs a round trip and a slab of tokens per click. Handing over a goal costs one call.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `WEBMATE_BRIDGE_PORT` | `17374` | Port the extension connects to. |
| `WEBMATE_CONNECT_GRACE_MS` | `12000` | How long a command waits for a browser that is mid-reconnect before reporting "not connected". |
| `WEBMATE_CONNECT_PROBE_MS` | `2000` | Same wait for the `connection` diagnostic, kept short so it answers fast. |
| `WEBMATE_HEARTBEAT_INTERVAL_MS` | `15000` | WebSocket ping interval; two missed pongs drop the socket. `0` disables. |
| `WEBMATE_BRIDGE_PATH` | `/extension` | Path segment; must match the URL in Settings. |
| `WEBMATE_COMMAND_TIMEOUT_MS` | `30000` | Per-command reply timeout. |
| `WEBMATE_RUN_TIMEOUT_MS` | `300000` | Default ceiling for `webmate_run` polling. |
| `WEBMATE_POLL_INTERVAL_MS` | `1000` | Status poll interval. |
| `WEBMATE_DIR` | `<AgentX root>/webmate` | Workmate's machine-level WebMate folder (extension, pairing, state, commands). Default: `AGENTX_HOME` with `accounts/<slug>` / `profiles/<name>` stripped, else `~/.agentx` (`%LOCALAPPDATA%\agentx` on Windows). |
| `WEBMATE_PAIRING_FILE` | `<dir>/pairing.json` | Pairing token written by Workmate. Present ⇒ hello must be v3 and carry the token. |
| `WEBMATE_STATE_FILE` | `<dir>/state.json` | Bridge state published for Workmate; `off` disables the writer. |
| `WEBMATE_COMMANDS_DIR` | `<dir>/commands` | Command files from Workmate (`prepare_update`, `reload`, `resume`); `off` disables the watcher. |
| `WEBMATE_PREPARE_UPDATE_TIMEOUT_MS` | `60000` | How long `prepare_update` waits for in-flight runs to finish. |
| `WEBMATE_BRIDGE_PRIORITY` | `100` under Workmate's desktop app, else `0` | Claim on the bridge port when several copies of this server run at once; a copy that outranks the holder is handed the port (see below). |
| `WEBMATE_BIND_RETRY_MS` | `5000` | How often a copy that can neither hold the port nor relay through its holder tries the port again. |
| `WEBMATE_HANDOFF_DRAIN_MS` | `5000` | How long a copy handing the port over lets Workmate commands and in-flight commands finish. |
| `WEBMATE_HANDOFF_TIMEOUT_MS` | `5000` | How long it then waits for the new holder to confirm before taking the port back. |
| `AGENTX_MCP_HOST` | set by AgentX | Which AgentX process runs this copy (`desktop`, `gateway`, …). Named in logs and `state.json`; `desktop` sets the default priority to 100. |

Each variable also accepts the upstream `WEBBRAIN_*` spelling; when both are
set, `WEBMATE_*` wins.

## Workmate pairing, state and commands

When AgentX Workmate installed the extension, `<dir>/pairing.json` exists and
the bridge runs **paired**: every `hello` must speak protocol v3 and carry the
token Workmate also wrote into the extension's `workmate.json`; the server
echoes the token in `hello_ack` so the extension can tell a Workmate server
from any other local process on the port. Without the file the server behaves
exactly as before (v2 hellos, no token) — that is a developer checkout or a
store install. A present but unreadable file rejects every handshake rather
than falling back to unauthenticated mode.

The server publishes `state.json` (`listening`, `connected`, `browser`,
`extensionVersion`, `installType`, `signedIn`, `protocolVersion`, `error`,
`lastCommand`) through a temp file and rename on every change, and consumes
`commands/<uuid>.json` files: `prepare_update` asks the extension to drain
(no new runs) and polls until it reports idle, `reload` restarts it, `resume`
lifts a drain. Only the copy that holds the port writes or consumes these; a
standby (below) stays silent, and a copy that is handed the port takes both
over. `state.json` also names the holder's `host` and `priority` and the
`standbys` relaying through it.

## Several copies of the server at once

The extension dials one port, so one process holds it: the **owner**. AgentX
runs a copy of this server in every process that loads MCP tools — the
Workmate desktop app's backend, the messaging gateway (which outlives the app
on purpose), slash-command workers — so the others are **standbys**: each
connects to the owner on `ws://127.0.0.1:<port>/peer` and relays its commands
through it, and every host's tools keep working. `webmate_connection` says
which copy holds the port when it relays.

- **Priority decides the owner.** A standby that outranks the owner
  (`WEBMATE_BRIDGE_PRIORITY`; 100 when AgentX marks the copy
  `AGENTX_MCP_HOST=desktop`, else 0) is handed the port: the owner finishes
  Workmate commands it already picked up, closes its listener (open sockets
  stay up), waits for the newcomer to bind, lets commands in flight finish,
  then releases the extension with close code 1012 — it redials at once and
  lands on the new owner. If the newcomer never confirms, the owner takes the
  port back. Equal priorities keep whoever came first.
- **When the owner leaves**, its standbys learn it at once from their peer
  socket and one of them takes the port; the extension follows within a
  second.
- **Relaying needs the Workmate pairing.** The peer socket carries the same
  authority as the extension socket, so the owner accepts it only from a
  native client (no `Origin` header) whose hello carries `pairing.json`'s
  token, and only the four run-level commands travel through it. Without a
  pairing file a standby does not relay: its tools report
  `WEBMATE_PORT_IN_USE` and it tries the port again every
  `WEBMATE_BIND_RETRY_MS`.
- **Older servers** (1.2.x) cannot relay or hand over; a standby names them
  in its error. The desktop app's copy asks one to exit only when it is this
  server's own bundle running under AgentX's stdio watchdog, whose host starts
  it again from the current bundle — nothing else is ever signalled.

Every failing tool result starts with a structured code and repeats it as
`structuredContent.code`, so Workmate can react without parsing prose:
`WEBMATE_NOT_INSTALLED`, `WEBMATE_NOT_CONNECTED`, `WEBMATE_OUTDATED`,
`WEBMATE_NOT_SIGNED_IN`, `WEBMATE_PORT_IN_USE` (`WEBMATE_DISABLED` is raised by
Workmate itself). `webmate_connection` additionally reports the extension's
version, browser, install type and sign-in state.

## Security notes

- The listener binds `127.0.0.1` only. Anything that can reach this port can drive your signed-in browser — never expose it to a network or a container bridge.
- Connections from HTTP(S) pages and other non-extension browser origins are rejected before they can replace the extension socket. Accepted connections must also present the extension's `hello` frame with `client: "webbrain-extension"` (the wire identifier inherited from upstream; the brand build keeps protocol tokens unchanged); anything else is closed. On its own this is **not** authentication: a developer or store install sends no shared secret, so a local process could impersonate it, and the port must be treated as trusted-local — see [`docs/security-model.md`](../docs/security-model.md). A Workmate install adds the pairing token in both directions (`hello.token`, `hello_ack.token`), which closes that gap for the extension folder Workmate manages.
- A `webmate_run` timeout does **not** abort the run. A task that already submitted a form should not be silently killed — the browser keeps going and `webmate_status` picks it back up.
- `allow_api_mutations` lifts the UI-first rule and is off by default. It is accepted only with `mode: "act"`; Ask runs remain read-only. The UI path is visible and stoppable; direct API mutations are neither.
- Act-mode permission requests pause the run as `needs_user_input` and are answered with exactly `once`, `always` or `deny`. The extension's gate fails closed — any other text is a denial — so `webmate_respond` refuses non-matching answers before they reach the browser. `always` persists a grant for that host; prefer `once` unless the user asked for more.

## Tests

```bash
npm test
```

The suite stands up the real listener and connects a fake extension speaking the exact frames `src/chrome/src/offscreen/cloud-bridge.js` emits — handshake (v2 and paired v3, `hello_ack`, token and protocol refusals), id correlation under concurrency, error propagation, disconnect mid-command, the poll/timeout/clarify paths, `state.json` and the command files — then spawns the built server over stdio and checks the advertised catalog and structured error codes. If the extension's wire format changes, these fail. That is intentional.

## License

MIT. This package is part of AgentX WebMate, a branded build of
[WebBrain](https://github.com/webbrain-one/webbrain) (MIT).
