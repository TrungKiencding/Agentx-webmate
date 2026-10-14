import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  createAgentXCloudService,
  AGENTX_SESSION_STORAGE_KEY,
} from "../brand-dist/chrome/src/agentx/cloud-service.js";
import { webcrypto } from "node:crypto";
import {
  createUsageReporter,
  errorCode,
  statusCode,
} from "../brand/additions/common/src/agentx/telemetry.js";
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
plan.begin(8, "act");
elapsed = 400;
plan.begin(8, "act"); // already open: the first begin keeps the clock
elapsed = 800;
assert.equal(await plan.end(8, "plan_only_output"), true);
const planned = JSON.parse(calls.at(-1).init.body).events[0];
assert.equal(planned.feature, "agent.run");
assert.equal(planned.outcome, "success");
assert.equal(planned.duration_ms, 800);
plan.begin(9, "dev"); // dev is an action mode too
assert.equal(await plan.end(9, "done"), true);
assert.equal(JSON.parse(calls.at(-1).init.body).events[0].feature, "agent.run");
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

// What a turn ended with, in the words AgentX Chat and Workmate use.
for (const status of [
  "done",
  "plan_only_output",
  "clarify",
  "clarification_required",
  "captcha_manual_required",
  "read_scope_limited",
  "active_recipient_unverified",
]) {
  assert.equal(statusCode(status), null, `${status} is not a failure`);
}
assert.equal(statusCode("cancelled"), null);
assert.equal(statusCode("max_steps"), "max_steps");
assert.equal(statusCode("loop_stopped"), "loop_stopped");
assert.equal(statusCode("cost_limit"), "cost_limit");
assert.equal(statusCode("empty_output"), "empty_response");
assert.equal(statusCode("placeholder_output"), "empty_response");
assert.equal(statusCode("delivery_required"), "observation_limit");
assert.equal(statusCode("error"), "operation_failed");
assert.equal(statusCode("error", "rate_limited"), "rate_limited");
assert.equal(statusCode("max_steps", "upstream_error"), "max_steps"); // not the error a retry got past
assert.equal(statusCode("not a status!"), "operation_failed");
const failure = (fields) => Object.assign(new Error("private detail"), fields);
assert.equal(errorCode(failure({ status: 429 }), "RATE_LIMIT"), "rate_limited");
assert.equal(errorCode(failure({}), "QUOTA"), "quota_exceeded");
assert.equal(errorCode(failure({}), "INVALID_CREDENTIAL"), "auth_failed");
assert.equal(errorCode(failure({}), "CONTEXT_WINDOW_EXCEEDED"), "context_too_long");
assert.equal(errorCode(failure({}), "COST_LIMIT"), "cost_limit");
assert.equal(errorCode(failure({ status: 502 }), "TRANSPORT"), "upstream_error");
assert.equal(errorCode(failure({ status: 404 }), "TRANSPORT"), "model_unavailable");
assert.equal(errorCode(failure({ name: "TimeoutError" }), "TRANSPORT"), "timeout");
assert.equal(errorCode(new TypeError("Failed to fetch"), "TRANSPORT"), "network_error");
assert.equal(errorCode(failure({}), "TRANSPORT"), "operation_failed");
assert.equal(
  errorCode(failure({ code: "license_read_only", license: { state: "expired" } })),
  "license_expired",
);
assert.equal(
  errorCode(failure({ code: "license_read_only", license: { state: "none" } })),
  "license_required",
);
assert.equal(errorCode(failure({ code: "access_blocked", status: 403 })), "access_blocked");

const coded = [];
const codes = createUsageReporter({
  cloud: { telemetrySession: async () => session },
  api,
  fetchImpl: async (url, init) => {
    coded.push(JSON.parse(init.body).events[0]);
    return new Response("", { status: 202 });
  },
});
codes.begin(40, "ask");
codes.failure(40, failure({ status: 500 }), "TRANSPORT");
codes.failure(40, failure({ status: 429 }), "RATE_LIMIT"); // the error that ended the turn names it
assert.equal(await codes.end(40, "error"), true);
codes.begin(41, "act");
codes.failure(41, failure({ status: 502 }), "TRANSPORT"); // retried, then the run ran out of steps
assert.equal(await codes.end(41, "max_steps"), true);
codes.begin(42, "ask");
assert.equal(await codes.end(42, "clarification_required"), true);
// Refused before the run started (read-only license): counted, with why.
assert.equal(
  await codes.refused(failure({ code: "license_read_only", license: { state: "revoked" } })),
  true,
);
assert.deepEqual(
  coded.map((event) => [event.feature, event.outcome, event.error_code ?? null]),
  [
    ["chat.turn", "failure", "rate_limited"],
    ["agent.run", "failure", "max_steps"],
    ["chat.turn", "success", null],
    ["chat.turn", "failure", "license_revoked"],
  ],
);
console.log("WebMate telemetry: outcomes and error codes in the shared words passed");

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

