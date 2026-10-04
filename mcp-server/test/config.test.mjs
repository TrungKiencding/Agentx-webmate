/**
 * Config parsing tests.
 *
 * Regression guard for a real bug: a single `intFromEnv` helper applied a
 * port-shaped 1-65535 ceiling to every numeric setting, so exporting the
 * five-minute run timeout that the README documents as the DEFAULT
 * (`WEBMATE_RUN_TIMEOUT_MS=300000`) crashed the server at startup with
 * "must be a valid TCP port".
 *
 * Ports and durations are different types with different bounds. These tests
 * exist to keep them that way. They also pin the WEBBRAIN_* fallback so
 * settings copied from upstream documentation keep working.
 *
 * Run: node --test test/config.test.mjs   (after `npm run build`)
 */

import assert from "node:assert/strict";
import test from "node:test";

/** ESM caches by URL, so a unique query string forces a fresh module + re-read of env. */
let seq = 0;
async function loadConfig(env) {
  const saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await import(`../dist/config.js?case=${seq++}`);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const SETTINGS = [
  "BRIDGE_PORT",
  "BRIDGE_PATH",
  "COMMAND_TIMEOUT_MS",
  "RUN_TIMEOUT_MS",
  "POLL_INTERVAL_MS",
];
const CLEAN = Object.fromEntries(
  SETTINGS.flatMap((name) => [
    [`WEBMATE_${name}`, undefined],
    [`WEBBRAIN_${name}`, undefined],
  ]),
);

test("defaults are sane and the bridge URL is loopback", async () => {
  const { config, bridgeUrl } = await loadConfig(CLEAN);
  assert.equal(config.bridgePort, 17374, "must not collide with Cloud on 17373");
  assert.equal(config.bridgePath, "/extension");
  assert.equal(config.commandTimeoutMs, 30_000);
  assert.equal(config.defaultRunTimeoutMs, 300_000);
  assert.equal(config.pollIntervalMs, 1_000);
  assert.equal(bridgeUrl(), "ws://127.0.0.1:17374/extension");
});

test("durations above the 16-bit port ceiling are accepted", async () => {
  // The exact value the README documents. This threw before the fix.
  const { config } = await loadConfig({ ...CLEAN, WEBMATE_RUN_TIMEOUT_MS: "300000" });
  assert.equal(config.defaultRunTimeoutMs, 300_000);
});

test("every duration setting accepts a large value", async () => {
  const { config } = await loadConfig({
    ...CLEAN,
    WEBMATE_COMMAND_TIMEOUT_MS: "120000",
    WEBMATE_RUN_TIMEOUT_MS: "3600000",
    WEBMATE_POLL_INTERVAL_MS: "250000",
  });
  assert.equal(config.commandTimeoutMs, 120_000);
  assert.equal(config.defaultRunTimeoutMs, 3_600_000);
  assert.equal(config.pollIntervalMs, 250_000);
});

test("ports keep their 1-65535 bound", async () => {
  await assert.rejects(
    () => loadConfig({ ...CLEAN, WEBMATE_BRIDGE_PORT: "70000" }),
    /must be a valid TCP port/,
  );
  await assert.rejects(
    () => loadConfig({ ...CLEAN, WEBMATE_BRIDGE_PORT: "0" }),
    /must be a valid TCP port/,
  );
});

test("non-numeric and partially-numeric values are rejected outright", async () => {
  await assert.rejects(
    () => loadConfig({ ...CLEAN, WEBMATE_BRIDGE_PORT: "abc" }),
    /must be an integer/,
  );
  // parseInt("8080abc") silently yields 8080; that is a typo, not a config.
  await assert.rejects(
    () => loadConfig({ ...CLEAN, WEBMATE_BRIDGE_PORT: "8080abc" }),
    /must be an integer/,
  );
  await assert.rejects(
    () => loadConfig({ ...CLEAN, WEBMATE_RUN_TIMEOUT_MS: "5s" }),
    /must be an integer/,
  );
});

test("non-positive durations are rejected", async () => {
  await assert.rejects(
    () => loadConfig({ ...CLEAN, WEBMATE_POLL_INTERVAL_MS: "0" }),
    /positive duration in milliseconds/,
  );
  await assert.rejects(
    () => loadConfig({ ...CLEAN, WEBMATE_COMMAND_TIMEOUT_MS: "-1" }),
    /positive duration in milliseconds/,
  );
});

test("the brand prefix from brand.config.json is honoured and beats the fallbacks", async () => {
  const { BRAND } = await import("../dist/brand.generated.js");
  // Build the env so the brand key is applied last: on a brand whose prefix is
  // WEBMATE_ itself (AgentX) it must simply override, elsewhere it must win by precedence.
  const env = { ...CLEAN, WEBBRAIN_BRIDGE_PORT: "17400", WEBMATE_BRIDGE_PORT: "17401" };
  env[`${BRAND.envPrefix}BRIDGE_PORT`] = "17402";
  const branded = await loadConfig(env);
  assert.equal(branded.config.bridgePort, 17402);
});

test("upstream WEBBRAIN_* names still work, and WEBMATE_* wins when both are set", async () => {
  const legacy = await loadConfig({
    ...CLEAN,
    WEBBRAIN_BRIDGE_PORT: "17400",
    WEBBRAIN_BRIDGE_PATH: "/legacy",
    WEBBRAIN_POLL_INTERVAL_MS: "250",
  });
  assert.equal(legacy.config.bridgePort, 17400);
  assert.equal(legacy.config.bridgePath, "/legacy");
  assert.equal(legacy.config.pollIntervalMs, 250);
  assert.equal(legacy.bridgeUrl(), "ws://127.0.0.1:17400/legacy");

  const both = await loadConfig({
    ...CLEAN,
    WEBBRAIN_BRIDGE_PORT: "17400",
    WEBMATE_BRIDGE_PORT: "17401",
  });
  assert.equal(both.config.bridgePort, 17401);

  // Errors name the variable that was actually set, so a copied snippet is debuggable.
  await assert.rejects(
    () => loadConfig({ ...CLEAN, WEBBRAIN_BRIDGE_PORT: "nope" }),
    /WEBBRAIN_BRIDGE_PORT must be an integer/,
  );
});

test("the WebMate directory anchors at the install root, above account and profile layers", async () => {
  const { resolveWebmateDir, stripHomeScopingSegments, platformAgentxRoot } = await loadConfig(CLEAN);
  const sep = (p) => p.split("\\").join("/");

  assert.equal(sep(stripHomeScopingSegments("/Users/k/.agentx")), "/Users/k/.agentx");
  assert.equal(sep(stripHomeScopingSegments("/Users/k/.agentx/accounts/kien")), "/Users/k/.agentx");
  assert.equal(sep(stripHomeScopingSegments("/Users/k/.agentx/profiles/work")), "/Users/k/.agentx");
  assert.equal(sep(stripHomeScopingSegments("/Users/k/.agentx/accounts/kien/profiles/work")), "/Users/k/.agentx");

  // Explicit wins, then AGENTX_HOME (per-account) climbs to the root.
  assert.equal(sep(resolveWebmateDir({ WEBMATE_DIR: "/tmp/wm" })), "/tmp/wm");
  assert.equal(sep(resolveWebmateDir({ AGENTX_HOME: "/Users/k/.agentx/accounts/kien" })), "/Users/k/.agentx/webmate");
  // Platform default mirrors hermes_constants.py: ~/.agentx vs %LOCALAPPDATA%\\agentx.
  assert.equal(sep(resolveWebmateDir({}, "darwin", "/Users/k")), "/Users/k/.agentx/webmate");
  assert.equal(sep(platformAgentxRoot({ LOCALAPPDATA: "C:\\Users\\k\\AppData\\Local" }, "win32", "C:\\Users\\k")), "C:/Users/k/AppData/Local/agentx");
  assert.equal(sep(platformAgentxRoot({}, "win32", "C:\\Users\\k")), "C:/Users/k/AppData/Local/agentx");
});

test("state, pairing and commands paths follow the WebMate directory and can be switched off", async () => {
  const on = await loadConfig({ ...CLEAN, WEBMATE_DIR: "/tmp/wm-on", WEBMATE_STATE_FILE: undefined, WEBMATE_PAIRING_FILE: undefined, WEBMATE_COMMANDS_DIR: undefined });
  const norm = (p) => (p == null ? p : p.split("\\").join("/"));
  assert.equal(norm(on.config.webmateDir), "/tmp/wm-on");
  assert.equal(norm(on.config.pairingFile), "/tmp/wm-on/pairing.json");
  assert.equal(norm(on.config.stateFile), "/tmp/wm-on/state.json");
  assert.equal(norm(on.config.commandsDir), "/tmp/wm-on/commands");
  assert.equal(norm(on.config.installDir), "/tmp/wm-on/AgentX WebMate");

  const off = await loadConfig({ ...CLEAN, WEBMATE_DIR: "/tmp/wm-off", WEBMATE_STATE_FILE: "off", WEBMATE_COMMANDS_DIR: "off", WEBMATE_PAIRING_FILE: "/etc/pairing.json" });
  assert.equal(off.config.stateFile, null);
  assert.equal(off.config.commandsDir, null);
  assert.equal(norm(off.config.pairingFile), "/etc/pairing.json");
});

test("the desktop app's copy outranks every other host on the bridge port unless told otherwise", async () => {
  const clean = { ...CLEAN, WEBMATE_BRIDGE_PRIORITY: undefined, WEBBRAIN_BRIDGE_PRIORITY: undefined };
  const plain = await loadConfig({ ...clean, AGENTX_MCP_HOST: undefined });
  assert.equal(plain.config.bridgeHost, null);
  assert.equal(plain.config.bridgePriority, 0);

  const gateway = await loadConfig({ ...clean, AGENTX_MCP_HOST: "gateway" });
  assert.equal(gateway.config.bridgeHost, "gateway");
  assert.equal(gateway.config.bridgePriority, 0);

  const desktop = await loadConfig({ ...clean, AGENTX_MCP_HOST: "desktop" });
  assert.equal(desktop.config.bridgeHost, "desktop");
  assert.equal(desktop.config.bridgePriority, desktop.DESKTOP_BRIDGE_PRIORITY);
  assert.ok(desktop.DESKTOP_BRIDGE_PRIORITY > 0);

  // An explicit priority wins over the host default, negative included.
  const pinned = await loadConfig({ ...clean, AGENTX_MCP_HOST: "desktop", WEBMATE_BRIDGE_PRIORITY: "-5" });
  assert.equal(pinned.config.bridgePriority, -5);
  await assert.rejects(() => loadConfig({ ...clean, WEBMATE_BRIDGE_PRIORITY: "high" }), /must be an integer/);
});

test("handoff and retry timings are durations with sane defaults", async () => {
  const clean = {
    ...CLEAN,
    WEBMATE_BIND_RETRY_MS: undefined,
    WEBMATE_HANDOFF_DRAIN_MS: undefined,
    WEBMATE_HANDOFF_TIMEOUT_MS: undefined,
  };
  const { config } = await loadConfig(clean);
  assert.equal(config.bindRetryMs, 5_000);
  assert.equal(config.handoffDrainMs, 5_000);
  assert.equal(config.handoffTimeoutMs, 5_000);
  await assert.rejects(() => loadConfig({ ...clean, WEBMATE_BIND_RETRY_MS: "0" }), /positive duration/);
});
