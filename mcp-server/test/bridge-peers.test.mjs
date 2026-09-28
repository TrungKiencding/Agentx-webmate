/**
 * Several copies of the server, one bridge port (see src/peer.ts).
 *
 * AgentX starts a copy of this server in every process that loads MCP tools:
 * the desktop app's backend, the messaging gateway that outlives the app, a
 * slash-command worker. Only one can hold the port the extension dials. These
 * pin the rules that keep all of them working: a copy that cannot bind relays
 * through the holder; the desktop app's copy (higher priority) is handed the
 * port whoever came first, and the extension follows it; when the holder
 * leaves, a standby takes over; and nothing relays without the pairing token.
 *
 * Every bridge here lives in this one process, on a port picked at startup.
 *
 * Run: node --test test/bridge-peers.test.mjs   (after `npm run build`)
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  probe.close();
  await once(probe, "close");
  return port;
}

// Import-time config: set before the module graph loads.
const PORT = await freePort();
const WEBMATE_DIR = mkdtempSync(path.join(tmpdir(), "webmate-peers-"));
// An installed extension folder, so "not connected" is the answer rather than "not installed".
mkdirSync(path.join(WEBMATE_DIR, "AgentX WebMate"), { recursive: true });
writeFileSync(path.join(WEBMATE_DIR, "AgentX WebMate", "manifest.json"), "{}");
process.env.WEBMATE_DIR = WEBMATE_DIR;
process.env.WEBMATE_BRIDGE_PORT = String(PORT);
process.env.WEBMATE_COMMAND_TIMEOUT_MS = "2000";
process.env.WEBMATE_CONNECT_GRACE_MS = "1500";
process.env.WEBMATE_CONNECT_PROBE_MS = "200";
process.env.WEBMATE_HEARTBEAT_INTERVAL_MS = "0";
process.env.WEBMATE_BIND_RETRY_MS = "200";
process.env.WEBMATE_HANDOFF_DRAIN_MS = "2000";
process.env.WEBMATE_HANDOFF_TIMEOUT_MS = "500";

const { WebMateBridge, EXTENSION_CLIENT_ID } = await import("../dist/bridge.js");
const { PEER_CLIENT_ID, PEER_PATH } = await import("../dist/peer.js");

const PAIRING = { token: "t0k3n-".padEnd(44, "x"), port: null, installId: "test-install", createdAt: null };
const paired = async () => PAIRING;
const unpaired = async () => null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await sleep(20);
  }
}

/**
 * A paired extension that behaves like cloud-bridge.js where it matters here:
 * v3 hello with the pairing token and an instance id, and a redial shortly
 * after any close (the real one waits 500ms, then backs off to 10s).
 */
function fakeExtension({ instanceId = "inst-edge", handler } = {}) {
  const ext = { closes: [], commands: [], acks: 0, socket: null, stopped: false };
  const connect = () => {
    if (ext.stopped) return;
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/extension`, {
      origin: "chrome-extension://pfadeibckkgklmmjghiikadphihbpape",
    });
    ext.socket = socket;
    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          type: "hello",
          client: EXTENSION_CLIENT_ID,
          protocolVersion: 3,
          version: "1.0.7",
          browser: "Edge 154",
          installType: "workmate",
          signedIn: true,
          instanceId,
          token: PAIRING.token,
          capabilities: ["run_modes_v1"],
          status: {},
        }),
      );
    });
    socket.on("message", async (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "hello_ack") {
        ext.acks += 1;
        return;
      }
      if (!msg.action) return;
      ext.commands.push(msg);
      const reply = handler
        ? await handler(msg)
        : {
            ok: true,
            result: { runId: msg.payload?.runId ?? "run-x", status: "running", task: msg.payload?.task },
          };
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: msg.id, ...reply }));
    });
    socket.on("close", (code) => {
      // A refused dial closes with 1006 before it ever opened; only record real hang-ups.
      if (code !== 1006) ext.closes.push(code);
      if (ext.socket === socket) setTimeout(connect, 50);
    });
    socket.on("error", () => {});
  };
  connect();
  ext.stop = () => {
    ext.stopped = true;
    try {
      ext.socket?.terminate();
    } catch {
      /* gone */
    }
  };
  return ext;
}

/** Dial the peer path directly; resolves with the owner's first answer. */
function dialPeer({ token = PAIRING.token, origin, priority = 0, onYield } = {}) {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}${PEER_PATH}`, origin ? { origin } : {});
    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          type: "peer_hello",
          client: PEER_CLIENT_ID,
          peerProtocol: 1,
          serverVersion: "test",
          pid: 4242,
          host: "test-peer",
          priority,
          token,
        }),
      );
    });
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "peer_ack") resolve({ acked: true, socket, ack: msg });
      if (msg.type === "yield") onYield?.(socket);
    });
    socket.on("close", (code, reason) => resolve({ acked: false, code, reason: reason.toString() }));
    socket.on("error", () => {});
  });
}

