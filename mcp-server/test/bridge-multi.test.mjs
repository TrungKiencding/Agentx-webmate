/**
 * Several extensions on one bridge (phase 4).
 *
 * The person's own browser and the Workmate browser window both dial the
 * same port with the same pairing token and even the same `browser` label.
 * Before this, the newer valid hello superseded the older socket and the two
 * fought over the port; now both stay, keyed by `hello.instanceId`, runs go
 * back to the browser that owns them, and `session` frames update the
 * sign-in fact without a reconnect.
 *
 * Run: node --test test/bridge-multi.test.mjs   (after `npm run build`)
 */

import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WEBMATE_DIR = mkdtempSync(join(tmpdir(), "webmate-multi-"));
process.env.WEBMATE_BRIDGE_PORT = process.env.WEBMATE_BRIDGE_PORT || "17396";
process.env.WEBMATE_COMMAND_TIMEOUT_MS = "2000";
process.env.WEBMATE_CONNECT_GRACE_MS = "300";
process.env.WEBMATE_HEARTBEAT_INTERVAL_MS = "0";

const { WebMateBridge, EXTENSION_CLIENT_ID, pickActive } = await import("../dist/bridge.js");
const { bridgeUrl } = await import("../dist/config.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A v3 extension with an instance id; answers every command with its own name. */
function dial({ instanceId, browser = "Chrome 152", signedIn = false, handler } = {}) {
  const socket = new WebSocket(bridgeUrl());
  const events = { acks: [], closes: [], commands: [] };
  socket.on("open", () => {
    socket.send(
      JSON.stringify({
        type: "hello",
        client: EXTENSION_CLIENT_ID,
        protocolVersion: 3,
        version: "1.0.5",
        browser,
        installType: "workmate",
        signedIn,
        ...(instanceId ? { instanceId } : {}),
        capabilities: ["workmate_update_v1"],
        status: {},
      }),
    );
  });
  socket.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "hello_ack") {
      events.acks.push(msg);
      return;
    }
    if (!msg.action) return;
    events.commands.push(msg);
    const reply = handler
      ? await handler(msg)
      : { ok: true, result: { from: instanceId ?? browser, action: msg.action, runId: msg.payload?.runId } };
    socket.send(JSON.stringify({ id: msg.id, ...reply }));
  });
  socket.on("close", (code, reason) => events.closes.push({ code, reason: reason.toString() }));
  const acked = new Promise((resolve) => socket.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "hello_ack") resolve(msg);
  }));
  const closed = new Promise((resolve) => socket.on("close", resolve));
  return { socket, events, acked, closed, send: (frame) => socket.send(JSON.stringify(frame)) };
}

test("pickActive prefers a signed-in browser, then the newest hello", () => {
  const c = (key, signedIn, acceptedAt) => ({ key, info: { signedIn }, acceptedAt });
  assert.equal(pickActive([]), null);
  assert.equal(pickActive([c("a", false, 1), c("b", null, 2)]).key, "b");
  assert.equal(pickActive([c("a", true, 1), c("b", null, 2)]).key, "a");
  assert.equal(pickActive([c("a", true, 1), c("b", true, 2)]).key, "b");
});

test("two browsers stay attached side by side, and each command reaches the one it names", async () => {
  const bridge = new WebMateBridge();
  await bridge.start();

  const own = dial({ instanceId: "inst-own", browser: "Chrome 152" });
  await own.acked;
  const window = dial({ instanceId: "inst-window", browser: "Chrome 152" });
  await window.acked;
  await sleep(20);

  assert.equal(own.events.closes.length, 0, "the first browser must not be knocked off by the second");
  assert.equal(bridge.isConnected(), true);
  const attached = bridge.connections();
  assert.deepEqual(attached.map((c) => c.instanceId).sort(), ["inst-own", "inst-window"]);
  assert.equal(attached.filter((c) => c.active).length, 1, "exactly one connection is active");
  assert.equal(bridge.info().instanceId, "inst-window", "nothing signed in: the newest hello is active");
  assert.ok(bridge.snapshot().connections.length === 2);

  const named = await bridge.request("cloud_status", {}, undefined, { instanceId: "inst-own" });
  assert.equal(named.from, "inst-own");
  const defaulted = await bridge.request("cloud_status", {});
  assert.equal(defaulted.from, "inst-window");

  await assert.rejects(
    () => bridge.request("cloud_status", {}, undefined, { instanceId: "inst-nope" }),
    (error) => {
      assert.equal(error.webmateCode, "WEBMATE_NOT_CONNECTED");
      assert.match(error.message, /inst-nope/);
      return true;
    },
  );

  own.socket.close();
  window.socket.close();
  await Promise.all([own.closed, window.closed]);
  await bridge.stop();
});

