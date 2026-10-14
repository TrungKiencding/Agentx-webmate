# SSO product usage

WebMate reports completed `chat.turn` (ask mode) and `agent.run` (act and dev modes) operations to the first-party SSO console. Cancelled operations and scheduled pauses are excluded. A chat turn refused before it starts because the account's AgentX license is read-only is reported too, as a failure with the license's code. The console must enable the authenticated `agentx-workmate` client; WebMate identifies its product as `agentx-webmate` while continuing to use the existing shared OAuth client.

The subject and workspace are assigned by the server from the signed access token. Only event ID, time, feature, result, release version, normalized operating system/browser, duration and, for a failure, a stable error code are sent. No prompts, URLs, page contents, raw errors or user-agent strings are sent.

A turn that ends as asked — or stops to ask the person for something only they can give (a clarification, a captcha, a recipient to confirm, a limited read) — is a success. The codes are the words AgentX Chat and Workmate use too, so the SSO dashboard and the developers' alerts group failures by them (AgentX-sso `docs/dashboard.md`, "Mã lỗi"); `brand/additions/common/src/agentx/telemetry.js` derives them:

| Code | When |
|---|---|
| `rate_limited` · `quota_exceeded` · `auth_failed` · `context_too_long` · `empty_response` · `cost_limit` | the agent's own classification of the error that ended the turn (`RATE_LIMIT`, `QUOTA`, `INVALID_CREDENTIAL`, `CONTEXT_WINDOW_EXCEEDED`, `EMPTY_RESPONSE`, `COST_LIMIT`) |
| `model_unavailable` · `upstream_error` · `bad_request` · `timeout` · `network_error` | a transport error, told apart by its HTTP status (404 · 5xx · other 4xx), a timeout, or a failed fetch |
| `license_required` · `license_expired` · `license_revoked` · `access_blocked`… | the AgentX license (by its state) or the keys service refused |
| `max_steps` · `loop_stopped` · `plain_final_blocked` · `required_tool_missing` · `observation_limit` · `empty_response` | the run ended without the result: out of steps, stuck in a loop, unable to finish its protocol, out of browser observations, or with an empty answer |
| `operation_failed` | nothing said what (the fallback) | Collection failure does not change the operation. Three bounded retries reuse one UUID and the server deduplicates them.

The operator enabled this first-party integration to monitor customer usage and quality. Product events begin after this release and do not reconstruct older activity. The server allowlist can disable collection.

Run `npm test` for lifecycle, account-change, cancellation, retry, real HTTP delivery, outcome and error-code, and browser build regressions (the built Chrome and Firefox agents report a failed turn's error, streaming and not). `npm run build:zip` packages the committed version; the signed release feed is verified before Workmate bundles it.

Firefox declares optional `technicalAndInteraction` collection and sends only while that built-in browser permission is granted. Existing installations can enable it in about:addons → Permissions and data. Missing permission support is treated as no consent. See https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/. Chromium collection follows the operator-enabled first-party integration. Session reads for metrics never refresh or modify authentication.