/** A WebMate server from before the peer protocol: 1.2.x closes every path but /extension with 1008. */
async function legacyServer() {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket, request) => {
    if (!(request.url || "").startsWith("/extension")) socket.close(1008, "Unexpected path");
  });
  server.listen(PORT, "127.0.0.1");
  await once(server, "listening");
  return {
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("a copy that cannot bind relays its commands through the one that holds the port", async () => {
  const owner = new WebMateBridge({ readPairing: paired, priority: 0, host: "gateway" });
  const standby = new WebMateBridge({ readPairing: paired, priority: 0, host: "cli" });
  const ext = fakeExtension();
  try {
    await owner.start();
    assert.equal(owner.role(), "owner");
    await standby.start();
    assert.equal(standby.role(), "standby");
    const route = standby.route();
    assert.equal(route.kind, "relay");
    assert.equal(route.owner.host, "gateway");
    assert.equal(route.owner.pid, process.pid);

    assert.equal(await standby.waitForExtension(3_000), true, "the standby sees the owner's extension");
    assert.deepEqual(standby.connections().map((c) => [c.instanceId, c.browser, c.active]), [["inst-edge", "Edge 154", true]]);
    assert.equal(standby.info().signedIn, true);

    const result = await standby.request("cloud_run", { task: "read the page", mode: "ask", runId: "r1" });
    assert.equal(result.task, "read the page");
    assert.equal(ext.commands.at(-1).action, "cloud_run");
    assert.equal(ext.commands.at(-1).payload.runId, "r1");

    assert.deepEqual(owner.standbys().map((s) => s.host), ["cli"]);
    assert.equal(owner.publishesState(), true, "the holder writes state.json");
    assert.equal(standby.publishesState(), false, "a standby never does");
    assert.equal(standby.unavailable(), null);

    await assert.rejects(
      () => standby.request("workmate_reload", {}),
      /goes only from the server that holds the bridge port/,
      "Workmate's own commands stay with the owner",
    );
  } finally {
    ext.stop();
    await standby.stop();
    await owner.stop();
  }
});

test("the copy that outranks the holder is handed the port, and the extension follows it", async () => {
  const gateway = new WebMateBridge({ readPairing: paired, priority: 0, host: "gateway" });
  const desktop = new WebMateBridge({ readPairing: paired, priority: 100, host: "desktop" });
  const ext = fakeExtension();
  try {
    // The gateway started first (days ago, in the incident) and has the extension.
    await gateway.start();
    await until(() => gateway.isConnected(), "the extension attached to the gateway's copy");

    await desktop.start();
    await until(() => desktop.role() === "owner" && desktop.isConnected(), "the desktop's copy holds the port and the extension");
    assert.equal(gateway.role(), "standby");
    await until(() => gateway.route().kind === "relay", "the gateway's copy relays through the desktop's");
    assert.equal(gateway.route().owner.host, "desktop");
    assert.deepEqual(ext.closes, [1012], "handed over once, with a close code the extension redials on at once");
    assert.equal(ext.acks, 2);

    // Telegram still drives the browser, now through the desktop's copy.
    const viaGateway = await gateway.request("cloud_run", { task: "from telegram", mode: "act", runId: "r2" });
    assert.equal(viaGateway.task, "from telegram");
    const direct = await desktop.request("cloud_status", { runId: "r2" });
    assert.equal(direct.runId, "r2");

    assert.equal(desktop.publishesState(), true);
    assert.equal(gateway.publishesState(), false);
    assert.deepEqual(desktop.standbys().map((s) => s.host), ["gateway"]);
  } finally {
    ext.stop();
    await gateway.stop();
    await desktop.stop();
  }
});

test("when the holder leaves, a standby takes the port and the extension follows", async () => {
  const desktop = new WebMateBridge({ readPairing: paired, priority: 100, host: "desktop" });
  const gateway = new WebMateBridge({ readPairing: paired, priority: 0, host: "gateway" });
  const ext = fakeExtension();
  try {
    await desktop.start();
    await gateway.start();
    await until(() => gateway.isConnected(), "the gateway's copy sees the extension through the desktop's");

    await desktop.stop(); // the app quits
    await until(() => gateway.role() === "owner" && gateway.isConnected(), "the gateway's copy took the port and the extension");
    const result = await gateway.request("cloud_status", { runId: "r3" });
    assert.equal(result.runId, "r3");
    assert.equal(gateway.publishesState(), true);
  } finally {
    ext.stop();
    await gateway.stop();
    await desktop.stop();
  }
});

test("a command in flight when the port changes hands still gets its answer", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ext = fakeExtension({
    handler: async (msg) => {
      if (msg.payload?.task === "slow") await gate;
      return { ok: true, result: { runId: msg.payload?.runId ?? "run-x", status: "running", task: msg.payload?.task } };
    },
  });
  const gateway = new WebMateBridge({ readPairing: paired, priority: 0, host: "gateway" });
  const desktop = new WebMateBridge({ readPairing: paired, priority: 100, host: "desktop" });
  try {
    await gateway.start();
    await until(() => gateway.isConnected(), "extension on the gateway's copy");
    const slow = gateway.request("cloud_run", { task: "slow", mode: "ask", runId: "r4" });
    await until(() => ext.commands.some((c) => c.payload?.task === "slow"), "the slow command reached the browser");

    await desktop.start();
    await until(() => desktop.role() === "owner", "the desktop's copy bound the port");
    // The extension stays on the old socket until the command in flight there is answered.
    assert.deepEqual(ext.closes, []);
    release();
    const result = await slow;
    assert.equal(result.task, "slow", "the answer came back, not an interruption");
    await until(() => desktop.isConnected(), "the extension moved to the desktop's copy");
    assert.deepEqual(ext.closes, [1012]);
  } finally {
    release?.();
    ext.stop();
    await gateway.stop();
    await desktop.stop();
  }
});