test("a run started in one browser is followed there by status, respond and abort", async () => {
  const bridge = new WebMateBridge();
  await bridge.start();

  const a = dial({ instanceId: "inst-a", browser: "Edge 152", signedIn: true });
  await a.acked;
  const b = dial({ instanceId: "inst-b", browser: "Chrome 152", signedIn: true });
  await b.acked;
  await sleep(20);
  assert.equal(bridge.info().instanceId, "inst-b", "both signed in: the newest hello is active");

  // Start a run in the non-active browser explicitly.
  const started = await bridge.request("cloud_run", { runId: "run-a", task: "x", mode: "ask" }, undefined, { instanceId: "inst-a" });
  assert.equal(started.from, "inst-a");

  // Subsequent frames naming that run go back to browser A even though B is active.
  const status = await bridge.request("cloud_status", { runId: "run-a" });
  assert.equal(status.from, "inst-a");
  const answered = await bridge.request("cloud_respond", { runId: "run-a", clarifyId: "c", answer: "yes" });
  assert.equal(answered.from, "inst-a");
  const aborted = await bridge.request("cloud_abort", { runId: "run-a" });
  assert.equal(aborted.from, "inst-a");
  // An unknown run goes to the active browser.
  const elsewhere = await bridge.request("cloud_status", { runId: "run-unknown" });
  assert.equal(elsewhere.from, "inst-b");

  // A `runs` list learned from B teaches the owner of its runs.
  const lister = dial({
    instanceId: "inst-c",
    browser: "Brave 152",
    handler: (msg) => ({ ok: true, result: { from: "inst-c", runs: [{ runId: "run-c1", status: "running" }] } }),
  });
  await lister.acked;
  await bridge.request("cloud_status", {}, undefined, { instanceId: "inst-c" });
  const followed = await bridge.request("cloud_abort", { runId: "run-c1" });
  assert.equal(followed.from, "inst-c");

  // When the owner leaves, its runs are forgotten and the active browser answers.
  lister.socket.close();
  await lister.closed;
  await sleep(20);
  const orphan = await bridge.request("cloud_status", { runId: "run-c1" });
  assert.equal(orphan.from, "inst-b");

  a.socket.close();
  b.socket.close();
  await Promise.all([a.closed, b.closed]);
  await bridge.stop();
});

test("a reconnect from the same instance replaces only its own previous socket", async () => {
  const bridge = new WebMateBridge();
  await bridge.start();

  const other = dial({ instanceId: "inst-other" });
  await other.acked;
  // Never answers, so the command below is still in flight when the same
  // instance dials again (an answering fake wins that race on loopback).
  const first = dial({ instanceId: "inst-same", handler: () => new Promise(() => {}) });
  await first.acked;
  const pendingOnFirst = bridge.request("cloud_status", {}, undefined, { instanceId: "inst-same" }).catch((e) => e);

  const again = dial({ instanceId: "inst-same" });
  await again.acked;
  await first.closed;
  assert.equal(first.events.closes[0].code, 1000);
  assert.match(first.events.closes[0].reason, /reconnect of the same extension/);
  const interrupted = await pendingOnFirst;
  assert.equal(interrupted.code, "COMMAND_INTERRUPTED", "a command in flight on the replaced socket fails clearly");
  assert.equal(other.events.closes.length, 0, "the other browser is untouched");
  assert.deepEqual(bridge.connections().map((c) => c.instanceId).sort(), ["inst-other", "inst-same"]);

  again.socket.close();
  other.socket.close();
  await Promise.all([again.closed, other.closed]);
  await bridge.stop();
});

test("a session frame updates the sign-in fact and can change which browser is active", async () => {
  const bridge = new WebMateBridge();
  const changes = [];
  bridge.onChange(() => changes.push(bridge.snapshot().connections.map((c) => [c.instanceId, c.signedIn, c.active])));
  await bridge.start();

  const first = dial({ instanceId: "inst-1", signedIn: false });
  await first.acked;
  const second = dial({ instanceId: "inst-2", signedIn: false });
  await second.acked;
  await sleep(20);
  assert.equal(bridge.info().instanceId, "inst-2");

  first.send({ type: "session", signedIn: true });
  await sleep(50);
  assert.equal(bridge.connections().find((c) => c.instanceId === "inst-1").signedIn, true);
  assert.equal(bridge.info().instanceId, "inst-1", "the signed-in browser becomes the active one");
  assert.equal(bridge.info().signedIn, true);

  // markSignedIn (from an auth_hint answer) does the same without a frame.
  bridge.markSignedIn("inst-2", true);
  assert.equal(bridge.connections().find((c) => c.instanceId === "inst-2").signedIn, true);
  assert.equal(bridge.info().instanceId, "inst-2", "both signed in again: newest wins");
  first.send({ type: "session", signedIn: true });
  await sleep(30);
  assert.ok(changes.length >= 4, "every fact change notifies state.json");

  first.socket.close();
  second.socket.close();
  await Promise.all([first.closed, second.closed]);
  await bridge.stop();
});

test("an extension that sends no instance id still attaches, under a per-socket id", async () => {
  const bridge = new WebMateBridge();
  await bridge.start();
  const old = dial({ browser: "Chrome 151" });
  await old.acked;
  const [only] = bridge.connections();
  assert.match(only.instanceId, /^socket:\d+$/);
  assert.equal(only.browser, "Chrome 151");
  old.socket.close();
  await old.closed;
  await sleep(20);
  assert.equal(bridge.isConnected(), false);
  await bridge.stop();
});
