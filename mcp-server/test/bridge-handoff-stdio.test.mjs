/**
 * The Workmate incident, end to end over stdio: the messaging gateway's copy
 * of this server takes the bridge port first (the gateway outlives the app on
 * purpose), then the desktop app starts its own copy.
 *
 * Before the peer protocol the desktop's copy got WEBMATE_PORT_IN_USE for as
 * long as the gateway lived, while the extension showed "Connected" — to the
 * gateway. Now the desktop's copy (AGENTX_MCP_HOST=desktop) is handed the
 * port and the extension, state.json names it, the gateway's copy keeps
 * working by relaying through it, and the gateway's copy takes the port back
 * when the app quits.
 *
 * Run: node --test test/bridge-handoff-stdio.test.mjs   (after `npm run build`)
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import WebSocket from "ws";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const TOKEN = "stdio-handoff-".padEnd(44, "k");

async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  probe.close();
  await once(probe, "close");
  return port;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await sleep(25);
  }
}

/** One server process, spoken to as an MCP host would (newline-delimited JSON-RPC on stdio). */
function startServer({ host, port, dir }) {
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: packageDir,
    env: {
      ...process.env,
      AGENTX_MCP_HOST: host,
      WEBMATE_DIR: dir,
      WEBMATE_BRIDGE_PORT: String(port),
      WEBMATE_CONNECT_GRACE_MS: "5000",
      WEBMATE_HEARTBEAT_INTERVAL_MS: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const server = { child, host, stderr: "", replies: new Map(), nextId: 0 };
  child.stderr.on("data", (chunk) => {
    server.stderr += chunk.toString();
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id != null) server.replies.get(msg.id)?.(msg);
  });
  server.call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++server.nextId;
      const timer = setTimeout(() => reject(new Error(`${host}: no reply to ${method}`)), 20_000);
      server.replies.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  server.initialize = async () => {
    const init = await server.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: `stdio-handoff-${host}`, version: "1" },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    return init;
  };
  server.tool = async (name, args = {}) => (await server.call("tools/call", { name, arguments: args })).result;
  return server;
}

/** The paired extension: v3 hello with the token, redials 50ms after any close. */
function fakeExtension(port) {
  const ext = { tasks: [], closes: [], socket: null, stopped: false };
  const connect = () => {
    if (ext.stopped) return;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      origin: "chrome-extension://pfadeibckkgklmmjghiikadphihbpape",
    });
    ext.socket = socket;
    socket.on("open", () =>
      socket.send(
        JSON.stringify({
          type: "hello",
          client: "webbrain-extension",
          protocolVersion: 3,
          version: "1.0.7",
          browser: "Edge 154",
          installType: "workmate",
          signedIn: true,
          instanceId: "inst-edge",
          token: TOKEN,
          capabilities: ["run_modes_v1"],
          status: {},
        }),
      ),
    );
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (!msg.action) return;
      if (msg.action === "cloud_run") ext.tasks.push(msg.payload.task);
      socket.send(
        JSON.stringify({
          id: msg.id,
          ok: true,
          result: { runId: msg.payload.runId ?? "run-x", status: "running", task: msg.payload.task },
        }),
      );
    });
    socket.on("close", (code) => {
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

test("gateway first, desktop second: the desktop's copy ends up owning the bridge; the gateway keeps working through it", async () => {
  const port = await freePort();
  const dir = mkdtempSync(path.join(tmpdir(), "webmate-stdio-handoff-"));
  writeFileSync(
    path.join(dir, "pairing.json"),
    JSON.stringify({ schema: 1, token: TOKEN, port, installId: "stdio-handoff", createdAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  mkdirSync(path.join(dir, "AgentX WebMate"), { recursive: true });
  writeFileSync(path.join(dir, "AgentX WebMate", "manifest.json"), "{}");
  const stateFile = path.join(dir, "state.json");
  const readState = () => {
    try {
      return existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : null;
    } catch {
      return null; // mid-rename
    }
  };

  const ext = fakeExtension(port);
  const gateway = startServer({ host: "gateway", port, dir });
  let desktop;
  try {
    await gateway.initialize();
    await until(
      () => readState()?.pid === gateway.child.pid && readState()?.connected,
      "the gateway's copy holds the port with the extension attached",
    );
    assert.equal(readState().host, "gateway");

    // The desktop app starts while that gateway is still running.
    desktop = startServer({ host: "desktop", port, dir });
    await desktop.initialize();
    const owned = await until(() => {
      const state = readState();
      return state?.pid === desktop.child.pid && state.connected && state.standbys?.length ? state : null;
    }, "state.json names the desktop's copy, with the extension attached and the gateway relaying");
    assert.equal(owned.host, "desktop");
    assert.equal(owned.priority, 100);
    assert.equal(owned.listening, true);
    assert.deepEqual(owned.standbys.map((s) => [s.pid, s.host]), [[gateway.child.pid, "gateway"]]);
    assert.deepEqual(ext.closes, [1012], "the extension was handed over once");

    // The desktop's own agent drives the browser directly…
    const fromDesktop = await desktop.tool("webmate_connection");
    assert.equal(fromDesktop.isError, undefined, JSON.stringify(fromDesktop));
    assert.match(fromDesktop.content[0].text, new RegExp(`^Connected\\. Listening on ws://127\\.0\\.0\\.1:${port}/extension`));
    assert.equal(fromDesktop.structuredContent.route, "direct");

    // …and Telegram still can, through the desktop's copy.
    const fromGateway = await gateway.tool("webmate_connection");
    assert.match(
      fromGateway.content[0].text,
      new RegExp(`^Connected\\. Relaying through the bridge on ws://127\\.0\\.0\\.1:${port}/extension, which PID ${desktop.child.pid} \\(desktop\\) holds`),
    );
    assert.equal(fromGateway.structuredContent.route, "relay");
    const run = await gateway.tool("webmate_run", { task: "check the dashboard from telegram", mode: "ask", wait: false });
    assert.equal(run.isError, undefined, JSON.stringify(run));
    assert.match(run.content[0].text, /Started in the background/);
    assert.ok(ext.tasks.includes("check the dashboard from telegram"));

    assert.match(desktop.stderr, /host=desktop\] listening on ws:\/\/127\.0\.0\.1:\d+\/extension \(Workmate pairing required\) — bridge owner, priority 100/);
    assert.match(gateway.stderr, /host=gateway\] handing the bridge to PID \d+ \(desktop\)/);
    assert.match(gateway.stderr, new RegExp(`host=gateway\\] standby: relaying through the bridge owner, PID ${desktop.child.pid} \\(desktop\\)`));

    // The app quits: its copy exits on stdin EOF, and the gateway's takes the port back.
    const exited = once(desktop.child, "exit");
    desktop.child.stdin.end();
    await exited;
    await until(
      () => readState()?.pid === gateway.child.pid && readState()?.connected,
      "the gateway's copy took the port back and the extension followed",
    );
    const after = await gateway.tool("webmate_connection");
    assert.equal(after.structuredContent.route, "direct");
  } catch (error) {
    error.message +=
      `\n--- gateway stderr ---\n${gateway.stderr}` + (desktop ? `\n--- desktop stderr ---\n${desktop.stderr}` : "");
    throw error;
  } finally {
    ext.stop();
    for (const server of [desktop, gateway]) {
      if (!server) continue;
      server.child.stdin.end();
      if (server.child.exitCode === null && server.child.signalCode === null) {
        await Promise.race([once(server.child, "exit"), sleep(2_000)]);
        if (server.child.exitCode === null) server.child.kill("SIGKILL");
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