test("a peer must carry the pairing token and must not be a browser page", async () => {
  const owner = new WebMateBridge({ readPairing: paired, priority: 0 });
  try {
    await owner.start();
    const wrongToken = await dialPeer({ token: "not-the-token" });
    assert.equal(wrongToken.acked, false);
    assert.equal(wrongToken.code, 1008);
    assert.match(wrongToken.reason, /Pairing token mismatch/);

    const webPage = await dialPeer({ origin: "https://evil.example" });
    assert.equal(webPage.acked, false);
    assert.equal(webPage.code, 1008);
    assert.match(webPage.reason, /Untrusted Origin/);

    const extensionPage = await dialPeer({ origin: "chrome-extension://pfadeibckkgklmmjghiikadphihbpape" });
    assert.equal(extensionPage.acked, false, "the peer socket is for native clients only");

    const good = await dialPeer();
    assert.equal(good.acked, true);
    assert.equal(good.ack.pid, process.pid);
    assert.deepEqual(owner.standbys().map((s) => s.pid), [4242]);
    good.socket.close();
  } finally {
    await owner.stop();
  }
});

test("without a Workmate pairing nothing relays: the second copy waits and takes the port once free", async () => {
  const first = new WebMateBridge({ readPairing: unpaired });
  const second = new WebMateBridge({ readPairing: unpaired });
  try {
    await first.start();
    await second.start();
    assert.equal(second.role(), "standby");
    assert.equal(second.route().kind, "none");
    assert.match(second.unavailable(), new RegExp(`Port ${PORT} is already in use`));
    assert.match(second.unavailable(), /Without a Workmate pairing/);

    const started = Date.now();
    await assert.rejects(
      () => second.request("cloud_status", {}),
      (error) => error.webmateCode === "WEBMATE_PORT_IN_USE",
    );
    assert.ok(Date.now() - started < 500, "fails at once instead of waiting out the connect grace");
    assert.equal(await second.waitForExtension(2_000), false);

    await first.stop();
    await until(() => second.role() === "owner", "the waiting copy took the port within its retry interval");
    assert.equal(second.unavailable(), null);
  } finally {
    await second.stop();
    await first.stop();
  }
});

