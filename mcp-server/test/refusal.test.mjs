/**
 * The extension's own refusals (EXTENSION_REFUSAL_CODES) reach the MCP host
 * intact: the AgentX license gate answers a run with
 * `{ ok: false, error, status: 403, code: "license_read_only", license }`,
 * and Workmate must see that code and that license — not a bare 403 — both
 * when this copy holds the port and when it relays through the copy that does.
 *
 * Run: node --test test/refusal.test.mjs   (after `npm run build`)
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import WebSocket from "ws";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { loadBrand } from "../scripts/brand.mjs";

const { BridgeError, EXTENSION_REFUSAL_CODES, refusalFrom } = await import("../dist/errors.js");
const { errorFromWire, errorToWire } = await import("../dist/peer.js");

const BRAND = loadBrand();
const tool = (name) => `${BRAND.toolPrefix}_${name}`;
const packageDir = fileURLToPath(new URL("..", import.meta.url));

const LICENSE = {
  state: "expired",
  access: "read_only",
  enforced: true,
  notice: "read_only",
  plan: { slug: "pilot-2026", name: "Pilot nội bộ 2026" },
  last_day: "2026-12-31",
  contact: "it@astralx.com.vn",
};
const REFUSAL = {
  ok: false,
  error: "AgentX WebMate is read-only for this account, so it cannot run this task.",
  status: 403,
  code: "license_read_only",
  license: LICENSE,
};

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

test("refusalFrom keeps the codes the extension may send, and nothing else", () => {
  assert.deepEqual([...EXTENSION_REFUSAL_CODES], ["license_read_only"]);
  assert.deepEqual(refusalFrom(REFUSAL), { code: "license_read_only", license: LICENSE });
  assert.deepEqual(refusalFrom({ code: "license_read_only" }), { code: "license_read_only" });
  assert.deepEqual(refusalFrom({ code: "license_read_only", license: ["x"] }), { code: "license_read_only" });
  for (const frame of [null, "license_read_only", {}, { code: "WEBMATE_NOT_SIGNED_IN" }, { code: "anything_else", license: LICENSE }]) {
    assert.equal(refusalFrom(frame), undefined, JSON.stringify(frame));
  }
});

test("a refusal survives the peer socket, and an older peer's error still reads", () => {
  const error = new BridgeError(REFUSAL.error, 403, undefined, undefined, refusalFrom(REFUSAL));
  const wire = JSON.parse(JSON.stringify(errorToWire(error)));
  assert.deepEqual(wire.refusal, { code: "license_read_only", license: LICENSE });
  const back = errorFromWire(wire);
  assert.ok(back instanceof BridgeError);
  assert.equal(back.status, 403);
  assert.equal(back.message, REFUSAL.error);
  assert.deepEqual(back.refusal, { code: "license_read_only", license: LICENSE });

  // A 1.3.0 owner sends no `refusal`: the error is what it always was.
  const legacy = errorFromWire({ message: "Forbidden", status: 403 });
  assert.equal(legacy.refusal, undefined);
  assert.equal(legacy.status, 403);
  // And a forged code is not believed.
  assert.equal(errorFromWire({ message: "x", refusal: { code: "root" } }).refusal, undefined);
});

test("webmate_run reports license_read_only with the license as structured content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "webmate-refusal-"));
  const port = await freePort();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: packageDir,
    // No pairing.json in this WEBMATE_DIR: the unpaired v2 hello below is accepted.
    env: {
      ...process.env,
      WEBMATE_DIR: dir,
      WEBMATE_BRIDGE_PORT: String(port),
      WEBMATE_CONNECT_GRACE_MS: "5000",
      WEBMATE_HEARTBEAT_INTERVAL_MS: "0",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "refusal-test", version: "1.0.0" });
  let socket;
  try {
    await client.connect(transport);
    const runs = [];
    socket = await new Promise((resolve, reject) => {
      const attempt = (left) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`);
        ws.on("open", () => {
          ws.send(JSON.stringify({ type: "hello", client: "webbrain-extension", protocolVersion: 2, status: {} }));
          resolve(ws);
        });
        ws.on("message", (raw) => {
          const msg = JSON.parse(raw.toString());
          if (!msg.action) return;
          if (msg.action === "cloud_run") {
            runs.push(msg.payload);
            ws.send(JSON.stringify({ id: msg.id, ...REFUSAL }));
            return;
          }
          ws.send(JSON.stringify({ id: msg.id, ok: false, error: `unexpected ${msg.action}`, status: 500 }));
        });
        ws.on("error", (error) => {
          if (left > 0) setTimeout(() => attempt(left - 1), 100);
          else reject(error);
        });
      };
      attempt(50);
    });

    const result = await client.callTool({ name: tool("run"), arguments: { task: "open the report", mode: "act" } });
    assert.equal(runs.length, 1, "the run reached the extension");
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, `license_read_only: ${REFUSAL.error}`);
    assert.deepEqual(result.structuredContent, {
      code: "license_read_only",
      message: REFUSAL.error,
      license: LICENSE,
    });
  } finally {
    socket?.terminate();
    await client.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
