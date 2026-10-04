# Changelog

All notable changes to WebBrain are documented in this file.

This changelog was generated from the repository Git history and release tags. Versions without a Git tag are inferred from version-bump commits and the current `package.json` / browser manifest versions.

## [Unreleased]

### Added
- **Signed in to AgentX Workmate means signed in to WebMate, and several browsers can stay attached to one Workmate.** Two bridge actions answered by the new `src/agentx/workmate-auth.js`: `auth_hint` runs a `prompt=none` authorize through `chrome.identity.launchWebAuthFlow` (Chrome manifest gains `identity`; the redirect `https://<extension id>.chromiumapp.org/` must be registered on the Keycloak client) so a browser that already holds the Keycloak session from Workmate's own sign-in signs the extension in without a click and provisions its gateway key the way the panel does; `auth_open` opens the interactive sign-in with the account pre-filled. The side panel's sign-in gate now watches storage from the start, so a panel sitting on "Đăng nhập để bắt đầu" unlocks by itself when the background signs in. The MCP server (1.2.0) keeps every extension whose hello passed, keyed by a new per-profile `hello.instanceId`, instead of letting the newest valid hello supersede the rest — the person's own browser and the Workmate browser window no longer knock each other off — routes status/respond/abort back to the browser that owns the run, prefers a signed-in browser as the default target, lists them all in `webmate_connection`, and learns sign-in changes live from a new `session` frame the background relays after any session change. `state.json` gains `instanceId` and `connections[]`; `auth_hint` / `auth_open` join the command files Workmate can drop. Covered by `test/agentx-auth.test.mjs` (silent flow, login_required holdoff, gate unlock), `test/run.js` (offscreen relay, instance id), `test/workmate-install.test.mjs` (manifest union, background hooks) and `mcp-server/test/bridge-multi.test.mjs`.
- **Skills installed from the AgentX Skill Hub are read-only, and a copy that was changed behind the extension's back is put right.** Editing a hub skill in Settings used to demote it silently into custom text: it kept its name and place in the list, but from that moment the hub's updates — security fixes included — no longer reached it, and only a small badge said so. Now a hub record refuses the editor outright (`applySkillEdit` answers `locked`; the row shows View · Fork to edit · Remove instead of Edit · Remove, and both the Edit entry point and Save refuse with a message that names the way out). *Fork to edit* makes a plain-text copy of your own — same content, same place in the list, a `forkedFrom` note instead of a hub slug — after withdrawing this device's install rows from the hub, so the next sync does not put the original back; with the hub unreachable the fork is refused rather than left to be undone later, and installing from the hub again simply puts the hub record alongside your copy. Every hub record is also sealed with the SHA-256 of its stored content (`renderHash`), and every sync recomputes it: content that no longer matches was changed outside the extension (a storage edit, another extension, a bug), so the hub's copy replaces it and a "changed outside WebMate — restored from the hub" badge stays on the row for a week or until you act on that skill; if the hub cannot be reached at that moment the mismatching content is never loaded — it is set aside until the hub answers, and the hub is told why (`render_hash_mismatch`). Records installed before the seal existed are fetched once to gain it and are never treated as tampering; a copy you edited by hand before this change keeps working exactly as before and gains a *Restore hub version* button. On the wire, `getRender` now computes the hash of the bytes it received and checks it against the hub's new `X-AgentX-Render-Hash` (the package hash and signature cover the package the render was made from, not the render itself), refusing to install on a mismatch. Sixteen cases in `test/agentx-hub.test.mjs` cover the lock, the seal, the repair, the quarantine, the fork and the Settings wiring in both browser builds.
- **A delegated browser run now carries its own permission mode, so it no longer has to borrow the one the user picked for their own browsing.** The permission mode was a single standing choice read from storage, and one `Agent` instance serves the side panel and every run arriving over the cloud bridge — so a task delegated from AgentX Workmate (or any MCP client) ran at whatever the user had chosen for themselves. That left two bad ways to make a delegated task finish unattended: set the standing mode to Bypass permissions, which also strips the gate from the browsing the user does by hand, or have the caller answer the cards itself with `always`, which writes a real, persistent grant into that browser for a host the user never approved. The MCP server's run and extract tools now take `permission_mode` (`manual` | `auto` | `page_actions` | `bypass`), the browser applies it to that one run keyed by the run's tab, and it is restored — not deleted — when the run ends, so nothing outlives the run that asked for it. A run that names no mode still gets the standing one, a continuation inherits what its first leg was granted, and a value the browser does not recognise is refused with the accepted list rather than quietly narrowed to `manual` and leaving the caller to wonder why every action prompts. The default is `bypass`, because a card raised by a bridge run is answered by the caller that requested the action, so a narrower default spends a round trip per action to reach the same answer while pushing callers toward the `always` that leaves grants behind. Two things no mode changes: the untrusted-content wrapping and system-prompt contract are unaffected, and a page's own WebMCP callback keeps its mandatory confirmation.
- **The model switcher moved out of Settings into the chat composer.** Switching the gateway model used to mean leaving the conversation for Settings → Nhà cung cấp and finding the "Mô hình đang dùng" dropdown inside the provider card. The composer footer now carries a model chip in its right corner — the counterpart of the permission chip on the left, but deliberately quieter: a borderless text control showing just the current model's short name and a caret (vendor prefixes like `MiniMax/` are trimmed for the chip and dimmed in the menu, so `MiniMax-M3` carries the row), icon-free, sized to the permission pill via a transparent border and gaining only a soft fill on hover or while open — the permission chip stays a bordered control because it names a standing risk; the model is ambient state. It opens an upward menu of the active provider's whole catalog with the standing choice marked by the same rail-fill-check treatment as the permission ladder. Selection writes the provider's `model` through the same `update_provider` message the Settings card sends — one source of truth, confirmed by a toast — and a Settings page left open follows the switch live through storage instead of keeping the stale dropdown (and vice versa: a Settings change repaints the chip). The chip surfaces only while the active provider actually carries a model catalog (`config.models` — the managed cloud gateway after sign-in); providers configured by hand keep their model field in Settings and the footer stays clean. Menus coordinate (opening one closes the other), the menu measures its ceiling from the chip like the permission menu so a long catalog scrolls instead of clipping past the header, and both chips shrink with ellipsis so no panel width can make them collide or wrap — exercised against the real stylesheet at 280–480px, light and dark, LTR and RTL, with 1–12-model catalogs. State derivation lives in `src/ui/model-picker.js` as pure helpers, byte-identical across browsers and covered by unit tests; six new `sp.model.*` strings ship in all 23 locales for both builds.
- **The model menu says which model reads images.** Every gateway model is provisioned as multimodal, and the standing rule already was: with no dedicated vision model chosen, screenshots and image attachments go to the chat model itself. That rule was invisible — the only hint was a Settings dropdown's "use the active provider" placeholder. The menu now ends with a footnote naming the actual image route, answered by the background's own `getVisionProvider()` resolution through a new `get_vision_provider_status` message (no network, config only): "Ảnh và ảnh chụp màn hình cũng do chính mô hình này đọc" while the selection is the reader, or "…do {model} đọc" when a dedicated Cloud vision model is configured in Settings → Đa phương thức. The footnote refreshes on menu open and when the vision configuration changes, and says nothing rather than guessing when the probe fails. The Settings placeholder now spells the default out too ("Chưa chọn — mô hình đang chọn ở khung chat sẽ tự đọc ảnh"), and a manager-level test pins the contract end to end: switching the model via the chip's exact write keeps the catalog, credential and `supportsVision` intact, and with no sidecar configured `getVisionProvider()` stays null so the switched model is the one that sees images.
- **Enabled skills can now be edited in place.** Every row under Settings → Skills gains an Edit action that loads the skill into the form: the card switches to an editing banner with Save/Cancel (Esc cancels, Ctrl/Cmd+Enter saves), and the record keeps its id, creation time, and list position while tools and routing metadata are reparsed from the edited text. Provenance stays honest: editing a packaged skill — or changing the content of a URL-imported one — converts it into custom text with the same id, because packaged records are refreshed from the bundle at every background start and would silently revert the edit otherwise; a pure rename keeps URL provenance, and the form says so before you save. Deleting such an edited fork now writes the default's removal tombstone, so background seeding no longer resurrects a default the user already deleted — previously the tombstone was only written for records still marked built-in.
- **Skills import from `.md` files.** A file button next to the URL import accepts `.md` / `.markdown` / `.txt` — several at once — and the whole skills card is a drop target with a visible highlight (the dragover is always cancelled, so a stray drop can no longer navigate the settings page to the file). Names resolve from the typed name, then Agent Skills frontmatter or the first Markdown heading, then the cleaned file name; per-file failures (unsupported type, over the 500 KB import cap, unreadable, empty) are reported without aborting the rest of the batch.
- **The skill form previews what a draft will be saved as.** A live panel under the textarea shows the name, summary, modes, intents, and declared tools the current text parses to — a malformed `webbrain-skill` fence now shows up as Act-only defaults *before* saving instead of after — plus a character counter that flags text beyond the 20,000-character cap, which used to be truncated silently. The raw-text box itself became a monospace editor that auto-fits its content — about ten lines when empty, growing to ~60% of the window for a long skill (packaged ones run to 14k characters) and shrinking back as text is removed — instead of a fixed ten-line slot. The edit/demotion rules live in `agent/skills.js` as pure helpers (`applySkillEdit`, `describeSkillDraft`, file-name helpers) covered by unit tests in both browser builds, and the redesigned form was exercised end-to-end in a real browser against a storage stub.

### Changed
- **The text-to-speech model the key service names stays out of every model menu too.** AgentX SSO now names a speech model beside the other feature models (`speech_model` in `POST /v1/model-key`); the key reaches it so AgentX Workmate and AgentX Chat can read replies aloud, but WebMate has no read-aloud feature and never offers it: it joins the feature models kept out of the chat, vision and transcription pickers (its name, `google/gemini-3.8-flash-lite-tts`, matches the image-reading name hint, so the key service's field is what keeps it out). The credential records it as `speechModel`. A cached credential learns it on its own: the key's allowlist changes, which already makes it re-ask the key service. Covered by `test/agentx-auth.test.mjs`.
- **The model menus offer chat models only; the web search, image and vision models stay out of them.** The key service now names one model per feature beside the chat grant (`web_search_model`, `image_model`, `vision_model` in `POST /v1/model-key`): the key reaches them, nobody is meant to talk to them. WebMate used to build every picker from LiteLLM's `/models`, which lists the key's whole allowlist — so the search preset, and any image model, sat in the composer chip next to the chat models and failed when picked. The chat list is now the key service's `models` (in its order, the default first) as far as LiteLLM serves it, never a feature model; LiteLLM still decides what is live. The key service's vision model becomes the default Cloud vision model (Settings → Multimodal) until somebody picks or clears one there — that choice is kept — and the vision sidecar may call it although it is not a chat model (`agentxCloudReachableModels`). A cached credential re-asks the key service (`rotate: false`, same key) when the set of models its key reaches changes, or once if it predates this split. `minimax-m3` joins the image-reading name hints. Covered by `test/agentx-auth.test.mjs` (feature models never in the chat list, vision default and the kept choice, the refresh, a failed refresh, the sidecar).
- **Model keys now come from AgentX SSO.** The second brain moved into AgentX SSO on 2026-10-01, and `services.secondBrainBaseUrl` in `brand/brand.config.json` now points at its keys service, `https://agentx.astralx.com.vn/keys/`. That service answers the same `POST /v1/model-key` and holds the same keys, because the SSO imported every key the second brain held; nobody's key changes. A cached credential is tied to the address that issued it, so the first sign-in after updating asks the new address once and gets that same key back. Someone whose key the second brain no longer held gets a new one there. Until every installed copy is updated, `brain.dev-server.cloud` keeps answering by forwarding to the SSO. `test/agentx-auth.test.mjs` now runs against the new address, which also covers a base URL with a path.
- **The hub card's "Your organisation" section is now "Shared in your workspaces".** The AgentX Skill Hub stopped treating the organisation as a place skills live: an organisation is only a visibility boundary (a public skill is seen by the author's colleagues and nobody else), and sharing happens in *workspaces* people create and add each other to, with a hub administrator approving every version before members can see it. The extension followed the wire: `/v1/me/changes` no longer answers with `org`, it answers with `workspaces[]`, so the Settings card would have gone quiet — the old section read `status.org.skills`, which is now always absent, and would simply have stopped rendering with nothing said. The background now keeps `state.workspaces` (id, slug, name, the caller's role, and the skills each workspace shares of this browser's kind) and hands it to the card, which prints one line per workspace that actually shares something — a workspace whose skills are all for another product is not named for nothing — under a heading in the person's own language. What the extension does with that list is deliberately unchanged: it *lists*. Nothing here writes `customSkills`; a workspace skill is installed by the same click as any other, from the card's search or from the hub page, so being added to a workspace can never make code appear in the browser on its own. The visibility badge on search results gained its `workspace` label for the same reason the `organisation` one leaves. Covered by the card test in `test/agentx-hub.test.mjs` (the workspace section replaces the organisation one, an empty workspace is not printed) and, end to end against a real hub in the AgentX-SkillHub repository, by a Playwright case that shares a browser skill into a workspace, watches the card stay silent while the version waits for the administrator, and sees the row appear — without an install — once it is approved.
- **The hub card shows the catalogue as soon as it opens, and the second list says whose skills it holds.** Two things about Settings → Skills → AgentX Skill Hub read as breakage even though nothing was broken. The card asked the hub for nothing on open, so the space under the search box was blank until the person pressed *Tìm* — with no way to tell an empty hub from an unasked one. It now loads the catalogue (the same `kind=browser` listing the search box queries, with an empty query) while it renders, under a *Danh mục kỹ năng* heading, with a "loading" line while the hub answers; a hub that cannot answer surfaces the same error the search would have, and the rest of the card keeps working. And the list below it was headed *Kỹ năng từ hub* — which reads as "the hub's skills" — so an account that owns a skill on the hub but has not installed it here saw "Chưa có kỹ năng nào từ hub" and reasonably concluded the sync was broken. That list has only ever been what *this browser* installed from the hub, so it now says so (*Đã cài từ hub trên trình duyệt này*), and its empty line names the way out instead of stating a fact ("bấm Cài ở danh mục bên trên").

### Removed
- **The first-install onboarding is gone — installing lands straight at sign-in.** Installing used to open a full-tab install guide ("Open Side Panel" plus browser-specific pin instructions), Chrome's panel then layered a pin-to-toolbar coachmark over its first open, and both builds followed with a three-step wizard (welcome, Act-mode warnings, model setup with a local-model scan) that had to be clicked through before the composer was usable. `runtime.onInstalled` now records `onboardingComplete` immediately and opens nothing, so no guide tab appears and the first open of the panel goes directly to sign-in. The guide page and wizard markup stay in the bundle but are never triggered, and the guard tests pin the new install path instead of the old one.