test("a holder from before the peer protocol is named as such, and its port taken once it exits", async () => {
  const legacy = await legacyServer();
  const waiting = new WebMateBridge({ readPairing: paired, priority: 0 });
  try {
    await waiting.start();
    assert.equal(waiting.role(), "standby");
    assert.match(waiting.unavailable(), /older AgentX WebMate server/);
    await assert.rejects(
      () => waiting.request("cloud_run", { task: "x", mode: "ask" }),
      (error) => error.webmateCode === "WEBMATE_PORT_IN_USE" && /cannot share the browser bridge/.test(error.message),
    );
    await legacy.close();
    await until(() => waiting.role() === "owner", "took the port once the old server left");
  } finally {
    await waiting.stop();
    await legacy.close().catch(() => {});
  }
});

test("a relayed failure keeps its structured code", async () => {
  const owner = new WebMateBridge({ readPairing: paired, installDir: path.join(WEBMATE_DIR, "AgentX WebMate") });
  const standby = new WebMateBridge({ readPairing: paired });
  try {
    await owner.start();
    await standby.start();
    assert.equal(standby.route().kind, "relay");
    await assert.rejects(
      () => standby.request("cloud_status", {}),
      (error) => {
        assert.equal(error.webmateCode, "WEBMATE_NOT_CONNECTED");
        assert.match(error.message, /No AgentX WebMate extension is connected/);
        return true;
      },
    );
  } finally {
    await standby.stop();
    await owner.stop();
  }
});

test("a handoff the new holder never confirms is called off, and the holder keeps port and extension", async () => {
  const owner = new WebMateBridge({ readPairing: paired, priority: 0, host: "gateway" });
  const ext = fakeExtension();
  let yielded = false;
  let claimant;
  try {
    await owner.start();
    await until(() => owner.isConnected(), "extension attached");
    claimant = await dialPeer({
      priority: 100,
      onYield: () => {
        yielded = true; // ...and never binds, never answers
      },
    });
    assert.equal(claimant.acked, true);
    await until(() => yielded, "the owner offered the port");
    await sleep(800); // past WEBMATE_HANDOFF_TIMEOUT_MS
    assert.equal(owner.role(), "owner");
    assert.equal(owner.publishesState(), true);
    assert.deepEqual(ext.closes, [], "the extension never noticed");

    // The port is open again: a newcomer can still join.
    const late = new WebMateBridge({ readPairing: paired, priority: 0 });
    await late.start();
    assert.equal(late.route().kind, "relay");
    await late.stop();
  } finally {
    claimant?.socket?.close();
    ext.stop();
    await owner.stop();
  }
});