// Every completed turn reaches the reporter, chat included. The hook used to
// sit in _startTraceRun, which an ask-mode turn never calls when it streams,
// so ordinary side-panel chats were never reported.
for (const name of ["DOMMatrix", "ImageData", "Path2D"]) {
  globalThis[name] = globalThis[name] || class {};
}
for (const target of ["chrome", "firefox"]) {
  const { Agent } = await import(`../brand-dist/${target}/src/agent/agent.js`);
  for (const streaming of [false, true]) {
    const provider = {
      supportsTools: true,
      supportsVision: false,
      promptTier: "full",
      contextWindow: 128000,
      model: "test-model",
      name: "test-provider",
      chat: async () => ({ content: "ok", toolCalls: [] }),
      async *chatStream() {
        yield { type: "text", content: "ok" };
        yield { type: "done" };
      },
    };
    const agent = new Agent({ getActive: () => provider, getVisionProvider: async () => null });
    const tabId = streaming ? 31 : 30;
    const seen = [];
    agent.usageReporter = {
      begin: (key, mode) => seen.push(["begin", key, mode]),
      failure: (key, error, traceCode) => seen.push(["failure", key, traceCode]),
      end: async (key, status) => {
        seen.push(["end", key, status]);
        return true;
      },
    };
    agent.planBeforeAct = false;
    agent.maxSteps = 3;
    agent._permissionMode = "bypass";
    agent._hydrate = async () => {};
    agent._manageContext = async () => {};
    agent._enrichUserMessageWithCurrentPage = async (_tabId, _messages, content) => ({ role: "user", content });
    agent._maybeReinjectAdapter = async () => {};
    agent._ensureProgressSessionForCurrentTask = async () => ({ mode: "inactive" });
    agent._persist = () => {};
    agent._persistNow = async () => true;
    // The trace store needs the browser; the reporter must not depend on it.
    agent._startTraceRun = async () => null;
    agent.conversationModes.set(tabId, "ask");
    agent.conversations.set(tabId, [{ role: "system", content: "sys" }]);
    const turn = streaming
      ? agent.processMessageStream(tabId, "Hello", () => {}, "ask")
      : agent.processMessage(tabId, "Hello", () => {}, "ask");
    await turn;
    const label = `${target} ${streaming ? "streaming" : "non-streaming"} ask turn`;
    assert.deepEqual(seen, [["begin", tabId, "ask"], ["end", tabId, "done"]], label);
  }
}
console.log("WebMate telemetry: ask-mode turns report, streaming and not, Chrome and Firefox builds passed");

// A turn that throws tells the reporter which error ended it, before its end.
for (const target of ["chrome", "firefox"]) {
  const { Agent } = await import(`../brand-dist/${target}/src/agent/agent.js`);
  for (const streaming of [false, true]) {
    const refusal = Object.assign(new Error("Too many requests"), { status: 429 });
    const provider = {
      supportsTools: true,
      supportsVision: false,
      promptTier: "full",
      contextWindow: 128000,
      model: "test-model",
      name: "test-provider",
      chat: async () => {
        throw refusal;
      },
      // eslint-disable-next-line require-yield
      async *chatStream() {
        throw refusal;
      },
    };
    const agent = new Agent({ getActive: () => provider, getVisionProvider: async () => null });
    const tabId = streaming ? 33 : 32;
    const seen = [];
    agent.usageReporter = {
      begin: (key, mode) => seen.push(["begin", key, mode]),
      failure: (key, error, traceCode) => seen.push(["failure", key, traceCode, error === refusal]),
      end: async (key, status) => {
        seen.push(["end", key, status]);
        return true;
      },
    };
    agent.planBeforeAct = false;
    agent.maxSteps = 3;
    agent._permissionMode = "bypass";
    agent._hydrate = async () => {};
    agent._manageContext = async () => {};
    agent._enrichUserMessageWithCurrentPage = async (_tabId, _messages, content) => ({ role: "user", content });
    agent._maybeReinjectAdapter = async () => {};
    agent._ensureProgressSessionForCurrentTask = async () => ({ mode: "inactive" });
    agent._persist = () => {};
    agent._persistNow = async () => true;
    agent._startTraceRun = async () => null;
    agent.conversationModes.set(tabId, "ask");
    agent.conversations.set(tabId, [{ role: "system", content: "sys" }]);
    const turn = streaming
      ? agent.processMessageStream(tabId, "Hello", () => {}, "ask")
      : agent.processMessage(tabId, "Hello", () => {}, "ask");
    await turn.catch(() => {});
    const label = `${target} ${streaming ? "streaming" : "non-streaming"} failed ask turn`;
    assert.deepEqual(
      seen,
      [["begin", tabId, "ask"], ["failure", tabId, "RATE_LIMIT", true], ["end", tabId, "error"]],
      label,
    );
  }
}
console.log("WebMate telemetry: a failed turn reports its error, streaming and not, Chrome and Firefox builds passed");