### Fixed
- **Every AgentX process can use the browser again, and the Workmate desktop app always drives it directly — even when a messaging gateway started days earlier got the bridge port first.** AgentX starts a copy of the MCP server in every process that loads MCP tools, and the gateway outlives the app on purpose, but the extension dials one port and the first copy to bind kept it: the next one reported `WEBMATE_PORT_IN_USE` and never tried again, so a gateway started while the app was closed held the browser for days while the app's own agent could not reach it, and the extension kept showing **Connected** — to the gateway. MCP server 1.3.0 adds a peer protocol on the same port (`/peer`, `src/peer.ts`): a copy that cannot bind becomes a *standby* that relays its commands (`cloud_run`, `cloud_status`, `cloud_respond`, `cloud_abort`) through the owner, so browser tools work in every host at once. A copy that outranks the owner is handed the port: the owner lets Workmate commands it already picked up finish, closes its listener while every open socket stays up, waits for the newcomer to bind, lets commands in flight finish, and only then releases the extension with close code 1012, which it redials at once and lands on the new owner; if the newcomer never confirms, the owner takes the port back. Workmate's desktop backend marks its copy `AGENTX_MCP_HOST=desktop`, which ranks it first (`WEBMATE_BRIDGE_PRIORITY`, default 100 for the desktop and 0 otherwise); when the owner leaves, a standby takes over within a moment instead of never. Relaying needs the Workmate pairing token and a native client (no `Origin`); without a pairing file a standby simply waits for the port and retries it every `WEBMATE_BIND_RETRY_MS`. A holder from before the peer protocol is named as such, and the desktop's copy asks it to exit only when it is this server's own bundle running under AgentX's stdio watchdog, whose host restarts it from the current bundle. `state.json` is written only by the owner and now names its `host`, `priority` and the `standbys` relaying through it; every log line carries the writer's PID and host, because all copies share the account's `mcp-stderr.log`. Also fixed on the way: `webmate_connection` says which copy holds the port when relaying, and two hellos accepted within the same millisecond no longer leave the older browser active. Covered by `mcp-server/test/bridge-peers.test.mjs` (relay, priority handoff, takeover when the owner leaves, a command in flight across a handoff, peer authentication, unpaired and legacy holders, an unconfirmed handoff, retiring an outdated supervised server), `mcp-server/test/bridge-handoff-stdio.test.mjs` (gateway first, desktop second, over stdio) and the now-running `mcp-server/test/bridge-multi.test.mjs`.
- **A page's own failed request no longer files itself against the extension.** `wait_for_stable` counts in-flight requests by patching `window.fetch` in the page's main world, and it handed the page back `origFetch.apply(...).finally(...)` — a *derived* promise. The last promise in the chain was therefore created by extension code, so every page request that failed with nobody catching it surfaced as `Uncaught (in promise) TypeError: Failed to fetch` with `net-idle-main-world.js` on top of the stack, and the Errors page recorded a github.com network failure as an extension defect. The number of rejections never changed; only who was blamed for them. The counter now hands back the page's *own* promise and watches it from the side with `then(done, done)` — a branch that always fulfills and so can never be reported itself. The trade is deliberate: a rejection the page handles nowhere now counts as handled and stops reaching the page console, because a promise's rejection cannot be observed without marking it handled. If that signal is ever needed back, the counter has to move to `chrome.webRequest` in the background rather than back into the page's promise chain. Two counter leaks went with it — `fetch` and `XMLHttpRequest.send` throwing *synchronously* left the in-flight count permanently above zero, and `wait_for_stable` then never saw an idle network and waited out its full timeout on every call — and a behavioural test drives both counters through success, rejection, a synchronous throw and a repeated `loadend`, pinning that the promise the page receives is the one its own fetch returned.
- **A browser with no model access now refuses a delegated run up front instead of dying at its first completion.** The managed cloud provider ships with no key and no model until a sign-in installs them, so on a browser whose side panel has never been opened — the exact state of someone who signed in to AgentX Workmate and assumed that covered the extension — every cloud run started, ran, and then failed at the first model call with a 401 or a complaint about an empty model. That reads as a broken bridge rather than as "nobody has signed in yet", and it sent callers into retry loops against a browser that could not answer. `cloud_run` now checks the active provider's own declared requirements before it resolves a tab, and refuses with a sentence naming what is missing and where to fix it. Deliberately asked of the provider rather than of a particular provider id, so a hand-configured provider gets the same answer for the same reason; and deliberately refused only on positive evidence, so a browser the check cannot interrogate fails the way it always did rather than gaining a refusal invented by a check that could not actually check.
- **A bridge port that is already taken no longer takes the browser tools down with it.** The MCP server owns a fixed loopback port, and a server left running by a previous session keeps it — so the next one exited on `EADDRINUSE` before it ever reached stdio, and its host saw only "server failed": all six tools gone, and nothing left running that could explain why. Nothing pointed at the real cause either, because the extension stayed attached to the *old* process — the browser went on reporting **Connected** while every tool call was impossible, which is exactly the wrong place to go looking. A taken port is now a degraded start rather than a fatal one: the server connects stdio anyway and every tool answers with the reason — the port, the PID and command holding it (looked up best-effort through `lsof` on macOS and Linux, omitted rather than guessed when it cannot say), why the browser still claims to be connected, and both ways out (quit that process, or move both sides to a free port with `WEBMATE_BRIDGE_PORT`). Commands fail immediately instead of sitting out the 12s connect grace waiting for a browser that has nothing to dial, and `connection` leads with the conflict instead of its usual advice to check the extension's Cloud bridge settings, which is misleading when those settings are already correct. A failed bind also stops being remembered as a live server, so a retry once the port frees is no longer swallowed by the start-once guard.
- **`Uncaught (in promise) Error: No SW` no longer files itself against the extension.** Chromium answers an extension API request it can no longer attribute to a live service worker with a bare `Error: No SW` (`extensions/browser/extension_function_dispatcher.cc`) — the browser describing its own lifecycle, not a defect in the extension, and stackless, because the frame that rejects is a `chrome.*` binding rather than a line anyone wrote. That is why the Errors page printed it against `background.js` at `0:1`, pointing at nothing. What made it land there at all was ours: nine settings loads ran bare at the top of the worker (`loadMaxSteps()`, `loadProfile()`, `loadCaptchaSolver()`, …) with no rejection handler between them and the browser, and on a default profile the cloud-bridge watchdog alarm restarts the worker about once a minute — so every minute opened nine more chances for a floating rejection to be recorded as an extension error. Each of them now hands its promise to a boot-time handler that drops browser-lifecycle noise and names the setting it lost for anything else, and the attachment-sweep alarm has its promise caught instead of only its synchronous throw. Behind that, a new `lifecycle-errors.js` (byte-identical in both browser trees) cancels exactly this family of rejections — `No SW`, an invalidated context, a closed message port, a vanished receiving end, a browser shutting down, Firefox's disconnected message manager — at the worker's `unhandledrejection`, and logs them at debug level. Every other rejection is still reported as loudly as before: the guard exists to keep the Errors page readable, never to hide a bug that could be fixed.
- **One Stop press now cancels a run caught in the planner — it no longer takes two.** Pressing Stop while the pre-execution planner was still thinking did kill the request instantly, but the planner's retry plumbing consumed the Stop flag on its way out, so the phase's error handler read the aborted call as an ordinary request failure and announced "Planning failed after two attempts. Continuing in Act mode with normal safeguards." — and the run marched on with the Stop already spent, deaf to it until a second press. Abort handling in the planner (both the intent and full-plan phases, plus the read-scope classifier) now recognizes a cancelled call by the error itself rather than only by the flag, and only the phase's single decision point consumes the flag: one press ends the run as "Stopped by user", and the planner-failure fallback is reserved for planners that actually failed.
- **Stop now also interrupts the read-only wait tools instead of sitting out their timers.** Cancelling the model call (below) left one place where Stop still felt slow: `wait_for_stable` can watch a page for up to 20 seconds and `wait_for_element` for its own timeout, and both run their whole settle loop inside the content script with the background only hearing back at the end — so a Stop pressed mid-wait wasn't acted on until the wait expired. Those two dispatches now race against the per-tab Stop flag — peeked every 100ms, never consumed, because the run-loop checkpoint right after the tool is what actually ends the run as "Stopped by user" — and return a partial `{stable:false, aborted:true}` / `{found:false, aborted:true}` result the moment Stop lands; a Stop already pending at dispatch returns instantly without starting the in-page observer at all, and Firefox's restricted-domain fallback (up to 30 seconds of tab-status polling for protected pages) peeks the same flag between iterations. The abandoned in-page poll keeps observing until its own bounded timeout — it mutates nothing and its late answer is discarded. Action tools are deliberately unchanged: a click or a keystroke still runs to completion, because stopping mid-mutation is how forms get half-submitted.
- **Stop now cancels the in-flight model request instead of waiting it out.** Pressing Stop only raised a flag that the agent loop reads between steps, and the model call is the longest step there is: a request already streaming its answer ran to completion — routinely tens of seconds of "stopping" — was paid for, and then thrown away; a Stop that landed during the transient-error backoff even let the loop dispatch one more full request before noticing. Every LLM call now carries a per-tab abort signal wired to the Stop button, threaded through every provider — WebBrain Cloud and the other OpenAI-compatible endpoints (both the Responses and Chat Completions streams), Anthropic, Azure, Bedrock, llama.cpp — into the actual network call, whose direct and offscreen-proxy transports both already knew how to abort, so the request dies the moment you click. While a Stop is still being processed, any new model call fails fast on an already-aborted signal rather than dispatching at all. The killed request ends the run exactly like the between-steps stop always has: the "Stopped by user" notice, a cancelled trace, no error card, and no streaming-fallback retry burning a second request. Page-action tools intentionally still finish their current bounded action first — stopping mid-click is how forms get half-submitted — so a Stop during a tool settles within that tool's own wait, not the model's.
- **"Browser interaction stopped before completion" no longer fires on healthy act-then-verify runs.** The loop detector keyed every tool call on its name and arguments alone, so the verification read a careful model makes after every action — fill a field, `read_page`; click, `screenshot` — counted as "the same call repeating" even though each read was looking at a page that had just changed. Three identical reads in the window started the `[LOOP DETECTED]` nudges, real progress between them could never clear the counter (one healthy call between two flagged ones does not reset it), and the eighth nudge hard-stopped the run — measured at exactly step 20 on a legitimate 12-field form fill, surfacing the red "Browser interaction stopped before completion; a recoverable partial result is shown above" banner mid-task. Smaller models hit this constantly because verify-after-every-action with identical arguments is precisely how they work. Successful read-only calls are now partitioned by a progress epoch that advances on every successful page mutation, so a re-read after real progress is a new observation, not loop evidence; the same 24-step fill now runs clean with zero nudges. Detection of genuinely stuck runs got stronger, not weaker: repeating one read on an unchanged page still nudges at 3 and stops at 10, failed or unverified actions do not advance the epoch (their surrounding identical reads still accumulate), and the call window grew from 6 to 12 entries with exact period-3/4 cycle detection — the A→B→C→A→B→C loop that previously produced **zero** detections and burned the whole step budget now stops at step 13.
- **The sign-in gate can no longer spin forever at "Đang kiểm tra phiên đăng nhập…" or "Đang chuẩn bị kết nối mô hình…".** Every network call under the gate was already timeout-capped, but three awaits were not: a `chrome.storage` read that never settles, a background message the service worker accepts and then dies on (the gate's `update_provider`/`set_active_provider` install step), and — the worst case — a side-panel module graph that fails to load at all, which left the *static* spinner shipped in the HTML up with the retry button hidden. The gate now retires any silent restore attempt after 60s and any single background round trip after 20s, surfacing the retry button with a readable reason; a retired attempt that finishes late is discarded rather than allowed to unlock the panel under a newer one. A new classic-script boot watchdog outside the module graph (`agentx-boot-watchdog.js`) covers the module-never-ran case: after 15s with no sign of life it swaps the spinner for the first captured error and a "Tải lại" button. Gate tests drive all three hangs with manual timers, and a real-browser check breaks the module graph and watches the watchdog take over.
- **A blank white side panel that survived restarts (Edge) now has a document behind it.** The extension registered its panel path only per tab, inside user-gesture handlers — nothing global, no `side_panel.default_path`. Surfaces that open the panel without running those handlers, measured on Edge's sidebar rail and its session restore, therefore rendered `chrome-extension://<id>/` as a permanently white frame that Edge remembered across restarts; only removing the extension cleared it. The service worker now registers `setOptions({ path, enabled: false })` once at boot: a real document for any surface the browser conjures, while visibility stays exactly as before — per-tab `enabled: true` overrides the disabled default (verified against real Chrome and real Edge, alongside the untouched-tab and Cmd+T cases), and the guard test now pins this one global call to its exact disabled shape.
- **A background wedged by one bad storage read or one corrupted provider entry no longer fails every message until the extension is reinstalled.** Three hydration promises (`customSkillsReady`, `planBeforeActReady`, `planReviewReady`) are awaited by every non-lightweight message but had no rejection handler, so a single failed `storage.get` at service-worker boot poisoned them — permanently rejected, every message erroring until the next SW restart; they now degrade to shipped defaults with a warning. Worse, a corrupted entry in the stored `providers` object (a `null` from a crash mid-write) made `providerManager.load()` throw deterministically on every retry — every message failing forever, surviving SW restarts, fixed only by wiping the profile, which is exactly the "remove and re-import the extension" remedy users reported. Load now drops corrupted entries (and tolerates a corrupted `providers` value outright), skips an entry whose provider cannot be constructed instead of abandoning the whole catalog, bounds the platform-info call that could park it, guards the legacy Claude sign-out cleanup, and coalesces a burst of concurrent loads into one in-flight read plus one queued follow-up so freshness is preserved. The unguarded top-level `chrome.sidePanel.setPanelBehavior` call — a module-evaluation throw on any browser without the API, which would have unregistered every message listener — is optional-chained like its neighbours.
- **The panel's chat-restore retry loops stop instead of spinning at 4Hz forever with the composer dead.** `load_tab_chat` failures (background restarting, mid-update, invalidated registration) fed three unbounded 250ms retry loops — panel boot, the visibility refresh, and Firefox's tab switch — that disabled the send button for as long as they spun, silently. Each loop now gives up after 12s and recovers: first by reloading the panel document once (which also picks up new code after an extension update; a marker in `history.state` plus `sessionStorage` — verified written before use — prevents reload loops), then by showing a visible notice with a reload button. While a tab is in the failed state nothing may persist over its stored conversation — the document never managed to read it, so a write would clobber the only good copy; a later successful read clears the block and the notice. The background's handoff-snapshot request to a possibly-suspended sibling panel gets a 4s race so `load_tab_chat(waitForHandoff)` itself cannot hang server-side, and panel boot survives what used to kill it silently: the initial `tabs.query` against a restored-but-gone window, the composer-settings read, and any other `init()` rejection now surface the same reload notice instead of an inert panel.
- **The permission-mode menu shows all four rungs at once instead of scrolling.** What the scroll cut off was the last rung — Bypass permissions, the widest grant of the set. Its ceiling was a hard-coded 340px that had no relationship to the panel it opens in: measured in a 380x660 panel the rows came to 419px against that cap while 629px of room sat unused above the chip. The ceiling is now measured from the chip at open time, re-measured if the panel is resized under an open menu, and released on close; scrolling survives only for a window genuinely too short to hold the ladder. The rows were also taller than they needed to be — each description wrapped inside the column left over beside the checkmark and the number keycap, 274px of a 354px menu, which cost most modes an extra line. Descriptions now span the whole row, taking the ladder from 419px to 363px, which is what makes it fit a short panel and not just a tall one. The standing choice also gains a left rail beside its fill, so it reads as chosen without depending on a tint plus a checkmark, and the menu is capped at 420px so a widened side panel no longer stretches four rows across the window.
- **Loading the social-media downloader twice into one page no longer throws.** The v4 auto-arm block left a top-level `const` after the library's IIFE, so the second evaluation in the same main-world realm — the `document_start` content script plus the injection every `download_social_media` call performs, or two tool runs on one tab — died at parse time with `Identifier '_SMD_MSE_AUTOARM_HOSTS' has already been declared`, an uncaught SyntaxError logged on every supported social host. The block now lives in its own IIFE, so a re-evaluation cleanly replaces `window.SocialMediaDownloader` (the refresh that un-stales an old copy after an extension update), and a regression test evaluates the file twice in one realm to keep it that way.
- **Clicking a `javascript:` link no longer files a Content Security Policy error against the extension.** A synthetic click on `<a href="javascript:…">` asks the browser to run the href as an inline script, and that navigation is checked against the CSP of the world the click came from — so it was refused ("Running the JavaScript URL violates the following Content Security Policy directive `script-src 'self' …`") and, because the click came from the extension's content script, the violation landed on the extension's Errors page rather than the page's own console. Seen on webmail whose menu items are `javascript:void(0)` placeholders, where every agent click logged another entry. Placeholder hrefs are now cancelled by a listener that runs after every one of the page's own handlers, so the page still sees the click exactly as before and only the meaningless navigation goes away — and the suppressor is released the instant the synthetic click ends, so a real click of yours on the same link is untouched. An href carrying real code is still allowed to run, and is cancelled only once this page has actually been observed refusing one; from then on the click reports the refused URL instead of returning a clean success, because in that case the link's whole action never ran.

## [1.0.8] - 2026-10-04

### Changed
- Khoá và model lấy từ AgentX SSO; bộ chọn chỉ hiển thị model chat được cấp, tách model tìm web, tạo ảnh, đọc ảnh và đọc to.
- Cầu nối MCP 1.3.0 chia sẻ kết nối giữa Workmate và gateway, ưu tiên ứng dụng desktop và tự chuyển tiếp khi đổi chủ cổng.
- WebMate mới nhất được đóng gói cùng AgentX Workmate 1.0.4.

## [1.0.7] - 2026-09-28

### Changed

- **The AgentX Hub now lives at `https://agenthub.astralx.com.vn`** (moved from `https://skills.astralx.com.vn` on 2026-09-26, which had replaced `https://skills.dev-server.cloud` on 2026-09-09). The default hub address (`services.skillHubBaseUrl` in `brand/brand.config.json`) points there, and so does the only origin allowed to message the extension (`externally_connectable`, Chrome/Edge), which the brand build derives from the same value. A hub address saved by hand in Settings → Skills still wins over the default, so a browser that was pointed at an old host keeps that override until it is cleared (*Dùng mặc định*). Builds up to 1.0.6 carry the previous address, which no longer resolves.

## [1.0.6] - 2026-09-24

### Added

- **"Open on the Hub" for skills from the AgentX Hub** (hub decision §8 #20): the enabled-skills row of a hub record (and of a copy edited by hand before the lock) gains a button that opens the skill's page on the hub in a new tab — where its author presses Edit, writes the next version in the browser, and every device that installed it gets that version at its next sync. The read-only notice says so instead of pointing only at "Fork to edit" (which makes a private copy that no longer updates). Only an http(s) `sourceUrl` becomes a button or a tab. `brand/additions/common/src/ui/agentx-hub-settings.js`; covered by `test/agentx-hub.test.mjs`.
- **Selected answer text can be quoted into a follow-up question.** Selecting part of an assistant answer shows an action that quotes it into the composer as the subject of the next question; the action keeps its position through repaints, clears on send, and leaves Escape's run semantics alone. Synced from upstream WebBrain PR #2837.
- **Message info shows relative send times.** The info row under a message reads "sent 3 minutes ago" through `Intl.RelativeTimeFormat` in the interface language, freezes the value while the row is open, and keeps the row scrollable (upstream).
- **A selected-text chat can widen back to the whole conversation.** A conversation started from the selection bubble keeps safe earlier dialogue in reach, explains how to recover a broader scope, and offers "Dùng cuộc trò chuyện đầy đủ". The first message after restoring carries a trusted runtime note that the selected-text boundary is gone and re-reads the page before the model answers; the pending restore is persisted, consumed exactly once, and survives a service-worker restart (the restore now hydrates before it looks for the scope). Synced from upstream PRs #2925–#2928 and #2968; covered by the new `test/selection-scope-restoration.mjs` in `npm test`.
- **Traces gain per-run statistics, session lineage navigation, and session-aware exports.** Finalized runs store LLM request/response, tool-call, vision sub-call, error and retry counts plus LLM/tool latency; the Traces page groups runs into parent/child lineage per session; `scripts/trace-to-otlp.mjs` and the new `scripts/trace-to-atif.mjs` export whole conversation bundles with session association and a versioned export contract; recovery codes are redacted from JSON exports. Synced from upstream PRs #2899, #2905, #2910, #2912, #2913 and #2917 plus the lossless-tier byte-accounting fixes.
- **Provider settings: output-token and context limits per provider, optional API keys for local servers, and OpenRouter routing variants.** Every provider card can set its context window and maximum output tokens (clamped to the selected model's ceiling), and the agent now requests that limit instead of a fixed 4096 output tokens. Local OpenAI-compatible servers accept an optional API key, and OpenRouter cards choose Standard, Nitro or Exacto routing. Synced from upstream PRs #2948 and #2904 and the OpenRouter variant series.
- **GPT-6 Luna Pro, Sol and Astra are recognized, and the built-in model lists are current.** Cloud and router model lists move to current API ids, untouched stored defaults migrate on load (and the migrated snapshot is written back, which also clears a dropped corrupted entry), GPT-6 models get their context window, vision flag and default-temperature rule. Synced from upstream.

### Changed

- **License: AgentX WebMate is now distributed under GPL-3.0-or-later.** WebBrain relicensed 33.0.0 and later under GPL-3.0-or-later, and this repository includes code from those releases. `LICENSE` (and the packaged `src/{chrome,firefox}/LICENSE`) now states that AgentX WebMate is a modified WebBrain, keeps the MIT notice that covers code first published before 33.0.0, and carries the GPL-3.0 text; `mcp-server/` and `lmstudio-plugin/` stay MIT with their own `LICENSE` files, as upstream keeps them.
- **Upstream WebBrain synced selectively through 36.8.0.** Fixes and features were taken where they applied cleanly or with small, verified conflict resolutions; series that conflict deeply with AgentX's own agent loop, side panel, locales or selection bubble (action deadlines, site-workflow contracts, social publishing, PDF viewer, activity labels, completion flash, research escalation, WebBrain Compass/Plus) were left out. Brand patches 020 and 030 were rebuilt against the new sources; the AgentX Cloud model policy still wins over upstream's OpenCode Zen model normalization for the managed provider.

### Fixed

- **`set_field` with `submit: true` submits a form exactly once.** It dispatches the Enter trio, submits natively only when the page did not handle Enter, and observes the final submit event, so a page that submits on keydown is no longer submitted twice (upstream PR #2814).
- **Chrome debugger sessions and capture resources are released after every run.** Debugger teardown is race-safe and keeps CDP lifecycle ownership, and capture lifecycles no longer leak when a recorder fails to start (upstream PRs #2852, #2854).
- **Clearing a conversation is atomic and recoverable.** A failed clear rolls back, keeps queued prompts, screenshots and attachments, and resumes the queue; active runs and plan followers settle before recovery (upstream).
- **Smaller reliability fixes from upstream.** Subscription OAuth refreshes are deduplicated; Settings ignores stale model-list responses and serializes model-load saves; scheduled-job confirmations are no longer duplicated; `/record` avoids Chrome's 64 MiB `sendResponse` limit; planner fallback notices bind to the latest run; large tab-chat images persist within budget; clarification answers stay bound to their task and runtime notices (including main's plain-final blocks) never become the task; routed OpenAI contract detection is scoped to OpenRouter; OpenCode Go requests send `x-opencode-session`; the Ask-streaming setting copy is restored in 11 locales; selected-text proofreading keeps to the selection's boundaries; and the MCP server's lockfile takes hono 4.13.7, qs 6.16.0 and fast-uri 3.1.7.

## [1.0.5] - 2026-09-09

### Changed
- fix(extension): không lặp chi tiết lỗi trong message của auth_hint; test e2e phủ mã lỗi đi qua trường code
- fix(extension): mã lỗi của auth_hint/auth_open đi trong trường code (trường error bị offscreen bridge coi là lỗi giao thức và làm mất outcome); server đọc code
- fix(extension): auth_open trả lời ngay khi mở tab đăng nhập (opened/in-progress), kết quả đi qua khung session; ghi lại trong tài liệu
- docs(workmate): hợp đồng giai đoạn 4 — SSO im lặng, nhiều trình duyệt, khung session, lệnh auth_*
- feat(mcp): server 1.2.0 giữ nhiều kết nối theo instanceId, lệnh auth_hint/auth_open, webmate_connection liệt kê trình duyệt
- feat(extension): đăng nhập im lặng theo gợi ý từ Workmate (auth_hint/auth_open), instanceId trong hello, khung session, gate tự mở khoá

## [1.0.4] - 2026-09-09

### Changed
- fix(bridge): kết nối thứ hai chỉ thay socket đã ghép đôi sau khi hello của nó hợp lệ
- test(mcp): cách ly WEBMATE_DIR trong mọi test dựng bridge in-process; ghi chú hệ quả khi máy đã ghép đôi
- fix(release): giữ workmate.json của dev qua brand:build, build:zip từ chối đóng gói khi có nó; test catalog không ghi vào ~/.agentx
- feat(release): release.json ký Ed25519 cho feed cập nhật của Workmate
- feat(mcp): pairing.json, state.json, tệp lệnh từ Workmate, mã lỗi WEBMATE_*, server 1.1.0
- feat(bridge): hello v3, đọc workmate.json, đối chiếu token trong hello_ack, lệnh cập nhật từ Workmate
- feat(brand): khoá manifest cố định ID extension, minimum_chrome_version 121, hợp đồng workmate
- dist: rebuild submission zips for v1.0.3 (hub chuyển sang skills.astralx.com.vn)
- chore(skill-hub): đổi địa chỉ hub sang skills.astralx.com.vn
- dist: rebuild submission zips for v1.0.3 (thẻ Hub tải danh mục khi mở)
- fix(skill-hub): thẻ Hub tải danh mục khi mở, gọi đúng tên mục "đã cài"
- dist: rebuild submission zips for v1.0.3 (thẻ Hub hiện skill của workspace)
- feat(skill-hub): thẻ Hub hiện skill của workspace thay cho skill tổ chức (§8 #11)
- feat(skill-hub): hub skills are read-only — edit lock, content seal with repair, fork to edit (plan §8 decision 9)
- Changelog: record the net-idle fetch-blame fix
- build(brand): swap brand-dist files in by rename, never in place
- fix(net-idle): the page keeps the promise its own fetch returned
- feat(skill-hub): Phase 4 — AgentX Skill Hub in WebMate (hub client, desired-state sync, one-click install, Settings card)
- dist: rebuild submission zips for v1.0.3

## [1.0.2] - 2026-08-25

### Added
- **The Ask/Act/Dev switcher and the permission chip got a redesign.** The mode toggle is now an iOS-style segmented control — a recessed track, a sliding thumb that carries the active mode's colour, a small icon per mode, equal-width segments — with `aria-pressed` kept in sync on every button. The permission chip swaps its shield for a struck-through one while Bypass permissions is standing, so the widest rung is visible at a glance. Mode labels moved into their own spans, which stops a locale pass from erasing the icons.

### Fixed
- **The cloud bridge no longer needs to be switched on, and no longer stays down once it drops.** The local control bridge now ships **enabled**, pointed at `ws://127.0.0.1:17374/extension` — the MCP server's port — so an agent driving this browser over MCP attaches to a fresh profile without anyone opening Settings first. Cloud (`17373`) and the LM Studio plugin (`17375`) are still one URL edit away, and the extension still holds exactly one socket. Because it is on by default, any local process listening on that port can ask the browser to run a task; the bridge's action allowlist keeps that to run-level operations, and every action inside a run still passes the same in-browser permission gate a human driving the side panel gets.
- Three ways the bridge could go quiet and stay quiet are closed. The socket lives in the extension's offscreen document, which reconnects on its own but cannot survive its own teardown — a once-a-minute alarm in the service worker now rebuilds it, and a real-browser test confirms the bridge comes back after the offscreen host is destroyed. A dial that connects at the TCP level and then never completes its WebSocket handshake used to wedge the bridge permanently, because the reconnect path skips a socket that is still `CONNECTING`; it is now abandoned after ten seconds and retried. And a controller that comes back after a long outage no longer waits out a backoff that had already grown: an explicit start — from Settings, from a cold service worker, or from the watchdog — cancels the pending retry and dials at once. The backoff ceiling itself dropped from 30s to 10s, which is what makes a restarted MCP server reattach in seconds.
- **The MCP server stops claiming a browser that is gone, and stops failing on one that is merely late.** It now pings the extension every 15 seconds and hangs up after two missed replies, so a browser that vanished without closing its connection is reported as detached instead of timing out every command 30 seconds at a time. In the other direction, a command issued while the extension is still inside its reconnect backoff — the normal state right after an MCP host spawns the server — waits up to `CONNECT_GRACE_MS` (12s, chosen to cover a full backoff cycle) instead of failing instantly with "no extension is connected". The `connection` diagnostic keeps its own short 2s wait, since an agent calls it precisely when it suspects nothing is attached.
- **Bypass permissions now covers a `clarify` nobody answered.** When a clarify question timed out with no reply, the auto-selected answer was never treated as your authorization: the next consequential action and any success completion stayed blocked until you replied for real, and a second attempt ended the run. That is a run halted to collect an approval, so Bypass — the rung whose name promises otherwise — now releases it. The question itself is still asked in every mode; only what happens when nobody replies changes. The decision is read live and never recorded, so the guard stays armed and dropping back to a stricter rung restores the block for whatever comes next, with the blocked-attempt counter untouched. Auto and Accept page actions deliberately keep the block: they pre-approve interaction you can watch happen, not the substitution of silence for an answer.
- The system prompt now points the model at the clarify result's own `authorized` field instead of ranking answers by where they came from. Six prompt strings stated flatly that a timed-out answer is never approval, which contradicted the runtime the moment a Bypass run timed out — the model could refuse an action the mode had already allowed.
- Widening to Bypass clears a plan card that is **already on screen**, not only the plans raised after the switch; the rung described as running the plan without asking for approval used to leave that open approval sitting in front of you. Edits you had already typed into the plan travel with the approval, exactly as the Approve button sends them, and an empty step list is refused rather than pushed through. `/dangerously-skip-permissions` clears the same card, since it is documented as the same decision as picking Bypass in the menu.
- Opening the side panel no longer leaves an unexplained error behind. The toolbar/shortcut path and the context-menu path both fired `sidePanel.open()` without handling its rejection, so a panel open that lost its user gesture — a documented dead end on Edge — surfaced as a bare "Uncaught (in promise)" on the extension's Errors page with no readable location. Every panel-open call now handles its own failure, as the Firefox build and every neighbouring call already did.

### Changed
- The bridge's enabled flag and default URL moved into one shared module (`src/chrome/src/cloud-bridge-config.js`) read by both the Settings page and the background controller. They used to hold private copies, which is how a toggle could read one way over a bridge that had started the other. The flag is now opt-**out**: only an explicit `false` disables it, so an untouched profile stays reachable and no keys are written on boot — freezing today's default into every profile would make a future change invisible.
- Documentation caught up with behaviour: the security model still claimed a WebMCP invocation "still asks in every mode", which stopped being true when Bypass took over that gate. Both trees' architecture notes, the injection-defence layer note, the manual permission checklist and the Bypass description in all 23 locales now match what the code does.

## [1.0.1] - 2026-08-24

### Added
- Attachments are now delivered the best way the active model supports: PDFs become native document blocks on Anthropic models, locally extracted text (with per-page coverage warnings) everywhere else, and scanned PDFs render their first pages as images on vision models; DOCX files convert to text locally via a vendored mammoth build, and unrecognized files ride along as references the agent can read on demand.
- Added a `read_attachment` agent tool (Ask/Mid/Full tiers) that pages through attached files by page range or character cursor, with a vision render mode for scanned pages that counts against the per-turn image budget.
- Attached files now persist in a local IndexedDB claim-check store for up to 24 hours after last use, so composer chips survive side-panel reloads and retries re-send every file; a new Settings → Multimodal → Attachments card controls retention (24 hours or session-only), shows local usage, and deletes everything on demand.
- Added paste-to-attach and composer drag-and-drop with a localized drop hint, plus pre-send chip hints from a background probe ("PDF · 12 pages" / scanned-PDF vision warnings).
- Agent runs now record a structured trace: a versioned event model with a tolerant read path, session lineage (parent run ids plumbed through cloud runs and replays), turn/step boundary events with stable failure codes, and a step trajectory table in the Traces tab.
- Added an opt-in lossless recording tier (Settings → Display → "Record full request details"). The default tier is unchanged and content-free; the lossless tier persists full prompts, messages and tool schemas (clamped at 500 KB) and raises the tool-result cap to 200 KB, marks affected runs with a "sensitive debug tier" badge, redacts and credential-masks its JSON and Markdown exports, and evicts the oldest lossless runs to stay inside a disk budget. Runs interrupted by service-worker eviction are repaired when the Traces tab opens.
- Permission prompts now have a middle ground: a standing, capability-scoped permission mode picker above the composer, with four rungs — `manual` (ask every time, the default), `auto` (navigate/click/type freely), `page_actions` (also accept form submits and `execute_js`), and `bypass` (accept everything). The ladder is ordered by how hard an action is to undo and how far it reaches past the page. A mode only ever answers a question the user has not answered, so a standing "Don't allow" outranks every mode, and a mode decision is never recorded as a grant — dropping back to a stricter rung restores the prompts immediately. `bypass` accepts everything, including form submits, WebMCP page callbacks and the planner's review card; every narrower rung keeps the WebMCP two-gate boundary, which an unattended scheduled run cannot suppress either.
- Staged `/screenshot` captures now live in the shared `wb_attachments` claim-check store instead of their own `chrome.storage.local` keyspace, so they inherit the 24-hour TTL sweep, the retention setting, and the usage figure in Settings. Captures staged but not yet sent before this upgrade are dropped, not migrated.

### Changed
- A single unsupported attachment no longer blocks the whole send: every file resolves to a per-file delivery outcome shown on the message card (sent natively, sent as text, sent as rendered pages, reference, or skipped with the reason), and runtime messages now carry attachment ids plus metadata instead of multi-megabyte base64 payloads.
- Attachment classification is now byte-first: files renamed to fake an image type are rejected, legacy `.doc` files get a dedicated message asking for `.docx`, and text encodings (UTF-8/UTF-16 BOM) are honored.
- Prompt sizing is now script-aware. Context and compaction budgets were derived from a flat `chars / 4` estimate, which badly undercounts languages that pack more tokens per character — a Vietnamese conversation could blow the real context window while the estimate said it fit. Cost and budget estimates now measure by script.
- PDF and DOCX decoding moved out of the service worker into the offscreen document, so a large document no longer blocks the worker's event loop.
- Permission-mode copy now matches behaviour in all 23 locales: `auto`'s description lists running page scripts among what it still asks about (it always did), and `bypass`'s says it runs the plan without asking for approval.
- Side-panel visibility is owned by one module (`src/side-panel-availability.js`) instead of the same `setOptions` payload copied across the service worker, the agent's `new_tab`, and the install page. Behavior is unchanged; the write-only `panelTabs` bookkeeping it replaced was dead code.

### Fixed
- Attachment document extraction was dead on Chrome: MV3 service workers disallow dynamic `import()`, so the lazy pdfjs/mammoth loads threw at materialize time and every PDF/DOCX rode the error outcome. Vendored bundles now load through per-browser vendor loaders — statically on Chrome (with the pdfjs worker module published for the fake-worker path), lazily on the Firefox background page. This also repairs the pre-existing silent `read_pdf` breakage on Chrome, which failed the same way.
- `bypass` now means bypass. The widest permission mode still stopped the run twice: the planner's review card was never wired to the mode at all, so a task blocked on an approval before its first tool call even with every prompt turned off, and a WebMCP page callback was hard-wired to ask in every mode in the Chrome build — Firefox already let `bypass` through, so the two trees had drifted apart. Plan review is now auto-approved under `bypass`, overriding even a plan-review setting of *always*, with a visible "auto-approved by permission mode" note naming the mode instead of a confidence score that had no say in it; the WebMCP gate yields to `bypass` alone, since that mode already runs `execute_js` unprompted on the same page — more authority than invoking a tool the page chose to expose. A `clarify()` question from the model and the workflow target-healing card are deliberately still asked: neither is a permission.
- The composer no longer snaps back to Ask. Act and Dev were held in a variable that died with the panel document, and Chrome gives every tab its own panel document — so opening the sidebar on a second tab, or closing and reopening it, always came back in Ask. The chosen mode is remembered and restored, while modes the panel *forces* (a selection-scoped conversation, a standalone chat window) no longer overwrite that choice.
- Anthropic runs no longer lose thinking content across turns, and a replay that fails mid-stream now yields `done` instead of throwing.
- Routed reasoning models keep the right token contract: reasoning-model classification is done per provider, routed GPT-5 Pro keeps its own contract, routed o-series stays on the legacy fields, and the contract regex is bounded and shared with Settings instead of re-derived there.
- Settings lists the built-in providers' default models, and the provider summary imports the contract helper it calls.
- The composer respects IME composition, so committing a candidate no longer sends the message. Clarify stays open while typing, and stale list refreshes are ignored.
- Gmail complete-thread reads no longer loop.
- The agent's rejection of a plain final answer is now bounded, so a run cannot be held in a retry loop by the runtime blocks that reject one.

### Security
- The user-attachment notice is now sealed with a per-send random nonce, extracted document text is neutralized against forged notice/document markers and zero-width/bidi control characters before it reaches the model, and attachment display names pass a positive allowlist instead of escape-and-keep.
- Expanded the injection corpus from 27 to 33 payloads with a document-attachment category (extracted-PDF overrides, DOCX posing as tool results, notice-forging file names, fake nonce closings, zero-width/RTL smuggling, CSV directives), all green on both browsers.

### Tests
- Added mirrored Chrome and Firefox coverage for the byte sniffer, the attachment store (TTL, per-tab lifecycle, degraded backend), the nine-row delivery matrix against real PDF/DOCX fixtures, coverage thresholds, notice nonce and neutralization seals, `read_attachment` paging/render budgets, the delivery-note budget, and the closed outcome union.
- Added a guard that every i18n key the code passes to `t()` is defined in `en.js`. The existing locale test only checked the other direction — that each locale covers `en.js` — which is how a deleted key block shipped rendering as its own dotted names.

## [32.1.0] - 2026-08-16

### Added
- Added a `/print` slash command that prints either the current page or the user's active selection without losing the selected scope.
- Added independently configurable duplicate provider cards in Settings, with one additional instance per eligible provider and preserved provider-specific behavior across Chrome and Firefox.
- Added click-to-reveal message metadata, including system-timezone sent times and verbose model completion details.

### Changed
- Refined the homepage story and Apocalypse Mode showcase, including offline equation rendering and more compact handling of small Wikipedia images.

### Fixed
- Duplicate provider cards now open completely blank instead of copying credentials, endpoints, models, costs, compatibility overrides, or other settings from the source provider; suggestion-backed model controls also remain visibly blank until configured.
- Kept duplicate-provider creation, removal, draft preservation, active-provider fallback, reload validation, and local model/vision behavior independent and reliable.
- Improved message metadata accuracy, streaming/restoration behavior, keyboard accessibility, compact one-line presentation, and local-timezone formatting without a separate info icon.
- Kept the offline Wikipedia library reachable from Apocalypse Mode and hardened archive history navigation and offline answer generation.

### Tests
- Added mirrored Chrome and Firefox regressions for blank provider duplication, duplicate lifecycle behavior, message metadata rendering and keyboard operation, `/print` selection handling, and Apocalypse Mode reliability.

## [32.0.0] - 2026-08-14

### Added
- Added opt-in Apocalypse Mode for downloading or importing Wikipedia Kiwix/ZIM archives and searching them locally when the built-in Wikipedia skill cannot reach its online source.
- Added an on-device archive manager, available from the ☢ Apocalypse Mode link beside Support in the Settings header, with expanded language choices, full-text archives with an optional images toggle, background download progress, storage estimates, update checks, removal controls, and reauthorization for external archive files.
- Added browser-native ZIM parsing and search, including Zstandard-compressed clusters, without uploading archive contents.
- On supported Chromium browsers, enabling Apocalypse Mode now enables and downloads the local LFM2.5-VL vision fallback automatically, with persistent progress shown on the management page.
- Localized the Apocalypse Mode interface across all supported Chrome and Firefox locales.

### Fixed
- Prevented direct-message sends on protected messaging routes unless the planner carries the user-authorized recipient and a read-only pre-dispatch probe verifies one unique, exact active-conversation header identity. Pronoun follow-ups resolve to a named recipient only from unique authentic prior-user context, otherwise they clarify; generic pronouns never silently mean the open thread. Active-conversation requests are pinned to that identity before any page tool runs; ordinary conversation text never counts as recipient evidence, structurally verified search/navigation fields stay distinct from composer submission, and alternate or ambiguous editable composers plus unresolved or distant controls and dispatch paths that cannot bind to the verified recipient—including attachment injection that may auto-send—fail closed. Structurally verified conversation rows in the separate left rail remain selectable so the agent can recover from an initially wrong thread, while nested row actions and their span/SVG descendants remain blocked; verified Enter sends are limited to one keypress. Send-capable field edits, clicks, accessibility clicks, and Enter presses carry a one-use action/composer/identity binding that is revalidated at the actual click or key dispatch point; protected accessibility clicks never issue a second no-progress fallback click. Saved workflows that could dispatch on a protected messaging route stop before replay and direct the user to a normal Act task, where fresh structured recipient authorization is available. The first enforced adapter is Douyin chat, with Chrome/Firefox parity.
- Isolated browser-managed archive storage per download so reinstalling the same archive cannot corrupt another record.
- Required explicit Apocalypse Mode opt-in before catalog or Metalink network access.
- Made stale-import recovery generation-safe and preserved partial data while a live importer may still be writing.
- Added explicit permission recovery for external ZIM files after browser restarts and prevented automatic retries while authorization is required.
- Removed unbounded alarm retries after unexpected archive-download failures.
- Routed local vision progress through the service worker, probed WebGPU before automatic selection, restored the prior vision provider after automatic preload failures, preserved later local-vision opt-outs, and refreshed the Settings controls after cross-tab changes.

### Tests
- Added planner, adapter-routing, active-conversation pinning, recipient-normalization, exact-match, mismatch, missing-authorization, inconclusive-probe, alternate-dispatch, and non-message regressions for the direct-message recipient guard in both browser builds.
- Added mirrored Chrome and Firefox regression coverage for ZIM validation and search, archive downloads and imports, opt-in network gates, recovery races, external-file permissions, and retry behavior.

## [31.0.1] - 2026-08-14

### Changed
- blog: announce WebGPU vision and correct EXL3 date
- i18n: localize local vision fallback
- dist: rebuild submission zips for v31.0.0
- fix: use visual local vision health probe
- docs: add 31.0.0 changelog
- version up
- dist: rebuild extension packages
- fix: make local vision probe reliable
- dist: rebuild extension packages
- fix: harden WebGPU vision lifecycle
- improvements
- Retry quantized WebGPU map failures with fp16 before aborting
- Skip WASM fallback for quantized WebGPU models
- Retry WebGPU unaligned-access failures with fp16 dtype
- Reset WebGPU mode when WASM kernel init fails
- Improve WebGPU fallback errors and switch default ONNX model to Gemma
- Add robust fallback for WebGPU buffer map failures
- Handle WebGPU OrtRun buffer download/CPU data failures with retry mode
- Fix WebGPU CPU tensor access error in worker pipeline
- 9.0.2
- 9.0.0
- WebGPU: keep outputs on GPU to avoid mapAsync OOM
- title change
- WebGPU: move inference to a dedicated Worker + upgrade to Qwen 3.5 0.8B
- WebGPU: disable wasm-cache for chrome-extension scheme
- WebGPU: address PR #66 codex review (tool-call streaming + cache key)
- WebGPU: enable cross-origin isolation for SharedArrayBuffer
- WebGPU: force .jsep wasm variant so WebGPU EP actually engages
- WebGPU: surface fallback-adapter / no-GPU case in Test Connection
- WebGPU: document fp16 fallback when q4f16 kernel overflows
- WebGPU: switch default dtype from q4 to q4f16
- WebGPU: vendor asyncify WASM variant for CPU fallback ops
- WebGPU: vendor onnxruntime-common, patch second bare specifier
- WebGPU: vendor UNMINIFIED builds (Web Store policy + readability)
- WebGPU: fix bare-specifier import (vendor ort.webgpu.bundle, patch specifier)
- version up
- Vendor @huggingface/transformers 4.2.0 (WebGPU + ONNX runtime)
- WebGPU: download progress indicator
- Update offscreen.html
- chore: bump version 7.3.1 → 7.4.0
- WebGPU + ONNX provider (Qwen 3 0.6B, in-browser, no server needed)

## [31.0.0] - 2026-08-14

### Added
- Added a one-click, Chrome-only in-browser vision fallback powered by WebGPU, using LiquidAI's LFM2.5-VL-450M ONNX model as a dedicated screenshot-description sidecar rather than a general planning provider.

## [30.0.7] - 2026-08-14

### Changed
- fix(memory): validate extraction confidence defaults
- fix(actions): preserve Messenger thread routes
- fix(session): recompute recent boundary after filtering
- 30.0.6
- docs: explain page context reduction
- Default extraction confidence to 1 when the model omits it
- Reject lookalike commerce hosts and short-link DM paths
- Drop tool results orphaned by assistant compaction in session snapshots
- Clarify the non-finite overflow comment per review feedback
- Fix clipped plan review steps
- Reject non-finite numbers in cloud output schema validation
- Added Product Hunt

### Fixed
- Keep ordinary and forced-recovery answers in the trusted user-request language while allowing explicit translation targets, user-edited plan targets, multilingual deliverables, and source-faithful quotations to use their requested languages.
- Shrink the response-language instruction on ordinary turns from about 150 tokens to about 40, stop repeating it in the `done` tool schema when the system prompt already carries it, and keep an explicitly empty planner deliverable list instead of discarding it as malformed. Translation, multilingual, approved-plan-override, and forced-delivery turns keep the full wording.

## [30.0.5] - 2026-08-13

### Changed
- bugfixes
- Handle nested opaque iframe origins
- Fix agent safety and reliability regressions
- removed unnecessary files

## [30.0.3] - 2026-08-13

### Changed
- feat: add local OpenAI-compatible proxy provider
- fix: recognize localized Gmail expansion controls
- Preserve hidden prompts for restored retries
- Fix thread actions and anchored pagination

## [30.0.2] - 2026-08-13

### Changed
- Packaged the current extension fixes for browser stores.

## [30.0.1] - 2026-08-12

### Changed
- fix: disambiguate nested Gmail label routes
- fix: reject Gmail list routes with hex names
- fix: bind tree pagination to content revisions
- fix: require fresh Gmail root metadata
- Update contributor count in webstore explainer
- fix: reject Gmail list routes for thread reads
- fix: polish standalone window UX
- feat: add standalone Ask window
- Fix Gmail thread read completeness
- Polish selection shortcut actions
- fix: isolate standalone chat context
- fix: require verified download completion
- 29.0.3
- updated numbers
- Fix #466: Expand sidepanel into standalone window
- Fix #2752: Derive planner download completion requirements without prose heuristics
- fix: preserve legacy click dispatch behavior
- refactor: reconcile screenshot clicks through semantic AX targets
- fix: constrain general knowledge to custom selections
- fix(planner): require structured download completion evidence
- feat: add general knowledge selection scope
- feat: resolve visual targets to semantic refs

## [30.0.0] - 2026-08-12

### Changed
- Expanded the side panel into a standalone window.

## [29.0.2] - 2026-08-12

### Changed
- dist: rebuild submission zips for v29.0.1
- fix: make store submission code reviewable

## [29.0.1] - 2026-08-11

### Changed
- dist: rebuild submission zips for v29.0.0
- fix: refine settings control order
- docs: add 29.0.0 changelog
- 29.0.0
- Clean up settings organization

## [29.0.0] - 2026-08-12

### Changed
- Reorganized Settings to surface frequently used controls and group advanced options more clearly.

## [28.2.3] - 2026-08-11

### Changed
- Add active provider filter

## [28.2.2] - 2026-08-11

### Changed
- fix streaming multipart offscreen uploads
- fix transcription runtime fallback transport
- fix chrome multipart offscreen fallback
- fix multimodal provider validation
- Fix anchored accessibility pagination
- Reset protected gallery state after URL reads
- Fix planner retry error handling
- Handle protected Chrome Web Store pages
- Fix planner provider compatibility and Act fallback

## [28.2.1] - 2026-08-11

### Changed
- version up
- fix: hide localized context menu instructions
- blog: publish EXL3 + SparkInfer on Blackwell lite post
- blog: add EXL3 + SparkInfer on Blackwell lite post (scheduled)
- Apply suggestions from code review
- feat: localize selection shortcuts
- fix: dedupe run progress replay gaps
- test(memory): cover newly formed memory cues
- style(memory): animate the Firefox memory cue
- feat(memory): render the Firefox memory cue
- feat(memory): notify the Firefox side panel
- feat(memory): mirror new-memory tracking in Firefox
- style(memory): animate the Chrome memory cue
- feat(memory): render the Chrome memory cue
- feat(memory): notify the Chrome side panel
- feat(memory): track newly formed memories

## [28.2.0] - 2026-08-11

### Changed
- Localized the selection shortcut and native context-menu items across all 23 supported interface languages in Chrome and Firefox, including action names, translation targets, status messages, right-to-left layout, and live language changes.
- Localized shortcut-generated prompts so responses follow the active interface language without exposing model-only language instructions in the visible conversation.

### Fixed
- Smoothed the effects of bounded run memory by showing a replay-gap notice only once per run, even as acknowledged event boundaries advance, while continuing to restore completed output after side-panel reconnects.

## [28.1.5] - 2026-08-11

### Changed
- fix: defer download intent normalization
- fix: recover planner localization and download intent
- test(onboarding): cover install guide transition
- fix(onboarding): advance Firefox install guide
- fix(onboarding): advance Chromium install guide

## [28.1.4] - 2026-08-11

### Changed
- version up
- fix: harden runtime mode recovery and trace diagnostics
- Apply suggestions from code review
- fix: localize Cloud Sync settings

## [28.1.2] - 2026-08-11

### Changed
- fix: preserve rich-text editor appends

## [28.1.1] - 2026-08-11

### Changed
- version up
- fix: enforce complete thread read coverage
- Fix restored compact tool details
- fix: honor complete thread read intent
- fix: require complete thread reads
- 28
- ci: make cloud smoke manual-only
- fix: toggle vision for custom local providers
- fix: detect vision for custom local providers
- fix: preserve local model capability identity
- feat: detect vision support for local providers
- Fix Ollama vision slash toggle
- Detect Ollama vision capabilities
- fix: address post-merge review findings
- feat: harden coupon domain refresh
- fix: call window.focus() before inputEl.focus() for focus-input command
- fix: use storage.onChanged for command dispatch instead of runtime.sendMessage
- docs: correct tab grouping visibility model
- fix(firefox): change focus-input shortcut from Ctrl+Slash to Ctrl+Period
- fix(firefox): add browser-level keyboard shortcuts via commands API
- test: preserve runner line endings
- test: cover automatic tab grouping opt-out
- feat(settings): add Firefox tab grouping preference
- feat(i18n): add zh Firefox tab grouping labels
- feat(i18n): add vi Firefox tab grouping labels
- feat(i18n): add uk Firefox tab grouping labels
- feat(i18n): add tr Firefox tab grouping labels
- feat(i18n): add tl Firefox tab grouping labels
- feat(i18n): add th Firefox tab grouping labels
- feat(i18n): add ru Firefox tab grouping labels
- feat(i18n): add pt Firefox tab grouping labels
- feat(i18n): add pl Firefox tab grouping labels
- feat(i18n): add nl Firefox tab grouping labels
- feat(i18n): add ms Firefox tab grouping labels
- feat(i18n): add ko Firefox tab grouping labels
- feat(i18n): add ja Firefox tab grouping labels
- feat(i18n): add id Firefox tab grouping labels
- feat(i18n): add hi Firefox tab grouping labels
- feat(i18n): add he Firefox tab grouping labels
- feat(i18n): add fr Firefox tab grouping labels
- feat(i18n): add fa Firefox tab grouping labels
- feat(i18n): add es Firefox tab grouping labels
- feat(i18n): add en Firefox tab grouping labels
- feat(i18n): add de Firefox tab grouping labels
- feat(i18n): add bn Firefox tab grouping labels
- feat(i18n): add ar Firefox tab grouping labels
- feat(settings): add Firefox tab grouping preference
- feat(settings): add Firefox tab grouping preference
- feat(settings): honor Firefox tab grouping preference
- feat(settings): honor Firefox tab grouping preference
- feat(settings): honor Firefox tab grouping preference
- feat(i18n): add zh tab grouping labels
- feat(i18n): add vi tab grouping labels
- feat(i18n): add uk tab grouping labels
- feat(i18n): add tr tab grouping labels
- feat(i18n): add tl tab grouping labels
- feat(i18n): add th tab grouping labels
- feat(i18n): add ru tab grouping labels
- feat(i18n): add pt tab grouping labels
- feat(i18n): add pl tab grouping labels
- feat(i18n): add nl tab grouping labels
- feat(i18n): add ms tab grouping labels
- feat(i18n): add ko tab grouping labels
- feat(i18n): add ja tab grouping labels
- feat(i18n): add id tab grouping labels
- feat(i18n): add hi tab grouping labels
- feat(i18n): add he tab grouping labels
- feat(i18n): add French tab grouping labels
- feat(i18n): add Persian tab grouping labels
- feat(i18n): localize Chrome tab grouping preference
- feat(settings): add Chrome tab grouping preference
- feat(settings): update Chrome agent tab grouping
- feat(settings): add tab grouping opt-out
- test: cover pinduoduo adapter
- agent: mirror pinduoduo adapter in firefox
- agent: add adapter for pinduoduo
- test: preserve run.js line endings
- ci: keep patch release changelog in sync
- test: cover patch release changelog ordering
- docs: backfill patch release changelog
- fix(captcha): serialize Cloudflare gate hydration
- fix(captcha): ignore unrelated response tokens
- fix(captcha): make English matcher additive
- fix(captcha): revalidate cleared token state
- fix(captcha): retire post-solve read inference
- fix(captcha): detect Cloudflare challenge pages
- ux improvements
- feat: generate coupon merchant coverage
- feat: add verified coupon code action
- documentation enhanced

## [28.1.0] - 2026-08-11

### Fixed
- Required complete communication-thread requests to read every page or expanded message before finishing, with multilingual intent handling and deterministic recovery across Chrome and Firefox.
- Restored compact tool-step **Details** controls after side-panel transcripts reload, including synchronized accessible expanded state in both browser builds.

### Tests
- Added mirrored coverage for complete-thread classification and pagination, premature-completion guards, bounded read windows, trace metadata, and restored compact detail toggles.

## [27.1.5] - 2026-08-08

### Changed
- Updated the LM Studio plugin for the current browser-delegation protocol.
- Added model-bound vision capability detection for llama.cpp, LM Studio, and LocalAI, with Auto / Force on / Off settings and fail-closed Chrome/Firefox request routing.

### Fixed
- Hid empty assistant placeholders until response content is ready to render.

## [27.1.4] - 2026-08-08

### Fixed
- Kept timed-out plan reviews visible and added an explicit retry path.

## [27.1.3] - 2026-08-08

### Fixed
- Corrected assistant response bubble width in the side panel.

## [27.1.2] - 2026-08-08

### Changed
- Expanded MCP setup and usage documentation.

### Fixed
- Reported API-mutation grants in the transcript and removed stale authorization presentation.

## [27.1.1] - 2026-08-08

### Changed
- Hardened CI integration and release security checks for the 27.1 series.

## [27.1.0] - 2026-08-08

### Added
- Added a value-free teacher mode (`/teach --start <name>` / `/teach --end`) that records a user's demonstrated clicks, field completions, checkbox/radio toggles, Enter submissions, and navigations into a tab-scoped session. The capture code never reads field values — only semantic identity — and every field action becomes a runtime parameter at the capture boundary. The session persists across navigation and compiles into the same `webbrain-workflow/1` format as successful runs. Automated runs are blocked while a teacher session is active for a tab.
- Added an interactive saved workflow manager (`/workflow`) to list, run, rename, export, and delete saved workflows in Chrome and Firefox.
- Added user-approved workflow locator healing: when a saved workflow target no longer matches uniquely, up to five independently replayable semantic candidates are presented for explicit single-selection. Approved replacements are applied atomically against the workflow's previous `updatedAt` value, so a concurrent edit wins instead of being overwritten; concurrent edits, unattended answers, and duplicate candidates can never authorize a healing.
- Added a WebBrain MCP server introduction blog post covering setup for Claude Code, OpenCode, Codex, and Cursor, the loopback security model, and how WebBrain MCP differs from headless browser tools.

### Changed
- Excluded WebBrain Cloud from per-run cost limits and metered dedicated vision provider costs separately, so vision-heavy WebBrain Cloud work does not count against the local/router cost allowance (Chrome and Firefox parity).
- Merged Cloud Bridge (MCP/LM Studio browser delegation) settings into Settings → General → Advanced → Cloud bridge, with synchronized setup guidance and the three bridge ports (MCP `17374`, LM Studio `17375`, WebBrain Cloud `17373`).
- Hardened screenshot and attachment handling: staged screenshots persist durably until delivery is confirmed at every call site, the per-turn screenshot budget charges only when a model actually receives the capture (vision description or attachment), redaction binds to capture time and scopes to rendered frames, and a child frame URL that cannot identify exactly one descriptor fails closed instead of risking mis-paired redaction regions.
- Did not stage a full-page screenshot when the capture-time privacy scan cannot prepare redaction geometry; the capture now reports `redactionUnavailable`, explains the blocker, and skips staging while still rendering the preview and save button (Chrome only).
- Removed the sticky API mutation badge from the Chrome and Firefox side panels. The `/allow-api` override now confirms once in the transcript instead of as a persistent composer badge.
- Passed trace run options through both Chrome and Firefox builds at startup.
- Allowed automatic i18n for AMO links and updated slash-command documentation across locales.

### Fixed
- Stopped sending automatic screenshots to text-only Ollama models by resolving the selected model's native `/api/show` vision capability before each run, with model- and case-sensitive-endpoint-bound caching, cancellable three-second metadata reads, legacy metadata fallbacks, live localized Auto / Force on / Off status, and Chrome/Firefox parity.
- Fixed a screenshot redaction fail-open path: the deferred full-page redaction now refuses the send when the snapshot had regions but `_redactScreenshotDataUrl` returned the bytes unchanged.
- Fixed `mergeRedactionFrameRegions` to return `null` under `requireCompleteFrameCoverage` when an object/embed subdocument or unpaired child frame has no DOM descriptor, instead of reporting the snapshot as complete.
- Fixed `loadStagedScreenshots` and `clearStagedScreenshots` to enumerate keys per-tab instead of reading all of `storage.local`, preventing 16 MB record churn on tab switch and reconnect.
- Fixed `consumePendingAttachmentsForTab` to key on `stagedAttachmentId` instead of object identity, preventing stale chips from wedging the composer after a rejection reconciled from storage.
- Fixed `reconcilePersistedStagedScreenshots` to only delete durable pixels on confirmed inclusion, preserving the user's only copy when delivery fails through a torn-down service worker.
- Fixed teacher submit capture and workflow cleanup to retain workflow claims and prevent stale submissions from clearing run claims prematurely.
- Preserved screenshots and attachments through terminal delivery, reconnect, and workflow replay, including cancelled-before-validation and unknown-delivery cases.

### Tests
- Added mirrored Chrome/Firefox coverage for teacher mode: value-free demonstration capture, session store normalization, automated-run rejection, Enter-as-submit semantics, and cross-browser slash-command wiring.
- Added mirrored coverage for the saved workflow manager, user-approved locator healing, atomic healing persistence with concurrent-update rejection, and workflow run-claim lifecycle.
- Added mirrored coverage for screenshot redaction fail-closed behavior, staged attachment recovery, viewport budget charging, full-page capture refusals, Cloud Bridge settings placement, and the WebBrain Cloud cost-limit exclusion.
- Updated `test/run.js` with the API badge removal assertions and the sidepanel authorization state checks.

## [27.0.0] - 2026-08-07

### Added
- Added the WebBrain MCP server so Claude Code, Codex, Cursor, OpenClaw, and other MCP clients can delegate Ask or Act tasks to an already-authenticated Chromium session through the local browser bridge, with tools for connection checks, status polling, clarification responses, and aborting runs.
- Updated the LM Studio plugin with the same authenticated-browser delegation through `browser_task`, `browser_status`, `browser_respond`, and `browser_abort`, while retaining its standalone `fetch_url` and `research_url` tools.
- Added a default-off persistent setting for API mutations and strict JSON Schema output support for WebBrain Cloud runs.

### Changed
- Hardened local bridge task handling across MCP and LM Studio with bounded command and run deadlines, resumable status polling, disconnect recovery, explicit run aborts, and actionable connection diagnostics.
- Improved Act follow-up routing and planner continuity so completed-step summaries remain available to later turns, and localized tool-completion status labels across Chrome and Firefox.

### Fixed
- Kept Ask-mode bridge runs read-only, rejected web-page WebSocket origins, preserved active runs across bridge disconnects, and prevented temporary API authorization or timeout state from leaking into later requests.
- Tightened WebBrain Cloud structured-output validation, secret redaction, public-URL handling, scheduled-job scoping, and run-ID generation without discarding valid schema-shaped results.
- Made iframe form automation fail closed on ambiguous targets and improved promoted-frame navigation, submission, and persisted-value verification in Chrome and Firefox.

### Tests
- Added MCP and LM Studio bridge suites covering connection handshakes, concurrent commands, polling, timeouts, clarification, aborts, disconnect recovery, and clean shutdown.
- Expanded WebBrain Cloud smoke scenarios and mirrored Chrome/Firefox regressions for structured output, privacy boundaries, iframe recovery, Act follow-ups, and localized completion states.

## [26.2.0] - 2026-08-06

### Changed
- Repaired minor release workflow ordering to ensure consistent build/publish sequencing.
- Rebuilt distribution zips for Chrome/Edge/Firefox to match the corrected release workflow.

### Fixed
- Fixed minor release workflow ordering issues that could lead to out-of-order release artifacts.

### Tests
- Updated `test/run.js` to align with the corrected minor release workflow behavior.

## [26.1.0] - 2026-08-05

### Added
- Added a Chrome and Firefox rich-text editor safety system that identifies formatting controls before text entry, uses visual confirmation when available, and requires a corrected, verified editor-body edit before a run can complete.

### Changed
- Unified toolbar classification across content scripts, DevTools Protocol targeting, iframe dispatch, and recovery so the same control is judged consistently through navigation and extension reinjection.
- Bounded safety captures within the configured per-turn screenshot budget while reserving the first guarded edit for structural or visual inspection.

### Fixed
- Prevented ordinary toolbar searches, compact composers, trusted focused fields, and labelled controls from being mistaken for formatting targets without supporting editor evidence.
- Kept recovery obligations attached to the correct editor, route, and frame across rerenders and navigation while preserving distinct live sibling frames.
- Failed closed on ambiguous cross-frame responses, conflicting geometry claims, and page-owned classifier substitutions without stranding a run in unrecoverable toolbar debt.

### Tests
- Expanded mirrored Chrome/Firefox regression and vision-probe coverage for toolbar variants, shadow DOM, nested iframes, navigation, screenshot limits, recovery deduplication, and verified corrected edits.

## [26.0.11] - 2026-08-05

### Changed
- Routed advice and drafting follow-ups through response-only handling when trusted conversation context is sufficient, even while Act mode is selected.
- Closed built-in tool schemas and made the runtime mode authoritative during execute tasks.
- Kept Turkish deasciification opt-in and instruction-only, with skill instructions loadable only from the enabled catalog after explicit conversion intent.
- Bounded Chrome and Firefox conversation, chat, and run-replay session snapshots so live work can continue safely when recovery persistence is unavailable.

### Fixed
- Rejected undeclared tool arguments and mixed click targets before dispatch with structured `invalid_tool_arguments` / `noDispatch` results.
- Suppressed planner-shaped JSON beside tool calls, retried planner-shaped terminals once, and replaced raw execute-protocol failures with a user-facing unverified-completion message.
- Prevented unknown required form values from being represented by empty focus, clear, or write actions.
- Normalized nested and object-shaped failures before UI, trace, and dedupe handling so `[object Object]` is never rendered.
- Made assistant-message Copy controls idempotent, added a localized **Copy message** label, and collapsed rejected `done` retries into one visible diagnostic row.
- Preserved acknowledged replay boundaries without false warnings while deduplicating genuine discarded-event gaps per request.
- Retried quota failures with compact snapshots, marked unrecoverable runs non-durable, warned once, and prevented consequential action replay after connection loss without deleting other tab/session data.

### Tests
- Added mirrored Chrome/Firefox coverage for closed schemas, disabled skill arguments, Act/planner enforcement, nested errors, Copy deduplication, replay boundaries, multi-tab quota exhaustion, attachment/screenshot compaction, and fail-closed reconnect durability.


## [26.0.10] - 2026-08-04

### Added
- Added a rich-text toolbar safety preflight that stops the agent from typing document text into an editor's formatting controls (font size, font family, style preset, colour, link). The target is scored structurally, confirmed against an annotated screenshot where a vision model is available, and blocked before dispatch; the run cannot report success until the edit is redone in the editor body and verified.

### Changed
- Text-entry tools now report verification as a positive proof only. `type_text`, `set_field`, and `iframe_type` mark an edit `verified` when the field's final value proves it landed and stay silent otherwise, instead of reporting an unproven edit as refuted. Masked inputs, `maxlength` truncation, framework-reformatted fields, and whitespace-normalising rich-text bodies no longer register as failed actions.
- `iframe_type` now binds its dispatch to a single resolved frame when a toolbar recovery is pending, and reports the candidate frame URLs so a `urlFilter` can disambiguate them. Ordinary calls keep the previous all-frames behaviour, so pages with repeated same-origin frames continue to work unchanged.
- Moved the toolbar heuristic into one shared module used by both browser builds and by the DevTools Protocol probe, so an element scores the same whichever dispatch route reaches it.

### Fixed
- Fixed the toolbar preflight taking a screenshot that was then discarded, which cost an extra capture and vision call on every guarded edit.
- Fixed the toolbar preflight treating `[role="toolbar"]` ancestry as evidence on its own. An ordinary labelled field in an app toolbar scored high enough to escalate, so with no vision model available the guard blocked prose typed into it and held the run open on a recovery that could never be discharged. A control now also needs a formatting label, a numeric preset value, or a toolbar whose editor body resolves.
- Fixed the append verification rescanning a field's full contents at every candidate position with arbitrary-precision arithmetic, which could stall a page holding a large rich-text document.
- Fixed the cross-frame geometry handshake accepting whichever frame answered first; a second frame claiming the same exchange now fails it closed.
- Fixed toolbar classifier screenshots escaping the per-turn screenshot budget. They now share the cap with the captures the model sees, so the number you configure bounds the vision spend. The first safety capture of a turn is still reserved, so a low cap degrades the check to structural scoring rather than blinding it on the first guarded edit, and both the reserved capture and the fall-back are surfaced.
- Fixed a navigation during an open toolbar recovery stranding the debt without the state that discharges it, which left the guard inactive for the rest of the run while completion stayed blocked and no corrected edit could clear it. An editor whose only recovery handle was a page-scoped ref now carries across as unknown-target recovery instead of being dropped.
- Fixed selector preflights trusting a page-owned toolbar-classifier global; the DevTools Protocol path now captures only the packaged classifier and fails closed when that source cannot be loaded.
- Fixed navigation and extension-recovery paths duplicating one semantic editor obligation or reinjecting `content.js` without its toolbar classifier. Child-frame scope survives navigation while live sibling frames remain distinct.

### Tests
- Added mirrored Chrome/Firefox coverage for the verification contract, the `iframe_type` fallback, the toolbar heuristic's false positives, and the recovery contract, and pinned the heuristic to a single implementation across both builds and the DevTools Protocol probe.
- Added mirrored Chrome/Firefox coverage for the debt and state maps agreeing across a navigation, in both directions: an obligation that loses its ref stays dischargeable, and a debt nothing can discharge is dropped with its state.

## [26.0.0] - 2026-07-26

### Added
- Added non-blocking local browser runs: regular Chrome and Firefox tasks stay pinned to their original tab without activating it or stealing window focus, while `/foreground [prompt]` provides a one-run compatibility escape hatch for sites that must render visually in the foreground.
- Added offline converters for exported traces in Agent Trajectory Interchange Format (ATIF) and OpenTelemetry Protocol (OTLP), with documentation and regression coverage.
- Added an accessible in-panel **New conversation** confirmation that works when Vivaldi Web Panels suppress native browser dialogs.

### Changed
- Rebuilt CAPTCHA handling around frame-aware challenge detection and targeted response injection for reCAPTCHA, hCaptcha, and Turnstile, including branded-dialog and ancestor-loader recognition, cross-frame verification, manual-completion recovery, explicit gate abandonment, and fail-closed handling for ambiguous or conflicting candidates.
- Isolated selected-text context from independent, scheduled, cloud, and saved-workflow runs while preserving grounded follow-ups, attachments, compaction, and shortcuts within the originating selection conversation.
- Extended the rapid duplicate-submit guard to Firefox and made acknowledged resubmits re-arm the protection window in both browsers.
- Refreshed and reorganized the English, French, and Chinese documentation, landing-page demos, language ordering, and agent/skills/slash-command references.
- Polished the floating chat-navigation control, linked Settings title behavior, full-screen recording status, and slash-command keyboard actions.
- Extracted shared loop-detection, image-budget, and text tool-call parsing helpers without changing their browser parity.

### Fixed
- Rejected blank Chrome full-page captures, improved background screenshot compatibility, and verified inactive Firefox tabs before declaring a run complete.
- Fixed CapSolver key migration so valid saved `CAP-` keys enable solving consistently while malformed keys remain disabled.
- Fixed selection-scoped history, workflow, attachment, and navigation paths that could leak context into unrelated runs.
- Fixed CAPTCHA frame visibility, challenge correlation, response-field targeting, token fallback, and recovery after redirects or manual completion.
- Fixed the full-screen recording message so it matches whether the recording indicator is actually visible.

### Tests
- Added mirrored Chrome/Firefox regression coverage for background runs, inactive-tab capture, CAPTCHA gating and injection, selection-scope isolation, duplicate-submit protection, trace conversion, and the updated UI flows.

## [25.9.0] - 2026-07-25

### Added
- Added 76 new LLM providers (icons, docs, and README updates across English, French, and Chinese) alongside interactive Ask-mode streaming support for the expanded provider list.
- Added a `/watch` slash command with conditional scheduler polling, alerts on distinct successful events, dedupe-aware helper-tab cleanup, transient-failure tolerance, and locale/docs coverage.
- Added reCAPTCHA Enterprise support to the Chrome CapSolver agent tool, including v3/Enterprise widget and script detection across DOM, URL, and iframe paths, an `isEnterprise` schema field, and clearer parameter-vs-dispatch error triage.
- Restyled sidepanel tabs in Chrome and Firefox, with resize and RTL layout fixes.
- Published workflow export/import format documentation.

### Changed
- Centralized text sanitization and shared UI utilities and standardized provider message logic across Chrome and Firefox, including a Firefox utils dedup follow-up.
- Hardened interactive Ask streaming: traced the streaming run lifecycle, preserved trace ordering, redacted JSON-shaped streaming secrets, and fixed duplicate normalized streamed answers.
- Hardened chat/run clearing and cancellation: kept the composer locked while clearing, bounded unavailable stop-state probes, waited for stopped/local/direct run followers before clearing, suppressed updates from cleared runs, guarded the Stop fallback and stopped runs until a terminal state, scoped New Chat aborts to their originating tab, discarded queued prompts before clearing, stopped active runs before starting new chats, and cancelled schedules once active runs settle.
- Added WebBrain Cloud interface strings and microphone permission messages to all locales, refreshed the evroc provider icon and provider counts, and updated Discord links and added a Chinese community section to the docs sidebars.
- Disabled the mode-pill animation for `prefers-reduced-motion`.

### Fixed
- Fixed detached side panel window routing in Chrome.
- Recovered workflow replay from a start-scope mismatch.
- Parsed action parameters with `URL.searchParams` to preserve decoded characters.
- Preserved pending upload evidence and fixed `find_text` selection verification and advancement.
- Fixed store submission automation.

### Tests
- Added mirrored Chrome/Firefox coverage for CapSolver Enterprise version/edition/action detection and error triage, `/watch` polling and dedupe behavior, and the centralized UI/text-sanitization utilities.

## [25.8.0] - 2026-07-23

### Added
- Added Inkling planner benchmark (OpenRouter default, Chrome thinkingmachines/inkling frozen fixtures) and published the corresponding benchmark docs/blog page.

### Changed
- Improved sidepanel UI polish for picker controls and the language menu.
- Added new UI locales for **de** and **nl**, including flag assets, and updated locale ordering/initialization to match expected dropdown behavior in both **Chrome and Firefox**.
- Updated provider/model documentation and synced docs with recent streaming requirements (including explicit Mistral stream usage guidance).
- Enabled Ask streaming behavior updates across providers while aligning provider-specific streaming/usage expectations.
- Rebuilt distribution zips for Chrome/Edge/Firefox.

### Fixed
- Fixed locale dropdown initialization and ordering issues (including missing locale pieces for **nl**/**de**).
- Avoided retrying terminal Ask stream errors to prevent incorrect fallback behavior.
- Corrected provider streaming usage handling for Mistral Ask (ensuring required usage/stream events are used as documented).
- Preserved provider-specific streaming compatibility rules (e.g., keeping Alibaba Ask non-streaming where required).

### Tests
- Added Inkling planner benchmark result fixtures to the test suite (Chrome thinkingmachines/inkling frozen set).

## [25.7.12] - 2026-07-23

### Changed
- Expanded interactive Ask streaming from GPT-5.6 to documented streaming- and function-calling-capable official OpenAI models, while keeping GPT-5.5 Pro and other unsupported variants non-streaming.
- Routed Responses-only GPT-5 Pro variants through the Responses API and retained Chat Completions streaming for other supported OpenAI models.
- Enabled interactive Ask streaming for Anthropic, Azure OpenAI, Gemini, DeepSeek, xAI, Mistral, Nvidia NIM, Groq, Together AI, Fireworks, z.ai, OpenRouter, WebBrain Cloud, llama.cpp, Ollama, LM Studio, Jan, vLLM, SGLang, and LocalAI with provider-specific terminal-event validation.
- Generalized the Advanced streaming control and made safe transport/protocol fallback silent: the affected generation retries non-streaming once, then streaming stays disabled for the rest of that run.

### Fixed
- Treat premature official OpenAI Chat Completions stream EOF as an interrupted generation, clearing partial text and retrying once through the non-streaming path.
- Normalized GPT-5 Pro reasoning effort to its supported `high` value.
- Propagated explicit Chat Completions, Anthropic, and Azure in-stream API error events instead of accepting a later terminal sentinel as success; HTTP/API errors never trigger the silent fallback.
- Rejected OpenAI-compatible and Azure streams that finish with `content_filter`, clearing any partial text instead of persisting a filtered response or retrying it non-streaming.
- Added the documented `gpt-5.2-chat-latest` model to official OpenAI Ask streaming capability detection.
- Hardened llama.cpp streaming with readable-body, malformed-frame, explicit-error, usage, reasoning, and terminal `[DONE]` handling before enabling its silent non-streaming fallback.
- Added z.ai's required `tool_stream` request option for streaming generations that expose agent tools.
- Preserved Groq token usage delivered in the provider-specific `x_groq` streaming envelope.
- Rejected z.ai streams that finish with `sensitive`, `network_error`, or `model_context_window_exceeded` instead of persisting partial output as a successful response.
- Kept Alibaba Cloud Ask calls non-streaming because DashScope rejects its required `tools` payload when `stream: true`.
- Requested Mistral streaming usage events explicitly so interactive Ask turns remain included in cloud cost allowances.
- Preserved in-progress streamed Markdown across side-panel/sidebar closes, reloads, and reconnects in Chrome and Firefox.
- Rebuilt restored streams from the background-owned UI journal without duplicating deltas, losing Markdown structure, or leaving an unfinished stream in its incremental render state.

### Tests
- Added mirrored Chrome/Firefox coverage for OpenAI streaming capability detection, GPT-5.4 Pro routing, Chat Completions completion sentinels, and transport fallback.
- Added mirrored capability, terminal-event, malformed-frame, explicit-error, content-filter, and silent one-time fallback coverage for the newly enabled providers.
- Added mirrored regression coverage for persisted streamed text, reconnect replay, restored finalization, and journal size limits.

## [25.7.11] - 2026-07-23

### Fixed
- Ranked provider Settings search results by exact provider name/ID, then prefix, then substring matches while preserving the configured provider order for ties.

### Tests
- Added Chrome and Firefox provider-search ranking coverage.

## [25.7.10] - 2026-07-23

### Fixed
- Rendered streamed assistant output as Markdown while deltas arrive and finalized the same message when the terminal response is received.
- Replaced rejected or corrected streamed terminal content instead of appending a duplicate response.
- Finalized restored streamed responses consistently after reconnect.

## [25.7.9] - 2026-07-23

### Changed
- Refined reading-first navigation so new questions remain visible while long responses grow, explicit reader positions are preserved, and restored chats return to the latest turn.
- Added floating **Follow response**, **Jump to latest**, and **Back to question** controls for clipped long replies.

### Fixed
- Kept Continue bars, plan/clarification prompts, store-review prompts, new questions, and slash-command output visible when they require attention.
- Resumed live follow after an explicit jump to the response edge without overriding deliberate reading positions.

## [25.7.8] - 2026-07-23

### Added
- Added reading-first navigation for long replies across Ask, Act, and Dev modes in Chrome and Firefox.

### Removed
- Removed the packaged Chrome Web Store release skill, its privileged upload/publish routing, setup UI, dashboard adapter, protected-page exception, and previously seeded local skill records.

### Fixed
- Kept blocking prompts and slash-command output visible without losing live follow when a run resumes.
- Kept the navigation control available whenever response content extends below the viewport.

### Tests
- Added mirrored long-reply navigation, localization, restored-turn, and instant auto-follow regression coverage.

## [25.7.6] - 2026-07-22

### Added
- Added portable saved workflow JSON export and import commands with Chrome and Firefox parity.

### Changed
- Updated the official OpenAI model picker to list current dated model variants.
- Portable workflow imports are normalized, size-bounded, assigned fresh local identity, and rejected when unsafe or over the saved-workflow limits.

### Tests
- Added mirrored portable workflow parsing, file transfer, redaction, fresh-identity, and account-limit coverage.

## [25.7.0] - 2026-07-22

### Added
- Added safe saved workflow schema and UI support for saving and managing traced runs (Chrome and Firefox parity).

### Changed
- Updated workflow replay to use the new safe saved workflow schema, improving reliability and reducing brittle replay behavior (Chrome and Firefox parity).
- Updated documentation for privacy/data flow and security model to reflect saved workflow/replay behavior.

### Fixed
- Guarded workflow replay by page scope to prevent cross-page/brittle replays.
- Rejected brittle selector replay during saved workflow replay to avoid incorrect actions.
- Improved workflow replay safety by replaying saved actions in a more controlled manner.
- Closed workflow gaps for save, replay, and telemetry to ensure consistent end-to-end behavior (Chrome and Firefox parity).

### Tests
- Updated test runner (`test/run.js`) to align with the saved workflow/replay changes.

## [25.6.0] - 2026-07-22

### Added
- Added Ask-only OpenAI Responses streaming for interactive Ask-mode chats (Chrome and Firefox parity).

### Changed
- Updated planner benchmark coverage by adding Nanbeige 4.2 planner benchmark results to the repo.

### Fixed
- Improved structured plan review/editor stability by preserving editor scroll position across input and keeping step editing scroll stable (Chrome and Firefox parity).

### Tests
- Added Nanbeige 4.2 planner benchmark fixtures/results to the test suite.

## [25.5.0] - 2026-07-22

### Added
- Added a default-on Advanced setting to disable OpenAI Ask response streaming immediately and return new chats to the established non-streaming provider path.
- Improved plan review with structured, in-place editing (Chrome and Firefox parity).

### Changed
- Official OpenAI Responses calls now stream visible text for interactive Ask-mode chats while retaining the detached `chat_start` lifecycle, reconnect journal, and image/text attachment handling.
- Tool calls and assistant-history persistence remain buffered until `response.completed`; Act, Dev, scheduled, cloud, and Continue runs remain on `provider.chat()`.
- Drag-and-drop reordering of planner steps.
- Hardened mixed plan editor modes to keep editing behavior consistent.
- Preserved multiline plan step edits during editing and review flows.
- Preserved collapsed raw plan approvals through review.
- Preserved raw plan edits after review.
- Stripped canonical plan tool suffixes for cleaner plan tool display.

### Fixed
- Interrupted OpenAI Ask transports now clear their partial visible text, open a per-run circuit breaker, and retry through `provider.chat()` without accepting incomplete tool calls or persisting an incomplete assistant turn; terminal HTTP, API, and `response.incomplete` errors propagate without a duplicate fallback request.
- Live Ask text deltas remain immediate while durable reconnect snapshots are coalesced on a short trailing interval, avoiding a full journal clone and `storage.session` write for every SSE chunk; terminal updates and tool checkpoints still flush immediately.
- Fixed plan review scroll behavior and the run label during plan review/editing.
- Kept plan step editing scroll stable while interacting with the editor.
- Captured plan editor scroll before input to prevent scroll jumps.

### Tests
- Added mirrored Chrome/Firefox coverage for streaming scope, attachment delivery, terminal tool-call gating, coalesced reconnect persistence, detached lifecycle wiring, the kill switch, and transport-only non-streaming fallback.
- Updated test runner (`test/run.js`) to align with the new plan editor/review behaviors.

## [25.4.2] - 2026-07-22

### Added
- Added a default-disabled packaged Chrome Web Store release skill with trusted status, ZIP upload, and publish tools backed by the official v2 API in Chrome and Firefox.
- Added skill-scoped setup for user-owned Google OAuth credentials, publisher/item IDs, and an explicitly selected local release ZIP.

### Changed
- Added a Chrome Web Store dashboard adapter that routes enabled runs to the release skill instead of protected DOM controls.

### Fixed
- Added an always-on Chrome protected-page guard for the Chrome Web Store Developer Dashboard so DOM tools fail immediately and non-retryably instead of entering wait/read retry loops.

### Security
- Kept OAuth tokens and release ZIP bytes in extension-local storage and out of model prompts, tool arguments, traces, and tool results; upload and publish remain behind consequential-action permission and submission gates.

## [25.4.0] - 2026-07-21

### Added
- Added round-trip automatic progress policy to improve completion reliability across the full submit → completion → evidence loop.

### Changed
- Updated OpenAI model invocation to use `gpt-5.4-nano-2026-03-17` with `max_completion_tokens`.
- Preserved reviewed submit requirements across continuations to keep validation consistent when a run resumes.
- Hardened submit completion evidence requirements (including final-form completion evidence) to reduce false positives.
- Improved submit-state reconciliation by carrying submit verification across continuations and reconciling from screenshot URLs.
- Updated Chrome and Firefox builds to reflect the above completion/submit policy changes for parity.

### Fixed
- Prevented completion guard loops and stopped stale calls after completion-page blocks.
- Tightened completion success evidence to avoid accepting incomplete or uncertain outcomes.
- Improved handling of validation failures so they remain blocking for completion.
- Fixed CI/release robustness issues related to changelog prompt parsing and release-context substitution.

### Tests
- Added/expanded CI grading and E2E coverage to diagnose Gnippets HTTP failures and validate cloud E2E control requests.
- Added CI robustness improvements for unattended runs (disabling action prompts) and tightened grading inputs (e.g., accepting camelCase final URLs in CI grading).

## [25.3.0] - 2026-07-21

### Added
- Added initial release note scaffolding for WebBrain.

### Changed
- Updated OpenAI model usage to **gpt-5.4-nano-2026-03-17** and switched to `max_completion_tokens` for completion limits.
- Switched WebBrain Cloud provider integration from **GitHub Models** to direct **OpenAI API** calls (using `OPENAI_SECRET` via curl), improving consistency across providers.
- Updated Chrome and Firefox builds to reflect the provider/model changes and associated configuration/UI updates.

### Fixed
- Resolved model-parameter compatibility issues by ensuring `max_completion_tokens` is used where required (avoids deprecated `max_tokens` errors).
- Corrected prior provider model ID handling during the transition away from GitHub Models.
- Improved release/changelog generation robustness by avoiding YAML parsing issues in the release prompt pipeline.

### Tests
- Added/expanded CI grading and E2E infrastructure coverage to better diagnose HTTP failures and validate cloud E2E control requests.
- Added CI robustness improvements for unattended runs (disabling action prompts) and tightened grading inputs (e.g., accepting camelCase final URLs).

## [25.2.0] - 2026-07-21

### Added

### Changed

### Fixed

### Tests
- Comprehensive test suite established for validating core functionality and browser compatibility.

## [25.0.0] - 2026-07-19

### Added
- Added runtime completion invariants in Chrome and Firefox that track consequential actions, require a fresh successful observation before accepting a success claim, and preserve verification obligations across batched calls, trusted continuations, restored runs, and scheduled tasks.
- Added localized permission education after repeated action prompts, with an onboarding note and a safe action that inserts `/dangerously-skip-permissions` for the specific pending prompt without overwriting an existing draft.
- Added a permanent, fully localized **Tweet about WebBrain** recommended action that opens X's visible composer, publishes reviewed language-specific copy without asking the model to write or translate it, then verifies and reports the post URL when available.

### Changed
- Action runs now reject plan-only, empty-step, promise-only, and premature terminal replies and continue into execution; explicitly requested plans and Markdown plus honest structured blockers remain valid results.
- Completion enforcement now distinguishes real dispatch from preflight failures, accepts only model-visible state observations, self-verifies successful scheduler writes, and preserves the intended Compact Dev and managed-cloud execution boundaries.

### Fixed
- Prevented stale tool calls from running after a rejected `done`, cleared rejected streamed plan text before recovery, preserved terminal obligation and session metadata, and rejected stale or same-batch completion evidence.
- Repaired high-confidence double-escaped assistant Markdown returned by OpenAI-compatible backends without rewriting legitimate code, paths, or escape-sequence examples.
- Hardened accessibility actions with document- and SPA-route-scoped refs, fresh-target and visibility checks, canonical accessible names, iframe dispatch tracking, and safer guarded-click progress detection, preventing stale clicks and false agent stops.
- Made `set_field` wait for controlled and rich-text editors to settle and require an exact normalized readback before submitting; failed sensitive-field readbacks no longer expose typed values.
- Corrected false completion blocks for denied, skipped, or pre-dispatch actions; pre-existing targets; input and CAPTCHA preflight failures; screenshots not visible to the model; observed non-success outcomes; and self-verified scheduled tasks.

### Tests
- Expanded mirrored Chrome and Firefox regression coverage for plan-to-execution handoffs, completion-invariant state and recovery, permission education and tab scoping, assistant-text repair, accessibility refs and field verification, and exact localized WebBrain post copy.

## [24.4.0] - 2026-07-18

### Changed
- Add guarded CDP click fallback + full screenshot bugfix

## [24.3.1] - 2026-07-18

### Changed
- Chrome `click_ax` stays synthetic-first and may issue one guarded CDP trusted-click fallback only after no observable progress on safe generic targets (visibility, hit-test, interactive-descendant, form/download/mutating/stateful exclusions).
- Trusted-click progress proof ignores whole-page text churn and blur-only focus loss; safety vetoes skip automatic retry without rewriting working clicks to failure.

### Fixed
- Removed invalid CDP `Input.enable` usage; trusted mouse events dispatch directly.
- Observation windows for fallback candidates poll progressively so slower SPA handlers can still prove progress before a second click.

### Tests
- Added unit and fixture coverage for eligibility gates, one-shot fallback accounting, network/beacon vetoes, and post-CDP target-state verification.

## [24.3.0] - 2026-07-17

### Changed
- Replaced the first-install fake toolbar walkthrough with a real **Open Side Panel** action in Chromium and **Open Sidebar** action in Firefox.
- Added an accessible Chromium first-open coachmark that points to the browser's actual side-panel pin, mirrors its arrow for left-side layouts such as Vivaldi, and clearly distinguishes that pin from the toolbar icon it adds.
- Kept Firefox guidance aligned with its native Extensions menu and refreshed the install flow across all 16 supported locales.
- Report the browser-resolved absolute path after WebBrain screenshots, recordings, transcripts, and run captures finish saving, including configured subfolders and uniquified filenames.

### Fixed
- Removed non-interactive toolbar and extension-menu illustrations that looked clickable but could not complete setup.
- Sequenced the Chromium pin coachmark before the existing model and safety onboarding so first-time setup has one clear action at a time.
- Kept keyboard focus inside the pin coachmark while it is open and added an explicit **Skip this step** exit so first-run setup cannot strand the user.
- Prevented early install-page clicks from disappearing, kept first-open tabs in the normal WebBrain panel group, and replaced premature success styling with browser-specific recovery guidance.

### Tests
- Added Chrome and Firefox coverage for real panel opening, first-install coachmark state, modal focus handling, explicit dismissal paths, left/right arrow layout, native Firefox wording, responsive behavior, reduced motion, and locale parity.

## [24.2.0] - 2026-07-17

### Changed
- Add Kimi provider support

## [24.1.0] - 2026-07-16

### Changed
- import/export configs

## [24.0.2] - 2026-07-16

### Added
- Added `/export --config` to download a portable JSON snapshot of settings and `/import <json>` or `/import --file` to restore one in Chrome and Firefox.
- Included provider, vision, transcription, and CAPTCHA API keys in configuration snapshots, with an explicit plaintext-secret warning before export and import.

### Changed
- Limited configuration snapshots to settings-backed state, excluding device-bound sync identifiers and tokens, conversations, traces, jobs, and usage counters.

### Tests
- Added mirrored coverage for configuration schema completeness, round trips, validation failures, file selection, slash-command routing, and background import/export handlers.

## [24.0.1] - 2026-07-16

### Added
- Added hidden trailing `/record [--save-as <filename>]` and `/screenshot [--save-as <filename>]` prompt suffixes. Recording now wraps a Chrome run and saves automatically; screenshot capture saves timestamped or custom-named before/after PNGs in Chrome and Firefox. The suffixes remain intentionally absent from `/help` and autocomplete.

### Fixed
- Kept agent-created reference tabs in the background so Chrome and Firefox runs remain visibly attached to their original tab.
- Detected Firefox-protected Mozilla domains before blocked DOM or network reads, used one active-tab screenshot fallback where possible, and stopped equivalent non-retryable attempts instead of looping.
- Treated Responses streams that end without `response.completed` as incomplete instead of persisting partial output as a successful turn.
- Preserved unsaved custom request-body JSON drafts across provider search, filtering, and card re-renders, including temporarily invalid JSON while editing.
- Re-activate the originating run tab before the after screenshot when a run opens another tab.
- Restored Mozilla Add-ons developer adapter matching after the hostname-hardening matcher rename.
- Rebuilt the Chrome, Edge, and Firefox 24.0.1 archives from the final source tree.

### Tests
- Added regression coverage for background tab ownership, Firefox restricted-domain handling, bounded read retries, premature Responses stream termination, and compatibility JSON draft persistence.
- Added mirrored parser, filename sanitization, lifecycle ordering, Downloads saving, Chrome recorder identity, and Firefox unsupported-recording coverage for hidden run capture.

## [24.0.0] - 2026-07-16

### Added
- First-class **GPT-5.6** support for official OpenAI: default model `gpt-5.6-terra`, UI suggestions for Terra / Sol / Luna, and a **1,050,000**-token context window for the `gpt-5.6*` family.
- Official OpenAI GPT-5.6 routes through the **Responses API** (`/v1/responses`) with encrypted reasoning replay (`response_items`), function-call conversion, streaming, and usage normalization. Older models and custom/proxy base URLs stay on Chat Completions.
- **Advanced model compatibility** settings on every provider card: preset (Auto / OpenAI / Qwen / DeepSeek / OpenRouter / Custom), reasoning effort, system vs developer role, max-token field, and safe custom request-body JSON.
- Shared `provider-compatibility.js` layer (Chrome + Firefox) that maps roles, token fields, reasoning knobs, and merges protected extra body fields for OpenAI-compatible, Azure OpenAI, and llama.cpp request builders.
- Documented the release in `WHATS_NEW_IN_V24.md` at the repository root.

### Changed
- OpenAI-compatible request building is centralized so compatibility presets apply consistently without mutating stored chat history.
- OpenAI default cost metadata migrates safely when upgrading from earlier shipped defaults.

### Tests
- Added / retained coverage for Responses routing, reasoning replay, streaming, provider-compatibility merges, GPT-5.6 context windows, and default-model migration.

## [23.3.6] - 2026-07-15

### Added
- Added a default-on **Help Improve WebBrain** control at the bottom of the visible Settings → General area in Chrome and Firefox. WebBrain Cloud requests now send the current choice as `X-WebBrain-Help-Improve: 1` or `0`; local-model and bring-your-own API requests never receive that header.

### Changed
- Updated the public privacy policy and developer data-flow documentation to disclose selected WebBrain Cloud interaction retention and model-improvement use, the future-interaction opt-out, a 12-month raw-data limit, and a five-year limit for de-identified datasets.
- Added opaque per-conversation WebBrain Cloud session grouping across main, planner, compaction, intent, memory, and vision generations, with permanent opt-out tainting and no collection metadata on local or bring-your-own providers.
- Added encrypted, compressed, text-and-tool-only Cloud improvement storage with image omission, authenticated session browsing, de-identified JSONL export, 12-month pruning, and isolated OpenRouter logging/no-logging key routing.

### Tests
- Added mirrored coverage for the default-on UI, persistence and live provider reload, Cloud-only request headers, locale completeness, and privacy-policy retention language.

## [23.3.3] - 2026-07-15

### Changed
- Clarify timeout slider semantics: **0 = Instant** (always auto-select the first option), **1–1200s = wait then auto-select**, and **above 1200s (slider max / Off) = wait indefinitely**. Existing stored `0` (old Off) migrates once to Off.
- Instant clarify auto-selects use `source=auto` and tell the agent to continue (intentional unattended policy, e.g. headless); only waited `source=timeout` keeps the non-confirmation warning.

### Tests
- Updated Chrome and Firefox clarify-timeout coverage for Instant / Off slider endpoints, one-shot semantics migration, and Instant vs waited-timeout agent notes.

## [23.3.2] - 2026-07-15

### Added
- Added a configurable clarify auto-timeout (default 60s, 0–1200s under Settings → General → Advanced) for Chrome and Firefox. Unanswered `clarify` prompts auto-select the first option (or a timeout marker when options are empty); permission and form-submit confirmations stay untimed.

### Changed
- Documented that timeout auto-selects are not real user confirmations in the `clarify` tool schema and system prompts, and kept timeout answers out of user-memory extraction.

### Fixed
- Cleared scheduled-job `needs_user_input` / `pendingClarify` on clarify auto-timeout without replaying a start-of-run `running` event that could orphan the original assistant bubble.
- Restarted clarify countdown metadata after sidepanel restore/rebind so closed panels do not leave stale open cards.

### Tests
- Added Chrome and Firefox regression coverage for clarify timeout settings, schema/prompt guidance, scheduler wait-state cleanup, restore countdown metadata, and memory exclusion of timeout sources.

## [23.3.1] - 2026-07-15

### Changed
- Added bounded canonical semantic intents to the shared on-demand skill catalog so the planner and `load_skill` can route multilingual requests without literal keyword matching or an extra embedding call.
- Let approved Act plans activate validated skill IDs before execution, with Dev inheriting Act-compatible skills, Ask limited to explicitly compatible skills, and Compact remaining skill-free.
- Added recording and exporting WebBrain versions to new traces, conversation Markdown, trace Markdown, and Traces-page JSON while labeling legacy recording versions unavailable.

### Fixed
- Redirected single-media browser download attempts to an eligible inactive FreeSkillz skill, including exact-permalink discovery on feeds and profiles, while preserving browser fallback only after a real server failure or unavailable skill.
- Prevented the agent path from saving split or unverifiably muxed MSE audio/video buffers or presenting ffmpeg and login advice as a successful result.

### Tests
- Added Chrome and Firefox coverage for intent normalization and catalog isolation, planner activation and rejection, multilingual routing metadata, inactive-skill redirects, strict MSE refusal, and versioned current and legacy exports.

## [23.3.0] - 2026-07-15

### Changed
- Load browser skills on demand

## [23.2.2] - 2026-07-15

### Changed
- Made enabled skills available on demand: Mid/Full Ask, Act, and Dev runs receive a small eligible name/summary catalog, full instructions and compatible tools load only for the current relevant run, and Compact exposes no skill surface.
- Added optional prompt-stripped `webbrain-skill` metadata for capped summaries and explicit Ask/Act compatibility while preserving existing skill storage and `webbrain-tools` manifests.

### Fixed
- Replaced ambiguous Content-Disposition filename matching in Chrome and Firefox public-media downloads with a bounded single-pass parameter parser that preserves RFC 5987 precedence and fails closed on malformed quoted values.

### Tests
- Added mirrored coverage for skill catalog eligibility, activation isolation and reset, strict-secret ordering, recommended-action preactivation, and adversarial Content-Disposition filename parsing.

## [23.2.0] - 2026-07-14

### Added
- Added an opt-in packaged Litterbox temporary file-share skill for Chrome and Firefox, available from Settings with explicit `clarify` confirmation, public-link and absolute-expiry warnings, blocked-file preflight checks, browser-specific upload limits, and visible provider attribution. Uploads go through the Litterbox page with `upload_file`, so no `/allow-api` override is needed and file bytes never reach the LLM provider.
- Added opt-in Open-Meteo weather and Open Library book-search skills for Chrome and Firefox. The read-only, no-key integrations clarify ambiguous locations, keep metric and imperial weather units consistent, limit catalog responses, treat provider data as untrusted, and show visible source attribution.
- Added disabled-by-default Together AI and Fireworks OpenAI-compatible router providers for Chrome and Firefox, including Settings fields, suggested models, configurable endpoints, API-key links, and streaming-usage support.

### Changed
- Classified Together AI and Fireworks consistently as router providers and migrated older saved category values without dropping stored credentials.

### Fixed
- Prevented host-page capture listeners from intercepting keyboard input inside the selection shortcut by loading its containment handler at `document_start` and isolating keydown, keypress, and keyup events.
- Kept the selected text visibly highlighted while the selection menu is open, bounded the overlay to 200 visible rectangles, and cleared highlights when the menu closes or is dismissed.

### Tests
- Added packaged-skill catalog and Litterbox safety, privacy-disclosure, upload-flow, browser-limit, and expiry coverage.
- Added Chrome and Firefox coverage for Open-Meteo units and tool manifests, Open Library search and attribution, Together AI and Fireworks provider defaults and migrations, and selection-shortcut keyboard containment and bounded highlights.

## [23.1.2] - 2026-07-14

### Added
- Added universal `<command> --help` support for slash commands, returning the selected command's usage, description, and available options directly in chat.
- Published the WebMCP integration blog post.

### Fixed
- Made Enter accept highlighted slash-command flag completions such as `/schedule --list` without prematurely executing the parent `/schedule` command.
- Restored intentional localized formatting in trusted composer toasts while keeping dynamic error text escaped.

### Tests
- Added Chrome and Firefox regression coverage for command-specific help, flag autocomplete ordering and completion, invalid mixed help flags, and trusted toast rendering.

## [23.1.0] - 2026-07-14

### Added
- Added `/export --traces` in Chrome and Firefox to download the current conversation's recorded planner turns, assistant prose, and tool calls as privacy-scrubbed Markdown while keeping `/export` messages-only.
- Added safe syntax highlighting for fenced Markdown code blocks in both side panels across JavaScript, CSS, markup, JSON, Python, shell, SQL, YAML, and C-like languages.
- Published the NVIDIA GLM-5.2 planner benchmark blog and complete frozen, Full, Mid, and Compact 100-case result sets.

### Changed
- Consolidated overlapping slash commands around canonical commands and flags, including `/schedule --list`, `/scratchpad --append` / `--clear`, `/memory --add` / `--forget`, `/screenshot --full-page`, `/record --full-screen` / `--transcribe`, and `/export --traces`, with flag-aware help and autocomplete.
- Changed Mail.tm inbox waits to perform one immediate check and use scheduled resumes for later checks instead of polling inside an active run.

### Fixed
- Sequenced and coalesced managed Chrome cloud-run updates while applying size limits, image omission, and sensitive-key redaction to persisted and live text-delta data.
- Guided Chrome and Firefox Gmail draft replacement through one clearing `set_field` call followed by verification, avoiding fragile click-and-keyboard clearing flows.
- Brought non-English Chrome and Firefox slash-command help and permission copy to parity with the English command lists and keyboard shortcuts.
- Corrected the GLM-5.2 benchmark result links.

### Tests
- Expanded regression coverage for trace export privacy and ordering, canonical slash-command flags, Markdown highlighting, scheduled inbox waits, Gmail draft replacement, locale parity, and managed cloud update sequencing and scrubbing.

## [23.0.4] - 2026-07-13

### Added
- Added an opt-in packaged Mail.tm disposable email skill for Chrome and Firefox, available from Settings with explicit confirmation, honest session-retention guidance, automatic account cleanup, and visible provider attribution.
- Added nine Chrome Dev-mode tools for reversible CSS/DOM experiments and page diagnosis: `inject_css`, `remove_injected_css`, `patch_element`, `revert_patch`, CDP-backed `execute_js`, `read_console`, `inspect_network_requests`, `inspect_event_listeners`, and `highlight_element`.

### Fixed
- Stopped Chrome Dev diagnostic handlers, buffers, and their Runtime/Log/Network CDP domains when leaving Dev mode, and enabled the same capture lifecycle for streaming runs.
- Bounded Chrome `execute_js` evaluation to 15 seconds, made CSS undo handles unique and document-bound, and canonicalized structured element patch names before recording reversible state.
- Propagated Chrome CDP callback failures from `chrome.runtime.lastError`, so timed-out or rejected `execute_js` evaluations report failure instead of an empty successful result.
- Redacted common API, subscription, access, auth, and client key header-name variants before Dev network diagnostics enter the in-memory buffer.
- Blocked `javascript:` form actions in structured element patches and permission-gated event-listener inspection and element highlighting because both briefly mutate live DOM.
- Disabled diagnostics on every tracked Dev tab when leaving panel-wide Dev mode, cleaned up exact injected CSS across navigation races, and followed open-shadow hosts when inspecting ancestor event listeners.

### Tests
- Added packaged-skill catalog, opt-in Settings, and Mail.tm safety/API cleanup coverage.
- Added Dev-only exposure, bounded CDP execution, diagnostic lifecycle, sensitive-header redaction, document-safe CSS undo, canonical element patching, permission classification, and state-change coverage for the new Chrome Dev toolkit.

## [23.0.2] - 2026-07-13

### Added
- Added `upload_file` tool support for Firefox WebBrain extension, including sidepanel-based user file picker flow and `downloadId` re-fetch flow with 25MB file size limit.
- Added a selection shortcut for Chrome and Firefox with Summarize, Explain, Quiz me, Proofread, Translate, and custom WebBrain prompts.
- Expanded the native selection context menu with matching preset actions, translation languages, and direct side-panel access.
- Added a persistent setting to hide or restore the floating selection shortcut.
- Added the managed cloud-browser bridge for API-driven run, status, abort, active-tab control, and validated structured results.

### Changed
- Simplified the selection shortcut to a compact purple question-mark icon.
- Added direct Chrome, Firefox, and Edge store links to the English, French, and Chinese README introductions.

### Tests
- Added prompt-safety, browser-specific delivery, duplicate-submission, viewport, keyboard, persistence, translation, and screenshot-suppression coverage.

## [23.0.0] - 2026-07-12

### Added
- Added subscription resume action, including scheduled resume task detection, mode sync before resume, and render subscription actions for restored runs.

### Changed
- Injected trusted runtime clock into agent runs for reliable scheduling.
- Kept runtime context out of planner history and stripped runtime context from derived task state.
- Preserved mode for subscription error resumes.

## [22.4.0] - 2026-07-11

### Changed
- Open Local screenshot PII redaction before vision

## [22.3.0] - 2026-07-10

### Changed
- fast suggested actions

## [22.2.3] - 2026-07-10

### Added
- Added Azure OpenAI and AWS Bedrock (Converse) providers in Chrome and Firefox, including Settings fields, provider manager wiring, docs, and regression coverage.
- Added encrypted profile sync for providers, profile settings, memory, and auxiliary providers, with email auth, local password unlock, merge recovery, reset, and change-password controls.
- Added Hebrew app localization and refreshed localized app and website copy.
- Added GitHub funding metadata and refreshed the WebBrain logo, store listing, banner, favicon, social-card, and website image assets.

### Changed
- Updated local model setup guidance and provider context-window detection for llama.cpp, Ollama, and LM Studio so live runtime windows can replace defaults while respecting manual overrides.
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, architecture docs, and rebuilt Chrome, Edge, and Firefox release archives for 22.2.3.

### Fixed
- Fixed local model context-window detection, including stale detection writes and over-reported windows from loaded local backends.
- Hardened encrypted profile sync around disabled edits, vault KDF reuse, lock and logout flows, legacy sync migration, and remote apply conflicts.

### Tests
- Expanded regression coverage for Azure OpenAI, AWS Bedrock, encrypted profile sync, sync recovery and consent flows, local context-window detection, Hebrew localization, and refreshed logo assets.

## [22.1.2] - 2026-07-10

### Added
- Added search to the providers list.
- Added local user memory for Chrome and Firefox, including `/remember`, `/show-memory`, `/forget-memory`, Settings/Profile management, bounded prompt injection, JSON export/import, and opt-in post-turn auto-learning.

## [21.7.0] - 2026-07-08

### Changed
- remove claude subscription, add huggingface inferencing

## [21.6.0] - 2026-07-08

### Changed
- added history

## [21.5.0] - 2026-07-05

### Changed
- planner ux improved

## [21.4.0] - 2026-07-05

### Changed
- Gate form submissions behind fresh confirmation

## [21.3.0] - 2026-07-05

### Changed
- Add sidepanel slash output retry UX

## [21.2.0] - 2026-07-05

### Changed
- Add in-chat store review prompt (Chrome + Firefox)

## [21.1.0] - 2026-07-05

### Changed
- Suppress duplicate assistant prose during tool calls

## [21.0.0] - 2026-07-05

### Added
- Added Dev Mode.

## [20.7.0] - 2026-07-05

### Changed
- clear convo warning message added

## [20.6.0] - 2026-07-05

### Changed
- Guarded scheduled resumes with the progress ledger so resumed runs can preserve and surface task progress before continuing.

## [20.5.5] - 2026-07-04

### Changed
- UX refinements: shortened the Chrome and Firefox Act-mode warning banner across all app locales to focus on the risk notice.
- Removed the verbose tool-log button from the Chrome and Firefox sidepanel header to reduce clutter; verbose mode remains available from Settings and the `/verbose` slash command.
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, package versions, and browser architecture docs for 20.5.5.

## [20.5.2] - 2026-07-04

### Changed
- Reduced the Chrome and Firefox sidepanel composer plus and microphone button hit areas from 32px to 28px while keeping the icon size and send button unchanged.
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, package versions, and browser architecture docs for 20.5.2.

### Fixed
- Completed missing Chrome and Firefox UI locale strings for attachments, microphone controls, queued composer messages, progress-ledger output, recording copy, and voice-input settings.
- Completed localized website share and footer social labels for Mastodon and Bluesky across the generated locale pages.
- Synced localized busy-run slash-command notices so every app locale lists `/check-progress` as an immediate command alongside the other allowed commands.

### Tests
- Updated Chrome and Firefox regression coverage for the busy-run slash-command notice and verified the full test suite plus prompt-injection corpus.

## [20.5.0] - 2026-07-04

### Added
- Added `/check-progress` in Chrome and Firefox so users can show the current tab's progress ledger from the slash-command menu, including session details, row counts, and the ledger rows.

### Changed
- Raised JSON, TXT, and CSV text attachment uploads from 512 KB to 5 MB in Chrome and Firefox while keeping injected file text bounded to the active provider's remaining context.
- Budgeted text attachments against the pruned prompt and reserved overhead, splitting available context across multiple attachments and marking truncated files as partial content when only the beginning can fit.
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, package versions, and browser architecture docs for 20.5.0.

### Tests
- Updated Chrome and Firefox regression coverage for 5 MB text-attachment caps, provider-context truncation, late text uploads in long chats, and partial-content notices that omit over-budget tail text.

## [20.4.1] - 2026-07-04

### Changed
- Moved the sidepanel pills to the middle of the sidepanel.

## [20.4.0] - 2026-07-03

### Changed
- mastodon hardening, and  broader agent hardening around progress-ledger safety and malformed tool-call arguments

## [20.3.0] - 2026-07-03

### Changed
- new feature: accept text attachments in the sidepanel

## [20.2.0] - 2026-07-03

### Added
- Added `/dangerously-skip-permissions` in Chrome and Firefox so users can disable permission prompts directly from the side panel without opening Settings.
- Kept `/dangerously-skip-permissions` available during active runs and have it resolve any pending permission prompt for the initiating tab with a one-time allow so the blocked run can continue immediately.
- Added the Star History embed to the website so visitors can inspect WebBrain repository star growth from the homepage.

### Changed
- Updated slash-command help, autocomplete, busy-run notices, and localized warning copy for the new permission-skipping command.
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, package versions, and browser architecture docs for 20.2.0.

### Tests
- Added Chrome and Firefox regression coverage for the new slash command, out-of-band busy-run availability, storage-backed permission gate disabling, active permission prompt resolution, localized busy notices, and website Star History rendering.

## [20.1.0] - 2026-07-03

### Changed
- Raised the built-in WebBrain Cloud provider context window to 1,000,000 tokens in Chrome and Firefox, while migrating stored legacy 256k configs forward without dropping saved API keys.
- Scaled the agent's soft context character and message budgets from the active provider token budget, so 1M-context providers no longer compact at the legacy 80k-character or 50-message limits.
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, package versions, and browser architecture docs for 20.1.0.

### Tests
- Added Chrome and Firefox regression coverage for the WebBrain Cloud 1M default, legacy context-window migration, adaptive character/message context budgets, and large-window conversations avoiding premature compaction.

## [20.0.0] - 2026-07-03

### Added
- Added Chrome-only `/record-full-screen` as a slash-only screen/window recording flow that uses the offscreen recorder's `getDisplayMedia()` picker and records without the live WebBrain recording banner.
- Added double-Escape recording stop handling on Chrome WebBrain/browser surfaces, with hidden recordings covered by a background-owned 2-hour safety cap.
- Added `--transcribe` for `/record` and `/record-full-screen` so user-driven recordings can still save a Whisper transcript after stop.

### Changed
- Removed model-callable `record_tab` and `stop_recording`; recording is now user-driven through `/record`, `/record-full-screen`, optional `--transcribe`, browser stop controls, or double Escape.
- Reserved retired recording tool names in Chrome and Firefox so custom skills cannot reintroduce them, and updated agent prompts to point users to slash commands instead of tools.
- Changed Plan before Act to default unset storage to `try` while preserving explicit `off`.
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, package versions, and browser architecture docs for 20.0.0.

### Fixed
- Kept Firefox from advertising `/record-full-screen` while returning a clear unsupported message if the command is typed manually.

### Tests
- Added Chrome and Firefox regression coverage for recording tool removal, retired-name/custom-skill blocking, slash parser ordering, Chrome-only full-screen recording, hidden full-screen recording UI, double-Escape stop routing, and Plan-before-Act default `try`.

## [19.3.0] - 2026-07-02

### Added
- Added Chrome and Firefox side-panel microphone dictation controls with per-browser permission handling, interim transcript cleanup, and clear disabled states when speech recognition is unavailable or turned off.
- Added Chrome and Firefox side-panel file attachments for images, PDFs, JSON, and text files, including attachment preview chips, remove controls, tab-scoped pending attachments, and send-button gating while file reads are still in flight.

### Fixed
- Fixed attachment rejection handling so unsupported attachments are restored to the correct tab without scraping assistant text, while uploaded user attachments carry an explicit untrusted-content boundary before being sent to the model.
- Fixed Chrome microphone denial handling so the mic icon returns to its idle state and permission-denied state does not spam repeated system messages.
- Fixed Anthropic Claude Opus 4.8 requests by omitting unsupported non-default `temperature` parameters while keeping temperature for Claude Sonnet 4.6.

### Tests
- Added Chrome and Firefox regression coverage for tab-scoped attachment state, pending-read send gating, rejected-attachment restoration, text-attachment size limits, uploaded image/document boundaries, microphone icon reset, and Anthropic Opus 4.8 temperature handling.

## [19.2.0] - 2026-07-02

### Added
- Added a Chrome and Firefox side-panel message queue so normal composer messages sent while WebBrain is busy are kept per tab, shown above the composer, and can be edited or deleted before they run.

### Changed
- Kept `/help`, `/show-scratchpad`, `/list-schedules`, `/screenshot`, `/export`, and `/verbose` available as immediate slash commands during active runs while other slash commands show the queued-message busy notice.
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, package versions, and browser architecture docs for 19.2.0.

### Fixed
- Fixed queued-message editing so pressing ArrowUp in an empty composer pulls the latest queued message back into the composer before it runs.

### Tests
- Added Chrome and Firefox regression coverage for busy-run message queueing, queued-message edit/delete controls, per-tab queue draining, safe busy slash commands, and localized busy notices.

## [19.1.0] - 2026-07-02

### Added
- Added Ollama launch handoff integration for Chrome and Firefox so `webbrain.one/launch/ollama` links can configure the local Ollama provider, activate it, and carry over the selected model, loopback `/v1` base URL, and context window.

### Changed
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, package versions, and browser architecture docs for 19.1.0.

### Tests
- Added Chrome and Firefox regression coverage for Ollama launch handoff validation, loopback URL restrictions, provider activation, and launch-page content-script behavior.

## [19.0.11] - 2026-07-02

### Changed
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, package versions, and browser architecture docs for 19.0.11.

### Fixed
- Fixed Settings -> Providers -> Load Models for local providers so loaded models appear in a centered picker dialog without replacing an existing model value until the user chooses one.
- Replaced raw HTML 404 model-list errors with the concise local-server status when a local model server is not running.
- Guarded repeated model-load completions so an already-open loaded-model dialog is not reopened.

### Tests
- Added Chrome and Firefox regression coverage for loaded-model dialog rendering, localized dialog copy, stale option clearing, concise HTML 404 handling, centered dialog styling, and repeated dialog-open handling.

## [19.0.0] - 2026-07-01

### Added
- Added the new Skills infrastructure for Chrome and Firefox: Settings -> Skills can import trusted skill text or HTTPS skill URLs, store enabled skills in browser local storage, append enabled skill instructions to the agent system prompt, and show/remove declared skill tools.
- Added `webbrain-tools` manifest support so enabled skills can declare runtime tools without hard-coding them into the static tool table. Skills can expose read-only HTTPS GET/POST tools and Act-only `httpDownloadJob` tools with create, poll, file, and cleanup endpoints.
- Added a bundled FreeSkillz.xyz skill, enabled by default and removable from Settings -> Skills, with `read_youtube_transcript`, `resolve_public_media`, and `download_public_media` for public YouTube transcripts and public social/media URLs.
- Added skill-aware tool hydration before provider setup and scheduled runs so imported and packaged skill tools are available consistently in normal and resumed agent sessions.

### Changed
- Updated README, adding-a-tool, architecture, privacy/data-flow, prompt-injection, security-model, and browser architecture docs for custom skills, skill tool trust boundaries, bundled FreeSkillz behavior, and the removal of the stale root extension manifest.
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, package versions, and browser architecture docs for 19.0.0.
- Kept skill HTTP requests cookie-free with `credentials: "omit"`, nested provider payloads under untrusted result data, and documented that importing or keeping a skill enabled is the trust decision for its declared HTTPS endpoint.

### Fixed
- Hardened skill imports and skill tool calls against unsafe endpoints, oversized imports, opaque or cross-origin redirects, blocked local/internal destinations, and provider fields such as `done`, `_attachImage`, or `_attachDocument` escaping into internal tool-result control fields.
- Hardened download-job skill tools so they are Act-only by default, stay behind the normal Downloads permission gate, handle pending browser downloads without prematurely deleting provider jobs, clean up provider jobs on early failures, validate file/final URLs, reject file redirects and non-2xx file responses, and support GET-only file endpoints without requiring HEAD.
- Reworked skill media saving to avoid cookie-bearing browser downloads against provider domains by fetching files with omitted credentials, validating the response URL before saving, and capping cookie-free data-URL saves at 25 MiB so large media fails cleanly instead of buffering unbounded data in the service worker.
- Required explicit URLs for read-only public media resolution so broad social-media allowlists do not silently send the active tab URL to FreeSkillz from Ask mode.

### Tests
- Added Chrome and Firefox regression coverage for skill import/storage limits, packaged-skill seeding and refresh, Settings -> Skills UI behavior, scheduled-run skill hydration, runtime skill tool schemas, Ask/Act/Compact mode filtering, untrusted skill result wrapping, endpoint and redirect validation, and skill response trimming.
- Added FreeSkillz transcript/media coverage for supported URL allowlists, public media resolve requirements, download-job lifecycle, pending cleanup, unsafe final URLs, blocked redirects, failed file requests, GET-only file endpoints, cookie-free file fetches, and oversized media rejection.

## [18.3.0] - 2026-06-29

### Changed
- Deleted the stale root `manifest.json` and updated Chrome setup docs, version bumping, and release workflows to use `src/chrome/manifest.json` and `src/firefox/manifest.json` as the only extension manifests.

## [18.2.0] - 2026-06-28

### Changed
- edge store preparations

## [18.1.0] - 2026-06-28

### Changed
- Added: Tune context compaction thresholds

## [18.0.4] - 2026-06-27

### Fixed
- Prevented stale repeated `fetch_url` loop entries from hard-stopping the agent after it switches to a different tool, such as falling back from failed API calls to `click_ax`.
- Collapsed repeated failed mutating API calls in one assistant batch into a single failed API strategy for loop detection, while keeping `/allow-api` as the required opt-in for API mutations.
- Reasserted the active viewport glow after tab reloads during a running task so the visual run indicator comes back when the content script reloads.

### Tests
- Added Chrome and Firefox regression coverage for stale URL-tool loop pivots, failed API mutation batches, and active viewport glow reassertion after reload.

## [18.0.3] - 2026-06-27

### Changed
- Replaced the Plan before Act checkbox with Planner modes: Try planning by default, Strict planning for fail-closed approval, and Off.
- Made Try planning continue into Act mode without a pinned plan when the planner cannot produce valid structured JSON, so the default planner path no longer cancels the task on planner-format failure.
- Preserved legacy planner storage by mapping unset storage to Try planning, legacy `false` to Off, and legacy `true` to Strict planning.

### Tests
- Added Chrome and Firefox regression coverage for planner mode defaults, legacy migration behavior, try-mode fallback, and strict-mode fail-closed cancellation.

## [18.0.2] - 2026-06-27

### Added
- Added bulk API mutation pattern detection for Chrome and Firefox so repeated successful same-action clicks, such as following many GitHub stargazers, can surface matching background API request shapes before the agent spends one LLM turn per button.

### Changed
- Kept mutating `fetch_url` calls behind the `/allow-api` slash command, including a hard fail-closed path for POST, PUT, PATCH, and DELETE when API mutations have not been explicitly enabled for the conversation.

### Tests
- Added Chrome and Firefox regression coverage for bulk API mutation hints, `/allow-api` hint state, and blocking mutating `fetch_url` calls until `/allow-api` is enabled.

## [18.0.0] - 2026-06-27

### Added
- Added `go_back` and `go_forward` tools for Chrome and Firefox so Act mode can use browser history directly instead of relying on CSP-sensitive page JavaScript.
- Added Plan before Act as a default-on planning gate, including structured planner parsing, a side-panel plan review card, approved-plan scratchpad pinning, scheduled-run auto-approval, and planner trace/provider metadata.
- Added a background API request observer for Chrome and Firefox that detects repeated click-triggered XHR/fetch requests and suggests the matching `fetch_url` method when the UI loop is stuck.

### Changed
- Kept API shortcut detection method-aware for GET, POST, PUT, PATCH, DELETE, and other observed methods while leaving mutating replay decisions to the existing `/allow-api` and UI-vs-API policy.
- Updated README, architecture, adding-a-tool, privacy, prompt-injection, and security docs alongside release metadata, Settings subtitle versions, Chrome / Firefox manifests, and package versions for 18.0.0.

### Fixed
- Fixed Chrome history URL normalization so query-string and hash-only history transitions are treated as real back/forward navigation changes, matching Firefox.
- Prevented API shortcut detection from counting one captured request across multiple overlapping click windows.
- Removed unused planner helper/style code left behind during review cleanup.

### Tests
- Added regression coverage for history navigation tool exposure, permission mapping, URL normalization parity, planner parsing/review/scratchpad/scheduling/trace behavior, API shortcut matching, request-reuse prevention, and prompt-injection corpus parity.

## [17.8.0] - 2026-06-27

### Added
- Added completion confetti for successful Chrome and Firefox tasks, with a Settings toggle and localized labels so users can turn off the celebratory finish.

### Changed
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 17.8.0.

### Fixed
- Fixed side-panel tab race issues by queueing tab-switch updates during restore and preventing stale flushes from writing to the wrong tab conversation.
- Scoped accepted completion and success-confetti updates to the active tab so finished tasks do not trigger stale success UI in another tab.

### Tests
- Added regression coverage for completion confetti settings and rendering, accepted completion gating, and tab-switch restore / flush races.

## [17.7.0] - 2026-06-26

### Added
- Added `/clear-scratchpad` in the Chrome and Firefox side panels so users can clear the current conversation scratchpad from slash-command autocomplete and help.
- Added Cloudflare Workers AI to the provider list with the OpenAI-compatible Workers AI endpoint, default model `@cf/zai-org/glm-5.2`, and a 262k-token context window.

### Changed
- Translated the `/clear-scratchpad` label, help text, and cleared-state message across all supported locales.
- Classified OpenRouter, Cloudflare Workers AI, Nvidia NIM, and Groq under the Router provider bucket in Chrome and Firefox settings.
- Added a dedicated Cloudflare account ID field and URL validation so the Workers AI provider substitutes the account into the API base URL before testing or chatting.
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 17.7.0.

### Fixed
- Migrated saved OpenRouter, Cloudflare Workers AI, Nvidia NIM, and Groq provider categories to Router so upgraded installs do not keep older Cloud filter state.

### Tests
- Added regression coverage for the synchronous scratchpad clear path, locale coverage for `/clear-scratchpad`, Cloudflare defaults, context-window inference, and the Router provider bucket.

## [17.6.0] - 2026-06-26

### Added
- Added a copy button to `/show-scratchpad` output in the Chrome and Firefox side panels so users can copy just the scratchpad contents.
- Added WebBrain blog coverage and benchmark result files for raw LFM 2.5 230M and 350M on the frozen 100-case browser-agent planner harness.

### Changed
- Updated the tiny LFM benchmark conclusion and refreshed release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 17.6.0.

## [17.5.0] - 2026-06-26

### Added
- Added async out-of-band slash-command handling in the Chrome and Firefox side panels, allowing `/help`, `/show-scratchpad`, `/list-schedules`, `/screenshot`, `/export`, and `/verbose` to run while WebBrain is busy.

### Changed
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 17.5.0.

### Fixed
- Preserved drafts and autocomplete/send-button state when users try slash commands during active runs, with a localized busy notice for commands that need to wait.

## [17.4.0] - 2026-06-25

### Added
- Added `/edit-scratchpad <text>` in the Chrome and Firefox side panels so users can append notes to the current conversation scratchpad from slash-command autocomplete and help.

### Changed
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 17.4.0.

## [17.3.0] - 2026-06-24

### Fixed
- Replaced the Firefox extension toolbar/sidebar icon PNGs with the Chrome brain artwork and refreshed the packaged Firefox archive so Firefox no longer shows the old purple round icon.

## [17.2.0] - 2026-06-24

### Added
- Added XML-style raw tool-call parsing for Chrome and Firefox so local/chat-template models that emit `<tool_call><function=...><parameter=...>` output can execute tools instead of returning raw markup.
- Added a WebBrain Cloud billing panel in Chrome and Firefox settings with device-bound Stripe account links, localized account copy, and expanded WebBrain Cloud provider notes for subscription, billing, and privacy links.
- Added Polish UI locale support for the Chrome and Firefox settings/payment flows.

### Changed
- Updated WebBrain Cloud `/subscribe` URLs and 402 allowance messages to include the device GUID as Stripe `client_reference_id`, and made the subscribe page require a device-bound link before redirecting to checkout.
- Reworded the subscribe fallback page to tell users with outdated extension links to update the browser plugin.
- Documented the newer slash commands in the English, French, and Chinese README files.
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 17.2.0.

### Fixed
- Purged legacy `auth.webbrain.one` token, email, and default-model storage during settings startup now that WebBrain Cloud billing is device-GUID based.
- Firefox side-panel message bubbles now expose copy buttons on user messages, with styling that remains legible on accent-colored bubbles.
- Suppressed streamed raw tool-call text before rendered tool steps, so fallback tool calls do not linger as assistant text.

### Tests
- Added regression coverage for XML-style tool-call parsing/execution and raw tool-call stream suppression in Chrome and Firefox.

## [17.1.0] - 2026-06-24

### Added
- Introduced a better payment UI for WebBrain Cloud: the quota-exceeded error now surfaces a Subscribe button that links users directly to upgrade their plan, with the button persisting and rebinding across chat restores.

### Changed
- Translated the Subscribe button strings into all supported locales.

## [17.0.0] - 2026-06-23

### Changed
- Updated provider placeholder models in Chrome and Firefox settings to reflect newer model options.
- Marked conversation export as completed in the README roadmap and noted that conversation import is not planned.
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 17.0.0.

### Removed
- Removed Chrome `execute_js` tool dispatch support so Chrome only exposes and dispatches the advertised tool set.

### Fixed
- Hardened Chrome and Firefox side-panel tab state so async slash commands, suggested actions, scheduled actions, restored controls, tab-chat saves, and pending tab switches stay scoped to the initiating tab instead of updating stale panels.
- Made settings and side-panel provider activation/status updates handle async failures, stale checks, invalid stored provider IDs, unsupported stored providers, and persisted preference changes more reliably.
- Improved context-menu prompt persistence and retry handling so prompts survive storage races, pending tab switches, failed tab switches, abort timeouts, and concurrent deferred writes without replaying stale content.
- Stabilized trace rendering, trace export downloads, side-panel export downloads, Chrome offscreen proxy recovery, and Chrome tab-chat persistence after clears.
- Scoped allow-api state to tab conversations and cleared Firefox transient tab state on reset.

### Security
- Escaped dynamic system messages and trace-viewer attribute data, rendered verbose tool names as text, avoided selector interpolation in settings tabs, rejected unknown provider updates, and validated stored provider IDs before use.

### Tests
- Added regression coverage for side-panel tab scoping, settings/provider async status handling, context-menu prompt queuing and retries, scheduled action tab isolation, export/download stability, provider validation, trace rendering, and Chrome advertised-tool dispatch.

## [16.0.0] - 2026-06-23

### Added
- Added Chrome and Firefox context-menu integration: right-click selected page text and choose "Ask WebBrain about this" to open the WebBrain panel and submit the selection as untrusted page content.

### Changed
- Marked keyboard shortcuts and context menu integration as completed in the README roadmap.
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 16.0.0.

### Fixed
- Context-menu prompts now survive service-worker and panel timing races until the chat request is accepted, then clear only after the background receives the request so prompts are neither lost before submission nor replayed after panel reopen.
- Context-menu prompts are now queued while a run is processing or when they target another tab, drain after Continue finishes or the matching tab becomes active, and are discarded on navigation or tab close so stale selections are not submitted against the wrong page.

### Tests
- Added Chrome + Firefox side-panel regression coverage to ensure queued context-menu prompts drain after Continue clears the processing state.

## [15.6.0] - 2026-06-23

### Changed
- Filled 22 missing UI locale keys across all 13 supported non-English locales in both Chrome and Firefox.
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 15.6.0.

### Fixed
- Agent-created scheduled current-tab tasks on HTTP(S) pages now persist as URL targets, so scheduled runs can navigate back to the original page instead of failing after the tab changes.
- Legacy agent-created current-tab scheduled tasks now migrate to URL targets during alarm restoration while preserving their scheduled alarms.

### Tests
- Added Chrome + Firefox scheduler coverage for agent-created current-tab URL target normalization, legacy scheduled-task migration on restore, and navigated scheduled task completion.

## [15.5.0] - 2026-06-23

### Changed
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 15.5.0.

## [15.4.0] - 2026-06-23

### Added
- Chrome now registers `Alt+Shift+W` as the default extension keyboard shortcut for opening the WebBrain panel.

### Changed
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 15.4.0.

## [15.3.0] - 2026-06-23

### Changed
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 15.3.0.
- Scheduled-job busy retries now stagger same-target queued runs so simultaneous alarms do not keep retrying at the same instant.

### Fixed
- Scheduled resume and task creation now dedupes near-identical live jobs within a two-minute window, returning the existing job instead of creating duplicate alarms.
- Startup alarm restoration now coalesces stored near-duplicate scheduled jobs by keeping the earliest matching live job and cancelling later duplicates.

### Tests
- Added Chrome + Firefox scheduler coverage for duplicate resume/task creation, duplicate-window boundaries, staggered busy retries, and restore-time duplicate coalescing.

## [15.2.2] - 2026-06-23

### Fixed
- Scheduled recurring tasks can now start immediately when their first run is due now.

## [15.2.1] - 2026-06-23

### Changed
- Max Agent Steps settings copy now explains that the `∞` slider position means unlimited steps in every supported Chrome and Firefox locale.
- `/schedule` now accepts `0` minutes for standalone scheduled tasks, treating it as "start now" while keeping nonzero future delays at the existing one-minute minimum.

### Fixed
- Max Agent Steps now treats the Settings slider maximum (`200`) as the unlimited sentinel instead of a finite cap, migrates stale stored `200+` values to `maxAgentSteps: 0`, and keeps the continue bar from displaying unlimited (`0`) as the default step count.

### Tests
- Added regression coverage to ensure `0`, `200`, and values above `200` remain unlimited in both browser builds, and that all max-step locale descriptions mention the `∞` setting.
- Added scheduler coverage for zero-delay tasks and the `/schedule` composer accepting an immediate relative delay.

## [15.2.0] - 2026-06-22

### Added
- Jan, vLLM, and SGLang as built-in local providers (Chrome + Firefox). All three use OpenAI-compatible `/v1` endpoints (Jan on port 1337, vLLM on port 8000, SGLang on port 30000), support model listing via `/v1/models`, accept an optional API key for auth-enabled servers, and default to enabled with vision on and a 16 K context window.

### Changed
- Onboarding local-model detection copy now lists Jan, vLLM, and SGLang alongside LM Studio, Ollama, and llama.cpp.
- LLM request-timeout settings description and provider info panel updated to cover all six local backends.
- Updated documentation (README, architecture docs, providers guide) to reflect the expanded local-provider lineup.

### Tests
- Added coverage for `categoryFor` and `listProviderModels` with Jan, vLLM, and SGLang — including auth header forwarding and model-list deduplication — and for `_defaultConfigs` asserting all three new providers are present, enabled, local-categorized, and localhost-defaulted.

## [15.1.1] - 2026-06-22

### Changed
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 15.1.1.

## [15.1.0] - 2026-06-22

### Changed
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 15.1.0.
- Updated README and architecture docs to describe WebBrain Cloud 1.0 as the default managed cloud option and document the scheduled-task system.
- Refreshed release artwork and regenerated packaged Chrome / Firefox submission archives.

### Fixed
- Firefox indexed click and typing actions now resolve against the same full interactive-element ordering shown to the agent, keeping click-by-index and type-by-index stable.
- Firefox indexed actions now handle shadow DOM controls, blocking modal/native dialogs, non-modal dialogs, inert or hidden background controls, stale editable focus, and disabled text inputs more reliably.
- Chrome and Firefox side panels now surface a clear error when the background script returns no response, and avoid dereferencing missing response content while rendering assistant messages.

### Tests
- Added regression coverage for Firefox shadow-DOM indexed clicks and typing, modal and non-modal dialog indexing, disabled/stale editable fallbacks, and missing side-panel background responses.

## [15.0.0] - 2026-06-22

### Added
- Added a Chrome `/record` slash command that starts current-tab recording directly from the side panel with video and microphone capture, plus matching Chrome autocomplete and `/help` text.

### Changed
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 15.0.0.

### Fixed
- Tightened `/record` slash parsing so longer words beginning with `/record` are not treated as recording commands, surfaced recording startup and microphone-capture failures in the Chrome side panel, and made manually typed `/record` in Firefox report that tab recording is unsupported without advertising it in Firefox slash autocomplete or help.

## [14.2.2] - 2026-06-22

### Changed
- Lowered the `schedule_resume` minimum delay from 60 seconds to 30 seconds in Chrome and Firefox, matching the packaged Chrome alarms floor while keeping standalone scheduled tasks at the existing 60-second minimum, and expanded the maximum scheduling window from 1 day to 7 days.
- Completed scheduled-job cards in the side panel now disappear after 15 seconds unless the user clicks the card to keep it visible.
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 14.2.2.

### Tests
- Updated scheduler and side-panel coverage for the shorter 30-second `schedule_resume` delay, seven-day maximum scheduling window, and completed-card auto-hide behavior.

## [14.2.0] - 2026-06-21

### Added
- Slash command autocomplete in the Chrome and Firefox side panels, with keyboard navigation, Tab / Enter completion, Escape dismissal, mouse selection, and accessible listbox metadata for all supported slash commands.

### Changed
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 14.2.0.
- Completed missing translations for all 13 supported languages (Arabic, Spanish, French, Indonesian, Japanese, Korean, Malay, Russian, Thai, Tagalog, Turkish, Ukrainian, Chinese Simplified) across Chrome and Firefox locale files, covering scheduled-task UI strings, scratchpad panel, schedule form, permission verb, tool labels, and settings toggles added in 14.1.0.

### Tests
- Added static Chrome + Firefox coverage to keep the slash command parser and autocomplete command list in sync.



## [14.1.0] - 2026-06-21

### Added
- Scheduled agent work for Chrome and Firefox: `schedule_resume` durably pauses a blocked run and resumes it later in the same tab / conversation, while `schedule_task` creates one-shot or recurring future tasks backed by browser alarms and persisted job state.
- Side panel schedule controls, including `/schedule`, `/list-schedules`, `/show-scratchpad`, an active scheduled-job strip, and Run now / Pause / Resume / Cancel / Delete actions for scheduled jobs.
- Settings toggles for enabling scheduled tasks and requiring confirmation before unattended scheduled runs perform consequential actions.

### Security
- Added a `schedule` permission-gate capability so scheduled future work is treated as a consequential action, with unattended scheduled runs defaulting to confirmation before clicks, typing, navigation, downloads, uploads, recording, or other gated actions.

### Changed
- Full and mid Act-mode prompts now describe the scheduling tools and when they may be used; compact Act mode still forbids scheduling and tells the agent to ask the user to re-invoke WebBrain for external waits.
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and required `alarms` permissions for 14.1.0.

### Fixed
- Anchor clicks now correctly classify same-page anchors, anchors resolved through `<base href>`, and popup-style placeholder / hash anchors, preventing successful in-page jumps or popup triggers from being reported as failed or stale clicks.

### Tests
- Added Chrome + Firefox coverage for scheduler validation, busy-tab queuing, stale resume / task targets, recurring next-run calculation, scheduled clarifications, tool exposure by prompt tier, schedule slash commands, scratchpad reads, and schedule capability gating.

## [14.0.5] - 2026-06-20

### Changed
- Updated Anthropic defaults and context-window inference for `claude-opus-4-8`.
- Updated release metadata, Settings subtitle versions, architecture docs, and Chrome / Firefox submission archives for 14.0.5.

### Fixed
- Provider Settings numeric fields now preserve valid zero cost estimates while continuing to reject invalid or negative numeric values.

## [14.0.4] - 2026-06-19

### Added
- Suggested actions in the side panel can now be minimized and restored in both Chrome and Firefox. The collapsed preference is saved, so users can reclaim chat space once and keep it that way across panel reloads.

### Changed
- Tightened the Suggested actions panel spacing, chevron control, and action chips to reduce vertical space used above the chat input.
- Updated release metadata, Settings subtitle versions, architecture docs, and Chrome / Firefox manifests for 14.0.4.

## [14.0.0] - 2026-06-18

### Changed
- WebBrain Cloud is now the default provider for new WebBrain configurations.
- Updated release metadata, Settings subtitle versions, architecture docs, and Chrome / Firefox manifests for 14.0.0.

### Fixed
- Context compaction now treats screenshots as a bounded vision-token cost and uses a short post-compaction cooldown, preventing screenshot-heavy Chrome and Firefox runs from compacting again on every step.
- Text clicks now ignore hidden ARIA option / menu / tree items and no longer treat editable input values as click labels, preventing collapsed or virtualized options and filter boxes from being selected as false matches.
- Firefox scroll-retry text clicks now reuse the same visibility and editable-value filtering as the primary matcher.

## [13.1.0] - 2026-06-17

### Changed
- Website header GitHub controls now use the star pill as the single repository link, removing the duplicate GitHub CTA across localized website pages.
- Updated release metadata, Settings subtitle versions, architecture docs, and Chrome / Firefox submission archives for 13.1.0.

## [13.0.1] - 2026-06-12

### Fixed
- Screenshot capture now mechanically detects near-blank frames and retries after 500ms, 1000ms, and 1500ms before handing the image to a vision model (Chrome + Firefox). This helps recover from compositor / lazy-load races on media-heavy pages such as Instagram, where the DOM already contains content but the first viewport capture can be all white or all black.

### Changed
- Screenshot probes now include image counts, and screenshot results/traces include `blankFrameRetry` metadata when a blank-frame retry path ran.

### Tests
- Added Chrome + Firefox unit coverage for blank-frame retry gating, successful recovery, and the no-content/no-retry case.

## [13.0.0] - 2026-06-10

### Added
- Downloads now auto-pin to the scratchpad (Chrome + Firefox): every `download_files`, `download_resource_from_page`, `stop_recording` (Chrome), and `download_social_media` success appends a durable `[auto] Downloaded … (downloadId N)` line to the pinned scratchpad, so the file's handle survives context compaction even when the model never calls `scratchpad_write` itself. This closes a failure mode where, on long runs, the saved path fell out of the verbatim context window after older tool results were summarized away and the model invented a wrong upload path (e.g. `/Users/Shared/…`). Pinning is centralized in the tool-execution loop so all download-producing tools are covered uniformly; `download_social_media`, which exposes no per-file id, degrades to a `list_downloads` pointer rather than an invented id.
- `download_files` now resolves and returns each file's local path and completion state in its own result (previously only `list_downloads` carried the path), so the handle is available the moment the download finishes.
- `upload_file` now accepts a `downloadId` as an alternative to `filePath` (Chrome): it resolves the real on-disk path internally, so the model can attach a previously downloaded file by its small integer id without recalling the path. `read_downloaded_file` already accepted a `downloadId`.
- Test coverage (in `test/run.js`) for auto-pin survival across a real context compaction, id-only pinning across the download tools, the `download_social_media` → `list_downloads` fallback, and the `download_files` summary-digest behavior.

### Security
- The auto-pin note is id-only by design: it records the `downloadId` (not attacker-controllable) and no page-derived filename at all, keeping the Content-Disposition-settable basename out of the durable, attended-to scratchpad. This is a prompt-injection boundary — a hostile filename such as `ignore previous instructions and …` must never be persisted as trusted text that outlives the untrusted-content wrapper; the human filename remains recoverable via `list_downloads`. The `download_files` summary digest likewise echoes only the integer `downloadId`s and never the filename, so a malicious `Content-Disposition` header cannot smuggle page text into the trusted trim summary.

### Changed
- Act-mode scratchpad guidance updated: download paths are pinned automatically and files are attached/read by `downloadId`, so the model no longer hand-pins paths or re-downloads to "get the path back".

## [12.0.0] - 2026-06-01

### Added
- "Use your subscription" OAuth (PKCE) sign-in for subscription-backed providers (Chrome + Firefox): OpenAI (ChatGPT) and Google Gemini. OpenAI borrows the Codex CLI's first-party `client_id` (same pattern as the existing Claude flow); Gemini stays honest, requiring the user to register and enter their own Google Cloud OAuth `client_id`. Clients send no headers that impersonate a vendor's first-party CLI, and the settings UI surfaces a disclaimer on every borrowed-client card noting it may be revoked by the vendor at any time.
- Context-aware recommended actions: the agent surfaces actionable recommendations tailored to the current page and runs them directly in Act mode.

### Changed
- Recording recommendation is now hidden on Firefox where it does not apply.

### Fixed
- Social media downloads now focus on the active media: extensionless media URLs get correct video filenames, visible-crop filename extensions are fixed, a visible-media crop fallback was added, main-mode videos are ordered before posters, and focused HTTP / blob video downloads are preferred and preserved.
- Recorder Stop reliably ends stuck or orphaned recordings, with cleared / already-stopped stop results handled and forced-clear stop failures surfaced in the side panel.
- Fixed 6 bugs across the Chrome and Firefox builds.

## [11.0.0] - 2026-05-31

### Added
- Cloud cost allowance controls: per-session spending limits for metered cloud providers. Set a maximum dollar allowance in Settings; spend is estimated from provider-reported token usage (falling back to token counts when usage metadata is absent) multiplied by per-model pricing. Anthropic and Gemini stream usage metadata is now forwarded for accurate accounting, reported zero-cost usage is honored, and local / IPv6 / "cloud-card" local endpoints are treated as unmetered.
- Token-aware automatic context compaction (Chrome + Firefox): the agent now summarizes older turns once the running input-token count crosses ~75% of the active model's context window — not just the legacy 50-message / 80k-char heuristics — and re-checks on every agent-loop iteration so long autonomous runs compact mid-flight. When it compacts, the side panel shows an inline "Context automatically compacted" separator. Providers expose an approximate `contextWindow` (category-aware default: 16k for local backends, 128k for cloud/router; overridable via `config.contextWindow`). Compaction preserves the pinned original user task and never splits an assistant/tool-call pair across the summary boundary; Firefox now digests tool results into the summary at parity with Chrome. Onboarding, README, and the website now recommend a ≥16k context window for local models (8k works with Compact mode).
- `click` progress snapshots now report the affected form control's state (checked / disabled / selected index / `aria-*`) alongside its label and position, so the model and recorded traces can verify the effect of an interaction.
- Test coverage (in `test/run.js`) for trace-driven agent interaction and for untrusted wrapping of `click` / `type_text` results.

### Security
- `click` and `type_text` tool results are now wrapped as untrusted content, so page-derived text returned by an interaction cannot be interpreted as model instructions.

### Changed
- Cloud cost totals are serialized to avoid update races, and stream-usage options are gated by provider support.

### Fixed
- Fixed trace-driven agent interaction issues in the session recorder/replay path (agent loop, tool dispatch, and recorder host).
- Next-prompt size is now projected from reported tokens plus observed conversation growth rather than the model maximum, improving compaction timing.

## [10.0.0] - 2026-05-30

### Added
- Deterministic capability-by-origin permission gate for consequential agent actions, with per-host Allow once / Always / Deny grants.
- Site Permissions settings tab for reviewing and revoking saved capability grants.
- Localized structured permission card across Chrome and Firefox, replacing the previous free-text permission parser.
- Act-mode risk banner that appears when the permission gate is disabled.
- Localized onboarding safety warnings and local-LLM setup flow, including auto-detection for local providers.
- Apple Store site adapter.
- Firefox support for compact Act prompts, including compact tool schema routing and provider opt-in.

### Security
- Wrapped page-derived tool results and model-visible context as untrusted data across page reads, screenshots/OCR, hover/list-download results, PDF passthrough, download-family results, `done` verification fields, and scratchpad-adjacent context.
- Added prompt-injection defense documentation and tests covering the permission gate, untrusted-content registry, and capability classification exhaustiveness.
- Gated outbound GET egress, screenshot-to-disk, `read_pdf({url})`, `record_tab`, resource downloads, iframe actions by frame host, and `set_field({submit})` as both type and click.
- Scoped one-time permission grants to the tab/run and made `/allow-api` waive only mutation egress, not GET-based exfiltration.
- Sanitized page title/URL and PDF title metadata before inserting them into trusted context notes.
- Failed closed when iframe or target hosts cannot be identified for permission checks.

### Changed
- Improved nested-pane scroll targeting, with pane fallback when window scrolling cannot move and editable fields skipped as scroll containers.
- Permission card choices now dismiss immediately, and the Settings permissions list live-refreshes after changes.
- Firefox cached system prompts now refresh on conversation reuse so provider compact/full prompt changes stay aligned with the active tool schema.
- Compact-mode tool allowlists are enforced for both text-parsed and structured tool calls in Firefox.
- Documentation now describes Firefox compact-prompt support and current security/privacy behavior accurately.

### Fixed
- Fixed mobile hero mockup overflow and narrow navbar sizing.
- Fixed Firefox download-card wrapping.
- Fixed permission-option click handling so exact options are checked before negation parsing.
- Fixed legacy scroll fallback guard and stale scroll-origin behavior.
- Fixed docs accuracy issues and updated the maintainer security contact.

## [8.8.0] - 2026-05-28

### Added
- Cream/coffee light theme for the marketing website with a sun/moon toggle in the nav (PR #84). Default follows `prefers-color-scheme`; the choice is persisted in `localStorage`.
- Cream/coffee light theme for the extension's side panel and Settings page in both Chrome and Firefox builds (PR #85). Default follows `prefers-color-scheme`; Settings → General → Appearance offers System / Light / Dark.
- New `src/<browser>/src/ui/theme.js` module owning theme state, with `localStorage` mirroring `(chrome|browser).storage.local` so the FOUC bootstrap can read synchronously and other extension pages stay in sync.
- Self-hosted MP4 of the demo video on the marketing site, replacing the previous external embed.

### Changed
- Demo section label and subtitle restored on the marketing site for consistency with the other sections.
- Theme toggle is hidden on narrow nav layouts (≤375px) to keep the header within its side padding; `prefers-color-scheme` still picks the right theme on mobile.

### Fixed
- Settings appearance picker now stays in sync when the theme is changed from another Settings tab or the side panel. The local `currentThemeMode` closure and the `<select>` value are updated from `storage.onChanged`, so a subsequent OS-theme flip no longer overrides an explicit user choice.
- Theme bootstrap moved out of an inline `<script>` and into `theme-bootstrap.js` (a parser-blocking classic script in `<head>`) so it actually runs under MV3's `script-src 'self'` CSP — the inline version was silently blocked and visitors saw a dark flash on first paint.

## [8.7.0] - 2026-05-28

### Added
- Settings tab "Display" renamed to "General" across all 14 locales to reflect its broader scope.
- Settings subtitle no longer says "display preferences" — translated to "preferences" in every locale.

### Documentation
- README provider table expanded from 4 to 14 entries with default models per provider.
- README "What's New" section replaced with a one-line pointer to CHANGELOG.md to prevent the drift that left it stuck at 6.1.0.
- CHANGELOG backfilled with entries for 8.2.1, 8.2.2, 8.3.0, 8.4.0, and 8.5.0.

## [8.6.0] - 2026-05-28

### Added
- Slash commands beyond `/allow-api`: `/help`, `/compact`, `/reset`, `/screenshot`, `/export`, `/profile`, `/vision` (PR #82). Type `/help` in the side panel to see the list.

### Fixed
- System messages now bypass `formatMarkdown` so HTML (e.g. the `<img>` from `/screenshot`, the `<strong>` in `/allow-api` confirmations) renders instead of showing as escaped text.

### Changed
- Ollama default model placeholder is now empty (matching llama.cpp and LM Studio) instead of hardcoding `llama3.1`.

## [8.5.0] - 2026-05-28

### Fixed
- Comprehensive bug audit covering 65+ fixes across Chrome and Firefox builds.
- Preserved run-guard state on conversation clear so an in-flight agent run can still be stopped cleanly.
- Extended PDF read timeout through the response body phase, not just the connection phase.

## [8.4.0] - 2026-05-27

### Changed
- Merged `download_file` into `download_files` so a single tool handles both single-URL and array cases (max 3 concurrent).
- Compact-mode tool allowlist is now scoped to Act mode only; Ask mode keeps the full tool surface even when compact prompts are enabled.

### Fixed
- Suppressed stale-click warnings on editable targets (e.g. contenteditable Medium editors) where the click is intentional.
- `downloadFiles` now passes the user-supplied filename through to the download instead of falling back to the URL slug.
- Compact-mode allowlist is now enforced on text-parsed tool calls too, not only structured tool calls.
- `solve_captcha` is now part of the compact tool set so it stays available in compact mode.

## [8.3.0] - 2026-05-27

### Changed
- Compact mode is now fully opt-in: it never auto-enables based on model size heuristics. Users must check the box per-provider in Settings.

### Documentation
- Clarified in README and settings copy that compact mode is opt-in only and not auto-enabled.

## [8.2.2] - 2026-05-26

### Fixed
- Restricted deasciifier loading to `lang: "tr-deasciify"` so the ~175KB pattern table isn't pulled in for non-Turkish typing.
- Loaded the deasciifier in the content-script isolated world to avoid leaking globals into page scripts.

## [8.2.1] - 2026-05-26

### Fixed
- Patch release for deasciification edge cases discovered shortly after 8.2.0.

## [8.2.0] - 2026-05-26

### Added
- Added Turkish deasciification support via `lang: "tr-deasciify"` parameter on `type_text`, `type_ax`, and `set_field` tools. Converts ASCII Turkish (e.g. "calisma") to proper characters ("çalışma") before typing. Pattern table (~175KB) lazy-loaded on first use.

### Removed
- Removed `execute_js` from Chrome MV3 tool schema. The tool was already blocked by MV3's CSP (`new Function()` always throws EvalError). The agent now uses fine-grained tools (`read_page`, `click`, `type_text`, `scroll`, etc.) directly. Firefox MV2 retains `execute_js`.

## [8.1.0] - 2026-05-26

### Added
- Added first-launch onboarding wizard: a 3-step walkthrough covering what WebBrain does, Act mode safety warnings, and LLM provider setup.
- Added MiniMax and Alibaba Cloud (Qwen) as new cloud providers.
- Added model suggestion dropdowns for all cloud providers with a "Custom..." option for free-form entry.

### Changed
- Settings page now opens on the Providers tab by default.
- Updated model suggestions and placeholders across all cloud providers to current models.
- Hidden the Claude Pro/Max subscription provider card until OAuth flow is fixed.

## [8.0.0] - 2026-05-25

### Added
- Added `hover`, `drag_drop`, and `wait_for_stable` agent tools.
- Added 27 new site adapters and the initial sheets-mode foundation.
- Added spreadsheet A1-reference handling improvements, including absolute references and quote-aware sheet/range parsing.
- Added a configurable LLM request timeout setting with a 10–600 second range.
- Added Multimodal settings updates, including a renamed Multimodal tab and a new Transcription section.
- Added auto-save behavior for SocialMediaDownloader / MSE captures.

### Changed
- Flipped local-provider defaults: vision is enabled by default and compact prompts are disabled by default.
- Increased the default LLM request timeout to 120 seconds.
- Updated non-English locale labels for compact prompt settings.
- Extracted and reused Firefox `fetchWithTimeout` handling for Anthropic and llama.cpp requests.

### Fixed
- Fixed stale-index failures by surfacing fresh element enumeration.
- Fixed `execute_js` regressions and retained Firefox MV2-compatible `unsafe-eval` CSP behavior.
- Fixed adapter ordering and a `drag_drop` scroll race.
- Fixed `wait_for_stable` MAIN-world network counting.
- Fixed A1 parsing edge cases, including row validation and reversed whole-column / whole-row ranges.

## [7.3.5] - 2026-05-24

### Added
- Added LLM comparison materials, benchmark blog content, and additional scenarios.
- Added project governance documentation.

### Changed
- Increased the default maximum agent steps from 60 to 130.

### Fixed
- Included post-7.3.3 bug fixes and content-index diagnostics.

## [7.3.4] - 2026-05-23

### Fixed
- Included maintenance bug fixes following `v7.3.3`.

## [7.3.3] - 2026-05-23

### Fixed
- Fixed Firefox clarify-flow behavior.

## [7.3.2] - 2026-05-21

### Added
- Added tab recording support: tab capture, microphone capture, Web Audio mixing, and WebM download.
- Added Whisper transcription and agent summarization handoff for recordings.
- Added prompt-driven recording start with screenshot save support.
- Documented tab recorder architecture.

### Changed
- Removed the recorder toolbar Stop button in favor of the existing page banner stop control.

### Fixed
- Fixed corrupted WebM output by stripping codecs from the data URL.
- Fixed OpenAI transcription HTTP 415 errors by tagging blobs as `audio/webm`.
- Added friendlier transcription errors when a picker targets a chat-only server.
- Fixed stuck clarify responses by routing through `sendToBackground`.

## [7.3.1] - 2026-05-21

### Added
- Added local model loading for LM Studio and llama.cpp.
- Added NVIDIA and Groq provider options.
- Regenerated store promotional assets around the brain icon and added marquee artwork.

### Changed
- Updated provider links, website copy, and store iconography.
- Scoped Chrome side panel behavior to opt-in tabs to prevent new-tab leakage.
- Scoped `agent_update` broadcasts to the originating tab.

### Fixed
- Fixed CAPTCHA URL-string sitekey fallback and added friendlier demo-rejection handling.
- Included web and extension bug fixes prior to the `v7.3.1` tag.

## [7.3.0] - 2026-05-20

### Added
- Added provider filters and collapsible provider cards.
- Added four additional cloud providers.
- Added opt-in CapSolver integration for CAPTCHA solving.
- Surfaced CAPTCHA solver and provider constellation updates on the website and localized pages.

### Changed
- Show configured models in collapsed provider headers.
- Preserve unsaved provider edits across filter and collapse re-renders.

### Fixed
- Tightened reCAPTCHA detection and cleaned CAPTCHA balance display strings.

## [7.2.1] - 2026-05-20

### Changed
- Stopped emitting the loose credential note to small models.

## [7.2.0] - 2026-05-20

### Added
- Added credential redaction support.
- Added a clarify tool.
- Added a WordPress site adapter.
- Added opt-in strict credential handling mode.

### Changed
- Made credential handling loose by default, while keeping stricter behavior available by opt-in.

## [7.1.0] - 2026-05-17

### Added
- Added SocialMediaDownloader v4.
- Added release-mode support to the version bump script with release-boundary tagging.
- Added 9 localization languages: Russian, Ukrainian, Arabic, Japanese, Korean, Indonesian, Thai, Malay, and Tagalog.
- Added RTL support and website language navigation updates.

### Fixed
- Fixed current page context handling in chat turns.
- Fixed tool behavior from GPT-4o trace review, including honest counts, gallery filtering, and article extraction.
- Improved scrolling in `overflow:hidden` panes when the document itself is unscrollable.

## [7.0.0] - 2026-05-12

### Added
- Added larger fetch limits, prompt nudges, trace conversation grouping, step-limit summaries, and cost surfacing.
- Added URL-family thrashing detection and empty-output recovery.
- Added multilingual FAQ content for dry-run roadmap status.
- Added an npm-runnable version bump tool.

### Changed
- Removed the mobile app from the main repository.
- Improved AX-tree fallback for composers.
- Rebuilt submission zips for v7.0.0.

### Fixed
- Fixed sidepanel XSS exposure.
- Hardened agent `fetch_url` behavior against SSRF.
- Clarified that the agent cannot schedule, sleep, or check back later.

## [6.1.0] - 2026-05-04

### Added
- Added native PDF reading with `read_pdf` and Claude PDF passthrough.
- Added Claude Pro/Max subscription provider support via OAuth.
- Added OpenAI OAuth subscription provider support.
- Added LM Studio web-fetching tools (`fetch_url` and `research_url`).
- Added LM Studio plugin publishing and related FAQ updates.
- Added mobile-app experiments, including Expo scaffolding, chat/browser tabs, agent loop, OpenAI provider, and AX-tree tools.
- Added blog and documentation updates for vision-model shootouts and PDF support.

### Changed
- Simplified website header navigation.
- Mentioned PDF support in website and README tool documentation.

### Fixed
- Hardened the LM Studio plugin against SSRF and added streaming response caps.
- Fixed PDF reader credentialed fetch and content-type-aware tab detection.
- Restored subscription-provider default merging and CORS opt-in behavior.
- Fixed Chrome side-panel action-click race by keeping the side panel always enabled.
- Preserved intermediate reasoning across steps in verbose mode.

## [6.0.1] - 2026-05-04

### Added
- Added Firefox parity for the agent visual indicator and tab grouping.
- Added cross-platform extension zip build tooling.

### Changed
- Scoped Chrome sidebar visibility to a per-window WebBrain tab group.
- Stopped adopting user-owned tab groups.
- Lowered Act mode temperature.
- Refreshed documentation for the 5.x release line.

### Fixed
- Added an on-page agent visual indicator with border and Stop button.

## [5.1.0] - 2026-04-29

### Added
- Added an Ollama model picker and guidance for 403 origin-block behavior.
- Added press release links and website sharing/footer updates.
- Added additional tests for model reasoning-suppression kwargs.
- Added blog content for vision-model comparisons.

### Changed
- Rebuilt extension zips for v5.1.0.
- Updated README and web assets.

### Fixed
- Fixed NVIDIA NIM integration issues.
- Fixed math visual bugs and improved pagination.
- Fixed web traces issues.

## [5.0.0] - 2026-04-24

### Added
- Added localized landing pages for Spanish, French, Turkish, and Chinese.
- Added language dropdowns across localized web pages.
- Added plugin internationalization.

### Changed
- Improved website presentation.
- Added token-conscious screenshot handling with resizing and iterative JPEG compression.

### Fixed
- Added test coverage for image budget math.

## [4.2.1] - 2026-04-21

### Added
- Added `.one` suffix branding to the web side-panel header.
- Added FAQ guidance for recommended vision models and vLLM configuration.

### Changed
- Updated demo video URLs and documentation around `/allow-api` and v4.2 behavior.

## [4.2.0] - 2026-04-20

### Added
- Added agent scratchpad tooling.
- Added preservation of tool-result digests in summaries.
- Added profile features.

### Fixed
- Fixed vision-model checkbox behavior and settings issues.

## [4.1.0] - 2026-04-20

### Changed
- Improved settings UI.

### Fixed
- Fixed tab grouping issues.
- Fixed screenshot-related bugs.

## [4.0.1] - 2026-04-19

### Fixed
- Fixed overlay-related issues and added tests.

## [4.0.0] - 2026-04-19

### Added
- Added optional dedicated vision model support for screenshot reads.
- Added vision model connection testing.
- Added tab grouping to keep WebBrain tabs near the current context.

### Changed
- Stripped chain-of-thought output from vision model responses.
- Preserved newlines in user bubbles.
- Updated architecture documentation.

## [3.6.8] - 2026-04-15

### Added
- Added test scenarios.
- Added math-related improvements.
- Added Firefox accessibility-tree support.

### Changed
- Improved browser install cards and Chrome Web Store linking.
- Updated Chrome and Firefox Act prompts for form verification and CAPTCHA handoff.
- Improved mobile demo video handling.

## [2.2.0] - 2026-04-12

### Added
- Added agent robustness guardrails.
- Added auto-scroll behavior.
- Added type validation and done verification.

### Fixed
- Fixed click loops.

## [2.0.0] - 2026-04-11

### Changed
- Rebuilt release zips with clean ZipInfo attributes.

## [1.9.2] - 2026-04-11

### Changed
- Made the agent more persistent.

### Fixed
- Fixed deep verbose trigger behavior.

## [1.9.1] - 2026-04-11

### Fixed
- Fixed fallback parsing for `call:toolName{}` format with quote tokens.

## [1.6.2] - 2026-04-08

### Added
- Added `/allow-api` per-conversation override and documentation.

## [1.6.1] - 2026-04-08

### Changed
- Clarified prompting so UI actions and `fetch_url` reading behavior are distinguished.

## [1.6.0] - 2026-04-08

### Added
- Added background fetch support.
- Added hidden-tab research tooling.
- Added download tools.

## [1.5.10] - 2026-04-08

### Added
- Added viewport-filtered interactive elements.
- Added index-instability warnings.

## [1.5.9] - 2026-04-08

### Added
- Added screenshot annotations.
- Added unintended-navigation detection.

## [1.5.8] - 2026-04-08

### Added
- Added click-by-visible-text support to avoid selector guessing for buttons.

## [1.5.7] - 2026-04-08

### Added
- Added `type_text` into the focused element without requiring a selector.

## [1.5.6] - 2026-04-08

### Added
- Added cross-origin iframe support so the agent can act in embedded flows such as Stripe.

## [1.5.5] - 2026-04-08

### Fixed
- Omitted temperature for GPT-5 and o-series models that only support the default value.

## [1.5.4] - 2026-04-08

### Fixed
- Added coordinate-click loop detection.
- Fixed OpenAI `max_completion_tokens` handling.

## [1.5.3] - 2026-04-08

### Added
- Added FAQ entry updates.

### Changed
- Improved header UI cleanup.

### Fixed
- Added active-tab guards.

## [1.5.2] - 2026-04-08

### Changed
- Reverted the Act mode toast back to a one-time-per-install `confirm()` dialog.

## [1.5.1] - 2026-04-08

### Fixed
- Fixed coordinate-click device-pixel-ratio mismatch.
- Preferred selectors where available.

## [1.5.0] - 2026-04-08

### Changed
- Included seven quality improvements.

### Fixed
- Fixed settings bugs.

## [1.4.0] - 2026-04-08

### Added
- Added site adapters.
- Added a non-blocking Act mode hint.

## [1.3.0] - 2026-04-08

### Added
- Added loop detection with a soft nudge followed by hard stop for stuck agents.

## [1.2.2] - 2026-04-08

### Changed
- Taught the agent that it operates inside the user's authenticated browser.

## [1.2.1] - 2026-04-08

### Changed
- Seeded the first prompt with URL and screenshot context.
- Improved Firefox parity.

### Fixed
- Fixed Continue button behavior.

## [1.2.0] - 2026-04-08

### Added
- Added SPA navigation detection.
- Added auto-screenshot mode.
- Added vision support.

## [1.1.6] - 2026-04-08

### Changed
- Increased the default agent maximum steps from 25 to 60.

## [1.1.5] - 2026-04-08

### Changed
- Routed click and type actions through CDP with selector-resolution retries.

## [1.1.4] - 2026-04-08

### Changed
- Updated the default OpenAI model to GPT-5.

## [1.1.3] - 2026-04-08

### Added
- Added LM Studio as a built-in local provider.

## [1.1.2] - 2026-04-08

### Fixed
- Fixed a manifest load error by restoring `side_panel.default_path`.

## [1.1.1] - 2026-04-08

### Fixed
- Persisted agent conversation state across service worker restarts.

## [1.1.0] - 2026-04-08

### Added
- Added robust CDP click/type behavior with shadow DOM support.
- Added per-tab sidebar behavior.
- Added persistent chats.

## [0.9.3] - 2026-04-06

### Changed
- Removed the old Firefox v0.9.0 zip artifact.

## [0.9.0] - 2026-04-06

### Changed
- Removed the website section from the README.

## [0.7.0] - 2026-04-06

### Added
- Added Firefox support documentation to the README.