test("the desktop's copy retires an outdated server that AgentX supervises, and only that", { skip: process.platform === "win32" }, async () => {
  // An old bundle (same file name as the real one) that cannot relay, run the
  // way AgentX runs MCP servers on POSIX: under tools/mcp_stdio_watchdog.py.
  const dir = mkdtempSync(path.join(tmpdir(), "webmate-legacy-"));
  const legacyScript = path.join(dir, "agentx-webmate-mcp.mjs");
  writeFileSync(
    legacyScript,
    `import http from "node:http";
import { createRequire } from "node:module";
const { WebSocketServer } = createRequire(${JSON.stringify(path.join(packageDir, "package.json"))})("ws");
const server = http.createServer();
const wss = new WebSocketServer({ server });
wss.on("connection", (socket, request) => {
  if (!(request.url || "").startsWith("/extension")) socket.close(1008, "Unexpected path");
});
server.listen(Number(process.env.PORT), "127.0.0.1", () => console.log("listening"));
process.on("SIGTERM", () => { console.log("sigterm"); process.exit(0); });
`,
  );
  const watchdogScript = path.join(dir, "mcp_stdio_watchdog.mjs");
  writeFileSync(
    watchdogScript,
    `import { spawn } from "node:child_process";
const child = spawn(process.execPath, [${JSON.stringify(legacyScript)}], { stdio: "inherit" });
child.on("exit", (code, signal) => { console.log("child-exit " + code + " " + signal); setTimeout(() => process.exit(0), 50); });
process.on("SIGTERM", () => child.kill());
`,
  );
  const env = { ...process.env, PORT: String(PORT) };
  const lines = (child) => {
    const seen = [];
    child.stdout.on("data", (chunk) => seen.push(...chunk.toString().split("\n").filter(Boolean)));
    return seen;
  };

  // Not under the watchdog: left alone, however much it outranks.
  const bare = spawn(process.execPath, [legacyScript], { env, stdio: ["ignore", "pipe", "inherit"] });
  const bareOut = lines(bare);
  const desktop1 = new WebMateBridge({ readPairing: paired, priority: 100, host: "desktop" });
  try {
    await until(() => bareOut.includes("listening"), "unsupervised legacy server listening");
    await desktop1.start();
    await sleep(1_000);
    assert.equal(desktop1.role(), "standby");
    assert.ok(!bareOut.includes("sigterm"), "an unsupervised process is never signalled");
  } finally {
    await desktop1.stop();
    bare.kill("SIGKILL");
    await once(bare, "exit");
  }

  // Under the watchdog: asked to exit, and the port changes hands.
  const supervised = spawn(process.execPath, [watchdogScript], { env, stdio: ["ignore", "pipe", "inherit"] });
  const supervisedOut = lines(supervised);
  const desktop2 = new WebMateBridge({ readPairing: paired, priority: 100, host: "desktop" });
  const gateway = new WebMateBridge({ readPairing: paired, priority: 0, host: "gateway" });
  try {
    await until(() => supervisedOut.includes("listening"), "supervised legacy server listening");
    // A copy that does not outrank everything never retires anyone.
    await gateway.start();
    await sleep(700);
    assert.ok(!supervisedOut.includes("sigterm"), "only the desktop's copy retires an old server");

    await desktop2.start();
    await until(() => supervisedOut.includes("sigterm"), "the old server was asked to exit");
    // The port is about to free up: a command now waits for it rather than
    // failing at once (a hopeless wait returns immediately).
    const waitStarted = Date.now();
    await desktop2.waitForExtension(100);
    assert.ok(Date.now() - waitStarted >= 80 || desktop2.role() === "owner", "waits for the port instead of giving up");
    await until(() => desktop2.role() === "owner", "the desktop's copy took the port");
    assert.ok(supervisedOut.some((line) => line.startsWith("child-exit 0")), supervisedOut.join(" | "));
    await until(() => gateway.route().kind === "relay", "the waiting gateway copy now relays through the desktop's");
  } finally {
    await gateway.stop();
    await desktop2.stop();
    if (supervised.exitCode === null) supervised.kill("SIGKILL");
  }
});
