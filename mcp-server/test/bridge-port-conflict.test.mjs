/**
 * A taken bridge port must degrade, never kill the server.
 *
 * The failure this pins down: an MCP server left running by a previous session
 * keeps the fixed bridge port, the next one exits on EADDRINUSE, and the host
 * loses all six tools — so the agent cannot say why the browser tools vanished
 * while the extension, still attached to the old process, reports "Connected".
 *
 * The holder here is not a bridge at all (a bare TCP listener), so there is
 * nothing to relay through: the server waits as a standby, every tool says
 * why, and it takes the port once it frees up. Sharing the port with another
 * copy of this server is test/bridge-peers.test.mjs.
 *
 * Run: node --test test/bridge-port-conflict.test.mjs   (after `npm run build`)
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";

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

async function occupy(port) {
  const squatter = createServer();
  squatter.listen(port, "127.0.0.1");
  await once(squatter, "listening");
  return squatter;
}

// Import-time config: the bridge reads its port once, so the env must be set
// before the module graph loads.
const BUSY_PORT = await freePort();
process.env.WEBMATE_BRIDGE_PORT = String(BUSY_PORT);
process.env.WEBMATE_CONNECT_GRACE_MS = "5000";
process.env.WEBMATE_BIND_RETRY_MS = "200";
// Never read the developer machine's real ~/.agentx/webmate/pairing.json.
process.env.WEBMATE_DIR = mkdtempSync(path.join(tmpdir(), "webmate-port-conflict-"));

const { WebMateBridge, describePortConflict } = await import("../dist/bridge.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a taken port leaves the bridge waiting with the reason, and it takes the port once free", async () => {
  const squatter = await occupy(BUSY_PORT);
  const bridge = new WebMateBridge();
  try {
    // Never throws: a copy that cannot bind waits as a standby.
    await bridge.start();
    assert.equal(bridge.role(), "standby");
    assert.equal(bridge.route().kind, "none");
    assert.match(bridge.unavailable(), new RegExp(`Port ${BUSY_PORT} is already in use`));
    assert.equal(bridge.publishesState(), false, "a copy without the port never writes state.json");
  } finally {
    squatter.close();
    await once(squatter, "close");
  }
  // The squatter is gone: the waiting bridge binds within its retry interval.
  const deadline = Date.now() + 5_000;
  while (bridge.role() !== "owner" && Date.now() < deadline) await sleep(20);
  assert.equal(bridge.role(), "owner");
  assert.equal(bridge.unavailable(), null);
  await bridge.stop();
});

test("an unavailable bridge fails commands with the reason, without waiting", async () => {
  const bridge = new WebMateBridge();
  bridge.markUnavailable("Port 17374 is already in use by PID 999 (node).");

  assert.equal(bridge.isConnected(), false);
  assert.match(bridge.unavailable(), /already in use/);

  // The connect grace exists for a browser that is mid-backoff. With no
  // listener there is nothing to wait for, so the answer must be immediate.
  const started = Date.now();
  await assert.rejects(
    () => bridge.request("cloud_status", {}),
    /already in use by PID 999/,
  );
  assert.ok(Date.now() - started < 1_000, "should not burn the connect grace");
  assert.equal(await bridge.waitForExtension(5_000), false);
});

test("the conflict message names the port and how to get out of it", async () => {
  const squatter = await occupy(BUSY_PORT);
  try {
    const message = await describePortConflict(BUSY_PORT);
    assert.match(message, new RegExp(`Port ${BUSY_PORT} is already in use`));
    assert.match(message, /previous session/);
    assert.match(message, /BRIDGE_PORT/);
    // Best-effort holder lookup: on this platform lsof can see our squatter.
    if (process.platform === "darwin" || process.platform === "linux") {
      assert.match(message, /by PID \d+/);
    }
  } finally {
    squatter.close();
    await once(squatter, "close");
  }
});

test("the server still serves its tools when the port is taken", async () => {
  const port = await freePort();
  const squatter = await occupy(port);
  // A throwaway WebMate dir: the server must never write state.json into the
  // developer's real profile from a test.
  const webmateDir = mkdtempSync(path.join(tmpdir(), "webmate-port-conflict-"));
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: packageDir,
    env: { ...process.env, WEBMATE_BRIDGE_PORT: String(port), WEBMATE_DIR: webmateDir },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const replies = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id != null) replies.get(msg.id)?.(msg);
  });

  let nextId = 0;
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(
        () => reject(new Error(`no reply to ${method}`)),
        10_000,
      );
      replies.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  try {
    // Not exiting is the whole point: a fatal EADDRINUSE never gets here.
    const init = await call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "port-conflict-test", version: "1" },
    });
    assert.equal(init.result.serverInfo.name, "agentx-webmate");
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
    );

    const listed = await call("tools/list", {});
    assert.equal(listed.result.tools.length, 6);

    const probe = await call("tools/call", {
      name: "webmate_connection",
      arguments: {},
    });
    const text = probe.result.content[0].text;
    assert.match(text, new RegExp(`Port ${port} is already in use`));
    assert.equal(probe.result.isError, true);
    // Structured code for Workmate, in the text and beside it.
    assert.match(text, /^WEBMATE_PORT_IN_USE: /);
    assert.equal(probe.result.structuredContent?.code, "WEBMATE_PORT_IN_USE");

    // And a real command says the same thing rather than blaming the browser.
    const run = await call("tools/call", {
      name: "webmate_run",
      arguments: { task: "read the page", mode: "ask" },
    });
    assert.match(run.result.content[0].text, /already in use/);
  } finally {
    child.stdin.end();
    squatter.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(webmateDir, { recursive: true, force: true });
  }
});
