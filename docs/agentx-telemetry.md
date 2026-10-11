# SSO product usage

WebMate reports completed `chat.turn`, `agent.plan` and `agent.run` operations to the first-party SSO console. Cancelled operations and scheduled pauses are excluded. The console must enable the authenticated `agentx-workmate` client; WebMate identifies its product as `agentx-webmate` while continuing to use the existing shared OAuth client.

The subject and workspace are assigned by the server from the signed access token. Only event ID, time, feature, result, release version, normalized operating system/browser, duration and generic failure code are sent. No prompts, URLs, page contents, raw errors or user-agent strings are sent. Collection failure does not change the operation. Three bounded retries reuse one UUID and the server deduplicates them.

The operator enabled this first-party integration to monitor customer usage and quality. Product events begin after this release and do not reconstruct older activity. The server allowlist can disable collection.

Run `npm test` for lifecycle, account-change, cancellation, retry, real HTTP delivery and browser build regressions. `npm run build:zip` packages the committed version; the signed release feed is verified before Workmate bundles it.

Firefox declares optional `technicalAndInteraction` collection and sends only while that built-in browser permission is granted. Existing installations can enable it in about:addons → Permissions and data. Missing permission support is treated as no consent. See https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/. Chromium collection follows the operator-enabled first-party integration. Session reads for metrics never refresh or modify authentication.
