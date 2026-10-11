import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  createAgentXCloudService,
  AGENTX_SESSION_STORAGE_KEY,
} from "../brand/additions/common/src/agentx/cloud-service.js";
import { webcrypto } from "node:crypto";
import { createUsageReporter } from "../brand/additions/common/src/agentx/telemetry.js";
let session = {
  user: { subject: "alice" },
  accessToken: "synthetic-access",
  issuer: "https://sso.example/auth/realms/test",
};
const api = {
  runtime: {
    getPlatformInfo: async () => ({ os: "win" }),
    getManifest: () => ({ version: "1.0.10" }),
  },
};
let calls = [];
const reporter = createUsageReporter({
  cloud: {
    readSession: async () => session,
    telemetrySession: async () => session,
  },
  api,
  userAgent: "Chrome/1 Edg/1",
  fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return new Response("", { status: 202 });
  },
  now: () => 50,
  uuid: () => "00000000-0000-4000-8000-000000000001",
});
reporter.begin(1, "act");
assert.equal(await reporter.end(1, "done"), true);
assert.equal(await reporter.end(1, "done"), false);
assert.equal(calls.length, 1);
let event = JSON.parse(calls[0].init.body).events[0];
assert.equal(event.product, "agentx-webmate");
assert.equal(event.os, "Windows");
assert.equal(event.browser, "Edge");
assert.equal(event.feature, "agent.run");
assert.equal(calls[0].init.credentials, "omit");
assert.equal(calls[0].init.headers.Authorization, "Bearer synthetic-access");
reporter.begin(2, "ask");
await Promise.resolve();
await Promise.resolve();
session = { ...session, user: { subject: "bob" } };
assert.equal(await reporter.end(2, "error"), false);
reporter.begin(3, "act");
assert.equal(await reporter.end(3, "cancelled"), false);
assert.equal(calls.length, 1);
let elapsed = 0;
const plan = createUsageReporter({
  cloud: { telemetrySession: async () => session },
  api,
  now: () => elapsed,
  fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return new Response("", { status: 202 });
  },
});
plan.begin(8, "plan");
elapsed = 400;
plan.begin(8, "act");
elapsed = 800;
assert.equal(await plan.end(8, "plan_only_output"), true);
const planned = JSON.parse(calls.at(-1).init.body).events[0];
assert.equal(planned.feature, "agent.plan");
assert.equal(planned.outcome, "success");
assert.equal(planned.duration_ms, 800);
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    assert.equal(req.headers.authorization, "Bearer synthetic-access");
    assert.equal(JSON.parse(body).events[0].error_code, "operation_failed");
    res.writeHead(202);
    res.end("{}");
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  session = {
    ...session,
    issuer: `http://127.0.0.1:${server.address().port}/auth/realms/test`,
  };
  const live = createUsageReporter({
    cloud: {
      readSession: async () => session,
      telemetrySession: async () => session,
    },
    api,
  });
  live.begin(4, "act");
  assert.equal(await live.end(4, "error"), true);
} finally {
  await new Promise((resolve) => server.close(resolve));
}
console.log(
  "WebMate telemetry: lifecycle, account isolation, real HTTP, bearer and metadata passed",
);

let consent = false;
const firefox = createUsageReporter({
  cloud: { telemetrySession: async () => session },
  api: {
    runtime: {
      ...api.runtime,
      getManifest: () => ({
        version: "1.0.11",
        browser_specific_settings: { gecko: {} },
      }),
    },
    permissions: {
      getAll: async () => ({
        data_collection: consent ? ["technicalAndInteraction"] : [],
      }),
    },
  },
  fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return new Response("", { status: 202 });
  },
});
const before = calls.length;
firefox.begin(20, "ask");
assert.equal(await firefox.end(20, "done"), false);
assert.equal(calls.length, before);
consent = true;
firefox.begin(21, "ask");
assert.equal(await firefox.end(21, "done"), true);
assert.equal(calls.length, before + 1);
let persisted = {
  ...session,
  idToken: "synthetic-id",
  expiresAt: 5000,
  lastActiveAt: 1000,
};
let writes = 0;
const auth = createAgentXCloudService({
  api: {
    runtime: {},
    tabs: {},
    storage: {
      local: {
        get: async () => ({ [AGENTX_SESSION_STORAGE_KEY]: persisted }),
        set: async () => {
          writes++;
        },
      },
    },
  },
  now: () => 1000,
  cryptoImpl: webcrypto,
  fetchImpl: async () => {
    throw new Error("telemetry must not refresh");
  },
});
assert.equal((await auth.telemetrySession()).user.subject, "bob");
persisted = undefined;
assert.equal(await auth.telemetrySession(), null);
persisted = {
  ...session,
  idToken: "synthetic-id",
  expiresAt: 900,
  lastActiveAt: 1000,
};
assert.equal(await auth.telemetrySession(), null);
assert.equal(writes, 0);
console.log(
  "WebMate telemetry: Firefox consent and fresh non-mutating session reads passed",
);
