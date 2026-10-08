import { strict as assert } from 'node:assert';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME_ROOT = path.join(ROOT, 'brand-dist/chrome');
const SERVICE_PATH = path.join(CHROME_ROOT, 'src/agentx/cloud-service.js');
const CONTROLLER_PATH = path.join(CHROME_ROOT, 'src/ui/agentx-cloud-settings.js');
const UI_PATH = path.join(CHROME_ROOT, 'src/ui/agentx-cloud-ui.js');
const GATE_PATH = path.join(CHROME_ROOT, 'src/ui/agentx-login-gate.js');
const WORKMATE_AUTH_PATH = path.join(CHROME_ROOT, 'src/agentx/workmate-auth.js');
const OPENAI_PROVIDER_PATH = path.join(CHROME_ROOT, 'src/providers/openai.js');
const TRANSCRIBE_PATH = path.join(CHROME_ROOT, 'src/agent/transcribe.js');
const MODELS_PATH = path.join(CHROME_ROOT, 'src/agentx/cloud-models.js');
const LICENSE_PATH = path.join(CHROME_ROOT, 'src/agentx/license.js');
const LICENSE_COPY_PATH = path.join(CHROME_ROOT, 'src/ui/agentx-license-copy.js');
const LICENSE_RUN_GATE_PATH = path.join(CHROME_ROOT, 'src/agentx/license-run-gate.js');

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const {
  AGENTX_CREDENTIAL_STORAGE_KEY,
  AGENTX_DEVICE_STORAGE_KEY,
  AGENTX_LICENSE_STORAGE_KEY,
  AGENTX_SESSION_STORAGE_KEY,
  LICENSE_CHECK_INTERVAL_MS,
  createAgentXCloudService,
  normalizeHttpsBaseUrl,
} = await import(pathToFileURL(SERVICE_PATH).href);
const {
  LICENSE_READ_ONLY_CODE,
  expiringNoticeKey,
  licenseFromRefusal,
  licenseRefusalMessage,
  normalizeLicense,
} = await import(pathToFileURL(LICENSE_PATH).href);
const {
  formatLicenseDay,
  licenseNoticeSentence,
  licenseReadOnlySentence,
  licenseReinstateSentence,
  licenseStateLabel,
} = await import(pathToFileURL(LICENSE_COPY_PATH).href);
const { createAgentXLicenseRunGate } = await import(pathToFileURL(LICENSE_RUN_GATE_PATH).href);
const { createAgentXCloudSettingsController } = await import(pathToFileURL(CONTROLLER_PATH).href);
const { createAgentXLoginGate } = await import(pathToFileURL(GATE_PATH).href);
const { createWorkmateAuth, LOGIN_REQUIRED_HOLDOFF_MS } = await import(pathToFileURL(WORKMATE_AUTH_PATH).href);
const { renderAgentXCloudPanel } = await import(pathToFileURL(UI_PATH).href);
const { OpenAICompatibleProvider } = await import(pathToFileURL(OPENAI_PROVIDER_PATH).href);
const { transcribeAudio } = await import(pathToFileURL(TRANSCRIBE_PATH).href);
const {
  resolveCloudVisionSidecar,
  visionModelsFromGateway,
} = await import(pathToFileURL(MODELS_PATH).href);

const ISSUER = 'https://identity.example.test/realms/agentx';
const CLIENT_ID = 'agentx-workmate';
const TOKEN_ENDPOINT = `${ISSUER}/protocol/openid-connect/token`;
const CONFIG = Object.freeze({
  secondBrainBaseUrl: 'https://agentx.astralx.com.vn/keys',
  litellmBaseUrl: 'https://aigw.dev-server.cloud/v1',
  oidcIssuer: ISSUER,
  oidcClientId: CLIENT_ID,
  oidcScopes: 'openid profile email',
  oidcProvidersPath: '/api/auth/providers',
  oidcRedirectUris: ['http://127.0.0.1:47821/callback'],
  requestTimeoutMs: 250,
  authTimeoutMs: 1_000,
});
const NOW = 1_800_000_000_000;
// Short enough to step over inside a test, long enough that the service's
// once-a-minute activity write throttle still behaves as it does in the panel.
const IDLE_MS = 30 * 60_000;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function jwt(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}.signature`;
}

function session(overrides = {}) {
  return {
    idToken: jwt({
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: 'user-123',
      email: 'kien@example.test',
      name: 'Kien',
      exp: Math.floor((NOW + 10 * 60_000) / 1000),
    }),
    refreshToken: 'refresh-1',
    expiresAt: NOW + 10 * 60_000,
    issuer: ISSUER,
    clientId: CLIENT_ID,
    tokenEndpoint: TOKEN_ENDPOINT,
    endSessionEndpoint: `${ISSUER}/logout`,
    revocationEndpoint: `${ISSUER}/revoke`,
    redirectUri: CONFIG.oidcRedirectUris[0],
    user: {
      subject: 'user-123',
      email: 'kien@example.test',
      displayName: 'Kien',
    },
    obtainedAt: NOW,
    ...overrides,
  };
}

function credential(overrides = {}) {
  return {
    subject: 'user-123',
    authority: CONFIG.secondBrainBaseUrl,
    key: 'sk-existing-secret',
    baseUrl: CONFIG.litellmBaseUrl,
    models: ['model-a'],
    model: 'model-a',
    keyAlias: 'agentx-kien',
    keyToken: 'key-handle',
    account: 'kien',
    status: 'reused',
    cachedAt: NOW,
    provisionOutcome: 'reused',
    warningCode: '',
    ...overrides,
  };
}

function createEvent() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    emit(...args) {
      for (const listener of [...listeners]) listener(...args);
    },
  };
}

function createApi(seed = {}, { onTabCreated } = {}) {
  const values = structuredClone(seed);
  const onUpdated = createEvent();
  const onRemoved = createEvent();
  const onChanged = createEvent();
  let nextTabId = 40;
  return {
    values,
    storageChanged: onChanged,
    api: {
      storage: {
        onChanged,
        local: {
          async get(keys) {
            const names = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(names.filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key]]));
          },
          async set(patch) {
            Object.assign(values, structuredClone(patch));
          },
          async remove(keys) {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
          },
        },
      },
      runtime: {
        async getPlatformInfo() {
          return { os: 'mac' };
        },
      },
      tabs: {
        onUpdated,
        onRemoved,
        async create(details) {
          const tab = { id: nextTabId++, ...details };
          setTimeout(() => onTabCreated?.(tab, { onUpdated, onRemoved }), 0);
          return tab;
        },
        async remove() {},
      },
    },
  };
}

function service(api, fetchImpl) {
  return createAgentXCloudService({
    api,
    config: CONFIG,
    fetchImpl,
    cryptoImpl: webcrypto,
    now: () => NOW,
  });
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('runtime URLs are normalized and reject unsafe credentials', () => {
  assert.equal(
    normalizeHttpsBaseUrl('https://aigw.dev-server.cloud/', 'gateway', { openAiCompatible: true }),
    'https://aigw.dev-server.cloud/v1',
  );
  assert.throws(
    () => normalizeHttpsBaseUrl('https://user:secret@example.test', 'gateway'),
    /HTTPS/,
  );
});

test('signed-out UI surfaces structured discovery errors and busy labels', () => {
  const errorMarkup = renderAgentXCloudPanel({
    signedIn: false,
    error: {
      code: 'oidc_discovery_failed',
      message: 'Dịch vụ trả HTTP 404.',
    },
  }, 'vi');
  assert.match(errorMarkup, /Không kết nối được Cloud/);
  assert.match(errorMarkup, /HTTP 404/);

  const busyMarkup = renderAgentXCloudPanel({
    signedIn: false,
    action: 'signing-in',
  }, 'en');
  assert.match(busyMarkup, /Opening secure sign-in/);
});

test('AgentX provider sends only model-key bearer authentication', () => {
  const provider = Object.create(OpenAICompatibleProvider.prototype);
  provider.config = {
    providerName: 'agentx-cloud',
    apiKey: 'sk-model-key',
    agentxCloudManaged: true,
  };
  const headers = provider._headers();
  assert.equal(headers.Authorization, 'Bearer sk-model-key');
  assert.equal(headers['X-WebBrain-Device-Id'], undefined);
  assert.equal(headers['X-WebBrain-Client'], undefined);
});

test('AgentX provider refuses missing or non-gateway models', () => {
  const provider = Object.create(OpenAICompatibleProvider.prototype);
  provider.config = {
    providerName: 'agentx-cloud',
    apiKey: 'sk-model-key',
    agentxCloudManaged: true,
    models: ['gateway-model-a', 'gateway-model-b'],
    model: 'gateway-model-b',
    extraBody: { model: 'hard-coded-external-model' },
  };

  assert.equal(provider.model, 'gateway-model-b');
  assert.equal(provider._buildChatCompletionsBody([], {}).model, 'gateway-model-b');

  provider.config.model = 'hard-coded-external-model';
  assert.throws(() => provider.model, /not available through this gateway key/);
  provider.config.model = '';
  assert.throws(() => provider.model, /requires an active model selected from the gateway/);
});

test('AgentX transcription refuses a model outside the gateway allowlist', async () => {
  const providers = new Map([[
    'webbrain_cloud',
    {
      config: {
        type: 'openai',
        providerName: 'agentx-cloud',
        baseUrl: CONFIG.litellmBaseUrl,
        apiKey: 'sk-model-key',
      },
    },
  ]]);
  const result = await transcribeAudio(providers, new Blob(['audio'], { type: 'audio/webm' }), {
    providerId: 'webbrain_cloud',
    modelOverride: 'whisper-1',
    allowedModels: ['gateway-model-a'],
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /blocked/);
});

test('authorization code + PKCE uses ID token and provisions the configured gateway', async () => {
  let authUrl;
  let modelRequest;
  let tokenRequest;
  let providersRequested = false;
  const fake = createApi({}, {
    onTabCreated(tab, events) {
      authUrl = new URL(tab.url);
      const callback = new URL(CONFIG.oidcRedirectUris[0]);
      callback.searchParams.set('code', 'authorization-code');
      callback.searchParams.set('state', authUrl.searchParams.get('state'));
      events.onUpdated.emit(tab.id, { url: callback.toString() });
    },
  });
  const fetchImpl = async (url, init = {}) => {
    const requestUrl = String(url);
    if (requestUrl === `${CONFIG.secondBrainBaseUrl}/api/auth/providers`) {
      providersRequested = true;
      return jsonResponse({
        providers: [{
          name: 'keycloak',
          supports_native_oidc: true,
          native_oidc: {
            issuer: ISSUER,
            client_id: CLIENT_ID,
            scopes: 'openid profile email',
            confidential: false,
          },
        }],
      });
    }
    if (requestUrl === `${ISSUER}/.well-known/openid-configuration`) {
      return jsonResponse({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: TOKEN_ENDPOINT,
        end_session_endpoint: `${ISSUER}/logout`,
        revocation_endpoint: `${ISSUER}/revoke`,
      });
    }
    if (requestUrl === TOKEN_ENDPOINT) {
      tokenRequest = init;
      return jsonResponse({
        id_token: jwt({
          iss: ISSUER,
          aud: CLIENT_ID,
          sub: 'user-123',
          email: 'kien@example.test',
          name: 'Kien',
          nonce: authUrl.searchParams.get('nonce'),
          exp: Math.floor((NOW + 10 * 60_000) / 1000),
        }),
        access_token: 'must-not-be-used',
        refresh_token: 'refresh-1',
      });
    }
    if (requestUrl === `${CONFIG.secondBrainBaseUrl}/v1/model-key`) {
      modelRequest = init;
      return jsonResponse({
        key: 'sk-new-secret',
        key_alias: 'agentx-kien',
        token: 'handle-1',
        base_url: 'https://aigw.dev-server.cloud/',
        models: ['model-a', 'model-b'],
        default_model: 'model-a',
        status: 'issued',
        account: 'kien',
      });
    }
    if (requestUrl === `${CONFIG.litellmBaseUrl}/models`) {
      return jsonResponse({ data: [{ id: 'model-a' }, { id: 'model-b' }] });
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  };

  const result = await service(fake.api, fetchImpl).signInAndProvision();
  const tokenForm = new URLSearchParams(tokenRequest.body);
  assert.equal(tokenForm.get('grant_type'), 'authorization_code');
  assert.equal(tokenForm.get('client_secret'), null);
  assert.ok(tokenForm.get('code_verifier'));
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authUrl.searchParams.get('client_id'), CONFIG.oidcClientId);
  assert.equal(providersRequested, false);
  assert.equal(modelRequest.headers.Authorization, `Bearer ${result.session.idToken}`);
  assert.notEqual(modelRequest.headers.Authorization, 'Bearer must-not-be-used');
  assert.deepEqual(JSON.parse(modelRequest.body), { rotate: false });
  assert.match(modelRequest.headers['X-AgentX-Device'], /^[0-9a-f-]{36}$/);
  assert.equal(result.credential.baseUrl, CONFIG.litellmBaseUrl);
  assert.equal(result.credential.model, 'model-a');
  assert.equal(fake.values[AGENTX_SESSION_STORAGE_KEY].user.email, 'kien@example.test');
  assert.equal(fake.values[AGENTX_DEVICE_STORAGE_KEY].id, modelRequest.headers['X-AgentX-Device']);
});

/** The OIDC + gateway fetches every sign-in test needs, with hooks for the token and model-key requests. */
function ssoFetch({ onAuthorize, onToken, onModelKey } = {}) {
  return async (url, init = {}) => {
    const requestUrl = String(url);
    if (requestUrl === `${ISSUER}/.well-known/openid-configuration`) {
      return jsonResponse({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: TOKEN_ENDPOINT,
        end_session_endpoint: `${ISSUER}/logout`,
        revocation_endpoint: `${ISSUER}/revoke`,
      });
    }
    if (requestUrl === TOKEN_ENDPOINT) {
      onToken?.(init);
      const form = new URLSearchParams(init.body);
      return jsonResponse({
        id_token: jwt({
          iss: ISSUER,
          aud: CLIENT_ID,
          sub: 'user-123',
          email: 'kien@example.test',
          name: 'Kien',
          nonce: onAuthorize?.().searchParams.get('nonce'),
          exp: Math.floor((NOW + 10 * 60_000) / 1000),
        }),
        refresh_token: `refresh-for-${form.get('code')}`,
      });
    }
    if (requestUrl === `${CONFIG.secondBrainBaseUrl}/v1/model-key`) {
      onModelKey?.(init);
      return jsonResponse({
        key: 'sk-silent-secret',
        key_alias: 'agentx-kien',
        token: 'handle-1',
        base_url: CONFIG.litellmBaseUrl,
        models: ['model-a'],
        default_model: 'model-a',
        status: 'issued',
        account: 'kien',
      });
    }
    if (requestUrl === `${CONFIG.litellmBaseUrl}/models`) {
      return jsonResponse({ data: [{ id: 'model-a' }] });
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  };
}

/** chrome.identity as the silent flow sees it: records the authorize URL, answers with a redirect URL or Chrome's error. */
function fakeIdentity({ respond }) {
  const calls = [];
  return {
    calls,
    identity: {
      getRedirectURL: () => 'https://pfadeibckkgklmmjghiikadphihbpape.chromiumapp.org/',
      launchWebAuthFlow(details) {
        calls.push(details);
        return Promise.resolve().then(() => respond(new URL(details.url), details));
      },
    },
  };
}

test('silent sign-in runs prompt=none through chrome.identity and provisions like the interactive flow', async () => {
  let authUrl = null;
  const { calls, identity } = fakeIdentity({
    respond(url) {
      authUrl = url;
      const callback = new URL('https://pfadeibckkgklmmjghiikadphihbpape.chromiumapp.org/');
      callback.searchParams.set('code', 'silent-code');
      callback.searchParams.set('state', url.searchParams.get('state'));
      return callback.toString();
    },
  });
  const fake = createApi({});
  fake.api.identity = identity;
  fake.api.runtime.id = 'pfadeibckkgklmmjghiikadphihbpape';
  let tokenRequest;
  const fetchImpl = ssoFetch({ onAuthorize: () => authUrl, onToken: (init) => { tokenRequest = init; } });

  const result = await service(fake.api, fetchImpl).silentSignInAndProvision({ loginHint: 'kien@example.test' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].interactive, false, 'the silent flow must never pop a window');
  assert.equal(authUrl.searchParams.get('prompt'), 'none');
  assert.equal(authUrl.searchParams.get('login_hint'), 'kien@example.test');
  assert.equal(authUrl.searchParams.get('redirect_uri'), 'https://pfadeibckkgklmmjghiikadphihbpape.chromiumapp.org/');
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  const tokenForm = new URLSearchParams(tokenRequest.body);
  assert.equal(tokenForm.get('code'), 'silent-code');
  assert.equal(tokenForm.get('redirect_uri'), 'https://pfadeibckkgklmmjghiikadphihbpape.chromiumapp.org/');
  assert.ok(tokenForm.get('code_verifier'));
  assert.equal(result.session.user.email, 'kien@example.test');
  assert.equal(result.credential.key, 'sk-silent-secret');
  assert.equal(fake.values[AGENTX_SESSION_STORAGE_KEY].user.email, 'kien@example.test', 'the session is persisted for the panel to find');
});

test('silent sign-in reports login_required when the browser holds no session, and never exchanges a code', async () => {
  let tokenRequested = false;
  const fetchImpl = ssoFetch({ onToken: () => { tokenRequested = true; } });

  // Keycloak's own answer to prompt=none without a session.
  const keycloakSaysNo = fakeIdentity({
    respond(url) {
      const callback = new URL('https://pfadeibckkgklmmjghiikadphihbpape.chromiumapp.org/');
      callback.searchParams.set('error', 'login_required');
      callback.searchParams.set('state', url.searchParams.get('state'));
      return callback.toString();
    },
  });
  let fake = createApi({});
  fake.api.identity = keycloakSaysNo.identity;
  await assert.rejects(
    () => service(fake.api, fetchImpl).silentSignIn({ loginHint: 'kien@example.test' }),
    (error) => error.code === 'login_required',
  );

  // Chrome's own refusal in non-interactive mode.
  const chromeSaysNo = fakeIdentity({ respond() { throw new Error('User interaction required.'); } });
  fake = createApi({});
  fake.api.identity = chromeSaysNo.identity;
  await assert.rejects(
    () => service(fake.api, fetchImpl).silentSignIn(),
    (error) => error.code === 'login_required',
  );

  // A redirect whose state is not ours is dropped before anything else is read.
  const forged = fakeIdentity({
    respond() {
      return 'https://pfadeibckkgklmmjghiikadphihbpape.chromiumapp.org/?code=stolen&state=attacker';
    },
  });
  fake = createApi({});
  fake.api.identity = forged.identity;
  await assert.rejects(
    () => service(fake.api, fetchImpl).silentSignIn(),
    (error) => error.code === 'state_mismatch',
  );

  // No chrome.identity at all (Firefox build, an old Chrome): a distinct code, not a crash.
  fake = createApi({});
  await assert.rejects(
    () => service(fake.api, fetchImpl).silentSignIn(),
    (error) => error.code === 'identity_unavailable_api',
  );

  assert.equal(tokenRequested, false);
});

test('the interactive sign-in carries a login_hint when Workmate asks for one', async () => {
  let authUrl;
  const fake = createApi({}, {
    onTabCreated(tab, events) {
      authUrl = new URL(tab.url);
      const callback = new URL(CONFIG.oidcRedirectUris[0]);
      callback.searchParams.set('code', 'authorization-code');
      callback.searchParams.set('state', authUrl.searchParams.get('state'));
      events.onUpdated.emit(tab.id, { url: callback.toString() });
    },
  });
  await service(fake.api, ssoFetch({ onAuthorize: () => authUrl })).signIn({ loginHint: 'kien@example.test' });
  assert.equal(authUrl.searchParams.get('login_hint'), 'kien@example.test');
  assert.equal(authUrl.searchParams.get('prompt'), null, 'the interactive flow never asks for prompt=none');
});

test('the chat picker is the key service chat list, as far as LiteLLM serves it', async () => {
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session(),
  });
  let gatewayAuthorization = '';
  let modelKeyRequestBody;
  const result = await service(fake.api, async (url, init = {}) => {
    const requestUrl = String(url);
    if (requestUrl === `${CONFIG.secondBrainBaseUrl}/v1/model-key`) {
      modelKeyRequestBody = JSON.parse(init.body);
      return jsonResponse({
        key: 'sk-legacy-key',
        base_url: 'https://aigw.dev-server.cloud',
        models: ['hard-coded-external-model', 'model-secondary'],
        default_model: 'hard-coded-external-model',
        status: 'reused',
      });
    }
    if (requestUrl === `${CONFIG.litellmBaseUrl}/models`) {
      gatewayAuthorization = init.headers.Authorization;
      return jsonResponse({
        data: [
          { id: 'model-primary' },
          { id: 'model-secondary' },
          { id: 'model-primary' },
        ],
      });
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  }).retryProvision();

  assert.deepEqual(modelKeyRequestBody, { rotate: false });
  assert.equal(gatewayAuthorization, 'Bearer sk-legacy-key');
  // LiteLLM decides what is live (no 'hard-coded-external-model'); the key
  // service decides what is for chat ('model-primary' is reachable but was
  // never granted for chat — a feature model, say).
  assert.deepEqual(result.credential.models, ['model-secondary']);
  assert.equal(result.credential.model, 'model-secondary');
  assert.equal(result.credential.models.includes('hard-coded-external-model'), false);
  assert.deepEqual(result.credential.reachableModels, ['model-primary', 'model-secondary']);
  assert.equal(
    fake.values[AGENTX_CREDENTIAL_STORAGE_KEY].records[0].model,
    'model-secondary',
  );
});

const ROLE_KEY_BODY = Object.freeze({
  key: 'sk-role-key',
  base_url: 'https://aigw.dev-server.cloud',
  models: ['MiniMax/MiniMax-M3', 'Qwen/Qwen3.5-122B-A10B-FP8'],
  default_model: 'MiniMax/MiniMax-M3',
  web_search_model: 'perplexity/sonar',
  image_model: 'google/gemini-3.1-flash-lite-image',
  vision_model: 'Qwen/Qwen3.6-35B-A3B-FP8',
  speech_model: 'google/gemini-3.8-flash-lite-tts',
  status: 'reused',
});
// What LiteLLM 1.82.6 lists for that key: the whole allowlist, feature models included.
const ROLE_CATALOG = Object.freeze({
  data: [
    { id: 'Qwen/Qwen3.5-122B-A10B-FP8', mode: 'chat' },
    { id: 'MiniMax/MiniMax-M3', mode: 'chat', supports_vision: true },
    { id: 'google/gemini-3.1-flash-lite-image', mode: 'image_generation' },
    { id: 'perplexity/sonar', mode: 'chat' },
    { id: 'Qwen/Qwen3.6-35B-A3B-FP8', mode: 'chat' },
    // Text-to-speech: its name matches the vision heuristic (`gemini`), so only the
    // key service's speech_model field keeps it out of every picker.
    { id: 'google/gemini-3.8-flash-lite-tts', mode: 'audio_speech' },
  ],
});

function roleFetch({ onKey, catalog = ROLE_CATALOG, keyBody = ROLE_KEY_BODY } = {}) {
  return async (url) => {
    const requestUrl = String(url);
    if (requestUrl === `${CONFIG.secondBrainBaseUrl}/v1/model-key`) {
      onKey?.();
      return jsonResponse(keyBody);
    }
    if (requestUrl === `${CONFIG.litellmBaseUrl}/models`) return jsonResponse(catalog);
    throw new Error(`Unexpected request: ${requestUrl}`);
  };
}

test('feature models never reach the chat picker; the vision model is the key service one', async () => {
  const fake = createApi({ [AGENTX_SESSION_STORAGE_KEY]: session() });
  const result = await service(fake.api, roleFetch()).retryProvision();
  const cred = result.credential;

  assert.deepEqual(cred.models, ['MiniMax/MiniMax-M3', 'Qwen/Qwen3.5-122B-A10B-FP8']);
  assert.equal(cred.model, 'MiniMax/MiniMax-M3');
  for (const feature of [
    'perplexity/sonar',
    'google/gemini-3.1-flash-lite-image',
    'Qwen/Qwen3.6-35B-A3B-FP8',
    'google/gemini-3.8-flash-lite-tts',
  ]) {
    assert.equal(cred.models.includes(feature), false, `${feature} must not be a chat model`);
    assert.equal(cred.transcriptionModels.includes(feature), false, `${feature} must not be offered for transcription`);
  }
  assert.equal(cred.visionModel, 'Qwen/Qwen3.6-35B-A3B-FP8');
  assert.equal(cred.visionModels[0], 'Qwen/Qwen3.6-35B-A3B-FP8');
  assert.equal(cred.visionModels.includes('perplexity/sonar'), false);
  assert.equal(cred.visionModels.includes('google/gemini-3.1-flash-lite-image'), false);
  assert.equal(cred.visionModels.includes('google/gemini-3.8-flash-lite-tts'), false);
  assert.equal(cred.speechModel, 'google/gemini-3.8-flash-lite-tts');
  assert.equal(cred.reachableModels.length, 6);
});

test('a record from an older build asks the key service once for the chat list', async () => {
  const cached = credential({
    key: 'sk-role-key',
    models: ROLE_CATALOG.data.map((m) => m.id),
    model: 'perplexity/sonar',
  });
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session(),
    [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [cached] },
  });
  let keyRequests = 0;
  const cloud = service(fake.api, roleFetch({ onKey: () => { keyRequests += 1; } }));

  const first = await cloud.retryProvision();
  assert.equal(keyRequests, 1);
  assert.deepEqual(first.credential.models, ['MiniMax/MiniMax-M3', 'Qwen/Qwen3.5-122B-A10B-FP8']);
  // A feature model that was the selected chat model gives way to the default.
  assert.equal(first.credential.model, 'MiniMax/MiniMax-M3');

  // The stored record now carries the grant: the next launch only probes LiteLLM.
  const second = await cloud.retryProvision();
  assert.equal(keyRequests, 1);
  assert.deepEqual(second.credential.models, ['MiniMax/MiniMax-M3', 'Qwen/Qwen3.5-122B-A10B-FP8']);
});

test('a key that reaches something new asks for the grant again', async () => {
  const fake = createApi({ [AGENTX_SESSION_STORAGE_KEY]: session() });
  let keyRequests = 0;
  let catalog = { data: ROLE_CATALOG.data.filter((m) => m.id !== 'Qwen/Qwen3.6-35B-A3B-FP8') };
  let keyBody = { ...ROLE_KEY_BODY, vision_model: '' };
  const fetchImpl = async (url) => {
    const requestUrl = String(url);
    if (requestUrl.endsWith('/v1/model-key')) {
      keyRequests += 1;
      return jsonResponse(keyBody);
    }
    return jsonResponse(catalog);
  };
  const cloud = service(fake.api, fetchImpl);
  const first = await cloud.retryProvision();
  assert.equal(first.credential.visionModel, '');
  assert.equal(keyRequests, 1);

  // The operator names a vision model: the key reaches one model more.
  catalog = ROLE_CATALOG;
  keyBody = ROLE_KEY_BODY;
  const second = await cloud.retryProvision();
  assert.equal(keyRequests, 2);
  assert.equal(second.credential.visionModel, 'Qwen/Qwen3.6-35B-A3B-FP8');
  assert.deepEqual(second.credential.models, ['MiniMax/MiniMax-M3', 'Qwen/Qwen3.5-122B-A10B-FP8']);
});

test('a grant refresh that fails keeps the chat list the record already had', async () => {
  const cached = credential({
    key: 'sk-role-key',
    models: ['MiniMax/MiniMax-M3'],
    model: 'MiniMax/MiniMax-M3',
    serviceModels: ['MiniMax/MiniMax-M3'],
    featureModels: ['perplexity/sonar'],
    reachableModels: ['MiniMax/MiniMax-M3', 'perplexity/sonar'],
  });
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session(),
    [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [cached] },
  });
  const result = await service(fake.api, async (url) => {
    if (String(url).endsWith('/v1/model-key')) return jsonResponse({ error: 'down' }, 503);
    return jsonResponse({ data: [{ id: 'MiniMax/MiniMax-M3' }, { id: 'perplexity/sonar' }, { id: 'new-model' }] });
  }).retryProvision();

  assert.deepEqual(result.credential.models, ['MiniMax/MiniMax-M3']);
  assert.equal(result.credential.models.includes('perplexity/sonar'), false);
});

test('callback state is validated before OAuth errors or token exchange', async () => {
  let tokenRequested = false;
  let providersRequested = false;
  const fake = createApi({}, {
    onTabCreated(tab, events) {
      const callback = new URL(CONFIG.oidcRedirectUris[0]);
      callback.searchParams.set('state', 'attacker-state');
      callback.searchParams.set('error', 'access_denied');
      events.onUpdated.emit(tab.id, { url: callback.toString() });
    },
  });
  const fetchImpl = async (url) => {
    if (String(url) === `${CONFIG.secondBrainBaseUrl}/api/auth/providers`) {
      providersRequested = true;
      return jsonResponse({
        providers: [{
          native_oidc: {
            issuer: ISSUER,
            client_id: CLIENT_ID,
            confidential: false,
          },
        }],
      });
    }
    if (String(url) === `${ISSUER}/.well-known/openid-configuration`) {
      return jsonResponse({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: TOKEN_ENDPOINT,
      });
    }
    tokenRequested = true;
    throw new Error('Token endpoint must not be called');
  };
  await assert.rejects(
    () => service(fake.api, fetchImpl).signIn(),
    (error) => error.code === 'state_mismatch',
  );
  assert.equal(tokenRequested, false);
  assert.equal(providersRequested, false);
});

test('cached key is reused after one successful LiteLLM probe', async () => {
  const cached = credential({ serviceModels: ['model-a'], featureModels: [], reachableModels: ['model-a'] });
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session(),
    [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [cached] },
  });
  const requests = [];
  const result = await service(fake.api, async (url) => {
    requests.push(String(url));
    return jsonResponse({ data: [{ id: 'model-a' }] });
  }).retryProvision();
  assert.equal(result.credential.key, cached.key);
  assert.equal(result.credential.provisionOutcome, 'reused-local');
  assert.deepEqual(requests, [`${CONFIG.litellmBaseUrl}/models`]);
});

test('cached model selection is replaced when the gateway no longer exposes it', async () => {
  const cached = credential({
    model: 'removed-model',
    models: ['removed-model', 'model-a'],
  });
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session(),
    [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [cached] },
  });
  const result = await service(
    fake.api,
    async () => jsonResponse({ data: [{ id: 'model-a' }, { id: 'model-b' }] }),
  ).retryProvision();

  assert.deepEqual(result.credential.models, ['model-a', 'model-b']);
  assert.equal(result.credential.model, 'model-a');
  assert.equal(fake.values[AGENTX_CREDENTIAL_STORAGE_KEY].records[0].model, 'model-a');
});

test('a rejected cached key fetches current key with rotate false', async () => {
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session(),
    [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [credential()] },
  });
  let requestBody;
  let modelProbeCount = 0;
  const result = await service(fake.api, async (url, init = {}) => {
    if (String(url).endsWith('/models')) {
      modelProbeCount++;
      return modelProbeCount === 1
        ? jsonResponse({ error: 'invalid key' }, 401)
        : jsonResponse({ data: [{ id: 'model-b' }] });
    }
    requestBody = JSON.parse(init.body);
    return jsonResponse({
      key: 'sk-current-secret',
      base_url: 'https://aigw.dev-server.cloud',
      models: ['model-b'],
      default_model: 'model-b',
      status: 'reused',
    });
  }).retryProvision();
  assert.deepEqual(requestBody, { rotate: false });
  assert.equal(result.credential.key, 'sk-current-secret');
  assert.equal(
    fake.values[AGENTX_CREDENTIAL_STORAGE_KEY].records[0].key,
    'sk-current-secret',
  );
});

test('transient gateway failure retains the usable cached key', async () => {
  const cached = credential();
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session(),
    [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [cached] },
  });
  const result = await service(fake.api, async () => jsonResponse({ error: 'down' }, 503))
    .retryProvision();
  assert.equal(result.credential.key, cached.key);
  assert.equal(result.credential.provisionOutcome, 'stale-offline');
  assert.equal(fake.values[AGENTX_CREDENTIAL_STORAGE_KEY].records[0].key, cached.key);
});

test('an authoritative empty gateway model list never falls back to a stale cached model', async () => {
  const cached = credential({ model: 'removed-model', models: ['removed-model'] });
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session(),
    [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [cached] },
  });
  const cloud = service(fake.api, async (url) => {
    if (String(url).endsWith('/models')) return jsonResponse({ data: [] });
    return jsonResponse({
      key: 'sk-current-secret',
      base_url: CONFIG.litellmBaseUrl,
      models: ['removed-model'],
      default_model: 'removed-model',
      status: 'reused',
    });
  });
  await assert.rejects(
    () => cloud.retryProvision(),
    (error) => error.code === 'gateway_models_empty',
  );
});

test('invalid_grant clears auth session but never deletes cached model key', async () => {
  const cached = credential();
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session({ expiresAt: NOW - 1 }),
    [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [cached] },
  });
  const restored = await service(fake.api, async () => jsonResponse({ error: 'invalid_grant' }, 400))
    .restoreSession();
  assert.equal(restored.outcome, 'needs-login');
  assert.equal(fake.values[AGENTX_SESSION_STORAGE_KEY], undefined);
  assert.equal(fake.values[AGENTX_CREDENTIAL_STORAGE_KEY].records[0].key, cached.key);
});

test('a session the wrapper gave no refresh token outlives its token expiry', async () => {
  const cached = credential();
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session({
      refreshToken: '',
      expiresAt: NOW - 60_000,
      lastActiveAt: NOW - 60_000,
    }),
    [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [cached] },
  });
  // A thrown fetch proves the grace branch never even attempts a refresh.
  const svc = service(fake.api, async () => { throw new Error('refresh must not be attempted'); });
  const restored = await svc.restoreSession();
  assert.equal(restored.outcome, 'stored');
  assert.equal(restored.session.user.subject, 'user-123');
  assert.equal((await svc.publicStatus()).signedIn, true);
  // The session survives in storage for the next panel document too.
  assert.equal(fake.values[AGENTX_SESSION_STORAGE_KEY].user.subject, 'user-123');
});

test('a refresh-less session still signs out at the idle deadline', async () => {
  const clock = { now: NOW };
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session({
      refreshToken: '',
      expiresAt: NOW + 10 * 60_000,
      lastActiveAt: NOW,
    }),
  });
  const svc = createAgentXCloudService({
    api: fake.api,
    config: { ...CONFIG, sessionIdleTimeoutMs: IDLE_MS },
    fetchImpl: async () => { throw new Error('no network expected'); },
    cryptoImpl: webcrypto,
    now: () => clock.now,
  });
  // Twenty minutes past the token's exp but inside the idle window: still in.
  clock.now = NOW + IDLE_MS - 1;
  assert.equal((await svc.publicStatus()).signedIn, true);
  clock.now = NOW + IDLE_MS;
  const expired = await svc.publicStatus();
  assert.equal(expired.signedIn, false);
  assert.equal(expired.outcome, 'idle-expired');
});

test('explicit sign-out clears only the current account credential', async () => {
  const current = credential();
  const other = credential({
    subject: 'other-user',
    key: 'sk-other-secret',
    account: 'other',
  });
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session(),
    [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [current, other] },
  });
  await service(fake.api, async () => new Response(null, { status: 204 })).signOut();
  assert.equal(fake.values[AGENTX_SESSION_STORAGE_KEY], undefined);
  assert.deepEqual(
    fake.values[AGENTX_CREDENTIAL_STORAGE_KEY].records.map((record) => record.subject),
    ['other-user'],
  );
});

test('settings controller installs the key and persists a valid model selection', async () => {
  const cached = credential({ models: ['model-a', 'model-b'] });
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session(),
    [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [cached] },
  });
  const calls = [];
  const providerState = {
    providers: { webbrain_cloud: { type: 'openai', category: 'cloud' } },
    active: 'openai',
  };
  const controller = createAgentXCloudSettingsController({
    api: fake.api,
    config: CONFIG,
    locale: () => 'vi',
    async sendToBackground(action, data = {}) {
      calls.push({ action, data });
      if (action === 'update_provider') {
        Object.assign(providerState.providers.webbrain_cloud, data.config);
        return { ok: true };
      }
      if (action === 'set_active_provider') {
        providerState.active = data.providerId;
        return { ok: true };
      }
      if (action === 'get_providers') return structuredClone(providerState);
      throw new Error(`Unexpected background action: ${action}`);
    },
    onProvidersChanged(next) {
      Object.assign(providerState, next);
    },
    onRender() {},
    serviceOptions: {
      fetchImpl: async () => jsonResponse({ data: [{ id: 'model-a' }, { id: 'model-b' }] }),
      cryptoImpl: webcrypto,
      now: () => NOW,
    },
  });

  // The cached key probe succeeds, then the controller installs/activates it.
  await controller.initialize();

  const update = calls.find((call) => call.action === 'update_provider');
  assert.equal(update.data.config.apiKey, cached.key);
  assert.equal(update.data.config.baseUrl, CONFIG.litellmBaseUrl);
  assert.equal(update.data.config.providerName, 'agentx-cloud');
  assert.equal(update.data.config.agentxCloudManaged, true);
  assert.equal(providerState.active, 'webbrain_cloud');
  assert.equal(controller.isConnected(), true);
  const markup = controller.render();
  assert.doesNotMatch(markup, /sk-existing-secret/);
  assert.doesNotMatch(markup, /manage-billing|btn-duplicate/);
  assert.match(markup, /aigw\.dev-server\.cloud/);
  assert.match(markup, /data-agentx-cloud-model/);
  assert.match(markup, /model-b/);

  await controller.selectModel('model-b');
  assert.equal(controller.status().provider.model, 'model-b');
  assert.equal(providerState.providers.webbrain_cloud.model, 'model-b');

  // Restoring the Cloud session must preserve a still-available user choice
  // instead of replacing it with Second Brain's first/default model.
  await controller.initialize();
  const updates = calls.filter((call) => call.action === 'update_provider');
  assert.equal(updates.at(-1).data.config.model, 'model-b');
  assert.match(controller.render(), /value="model-b" selected/);
});

test('settings controller can select a Cloud vision model without exposing the key', async () => {
  const cached = credential({
    models: ['model-a', 'Qwen/Qwen2.5-VL-7B'],
    visionModels: ['Qwen/Qwen2.5-VL-7B'],
    visionFromInfo: ['Qwen/Qwen2.5-VL-7B'],
  });
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session(),
    [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [cached] },
  });
  const providerState = {
    providers: { webbrain_cloud: { type: 'openai', category: 'cloud' } },
    active: 'openai',
  };
  const controller = createAgentXCloudSettingsController({
    api: fake.api,
    config: CONFIG,
    locale: () => 'vi',
    async sendToBackground(action, data = {}) {
      if (action === 'update_provider') {
        Object.assign(providerState.providers.webbrain_cloud, data.config);
        return { ok: true };
      }
      if (action === 'set_active_provider') {
        providerState.active = data.providerId;
        return { ok: true };
      }
      if (action === 'get_providers') return structuredClone(providerState);
      if (action === 'test_vision_provider') {
        return { ok: true, model: providerState.providers.webbrain_cloud.agentxCloudVisionModel };
      }
      throw new Error(`Unexpected background action: ${action}`);
    },
    onRender() {},
    serviceOptions: {
      fetchImpl: async () => jsonResponse({
        data: [
          { id: 'model-a' },
          { id: 'Qwen/Qwen2.5-VL-7B', supports_vision: true },
        ],
      }),
      cryptoImpl: webcrypto,
      now: () => NOW,
    },
  });

  await controller.initialize();
  const visionMarkup = controller.renderVision();
  assert.doesNotMatch(visionMarkup, /sk-existing-secret/);
  assert.match(visionMarkup, /data-agentx-cloud-vision-model/);
  assert.match(visionMarkup, /Qwen\/Qwen2\.5-VL-7B/);
  assert.match(visionMarkup, /Chưa chọn/);

  await controller.selectVisionModel('Qwen/Qwen2.5-VL-7B');
  assert.equal(controller.status().provider.visionModel, 'Qwen/Qwen2.5-VL-7B');
  assert.equal(
    providerState.providers.webbrain_cloud.agentxCloudVisionModel,
    'Qwen/Qwen2.5-VL-7B',
  );
  assert.match(controller.renderVision(), /value="Qwen\/Qwen2\.5-VL-7B" selected/);
  assert.doesNotMatch(controller.renderVision(), /sk-existing-secret/);
});

test('an open Settings card follows a composer model switch through storage', async () => {
  const cached = credential({ models: ['model-a', 'model-b'] });
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session(),
    [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [cached] },
  });
  const providerState = {
    providers: { webbrain_cloud: { type: 'openai', category: 'cloud' } },
    active: 'openai',
  };
  let renders = 0;
  const controller = createAgentXCloudSettingsController({
    api: fake.api,
    config: CONFIG,
    locale: () => 'vi',
    async sendToBackground(action, data = {}) {
      if (action === 'update_provider') {
        Object.assign(providerState.providers.webbrain_cloud, data.config);
        return { ok: true };
      }
      if (action === 'set_active_provider') {
        providerState.active = data.providerId;
        return { ok: true };
      }
      if (action === 'get_providers') return structuredClone(providerState);
      throw new Error(`Unexpected background action: ${action}`);
    },
    onRender() { renders += 1; },
    serviceOptions: {
      fetchImpl: async () => jsonResponse({ data: [{ id: 'model-a' }, { id: 'model-b' }] }),
      cryptoImpl: webcrypto,
      now: () => NOW,
    },
  });

  await controller.initialize();
  assert.equal(controller.status().provider.model, 'model-a');

  // The composer chip switches the model: the background merges { model } into
  // the provider entry and the providers storage key changes. The open card
  // must repaint the new selection without a reload.
  const switched = {
    ...providerState.providers.webbrain_cloud,
    agentxCloudManaged: true,
    apiKey: cached.key,
    model: 'model-b',
    models: ['model-a', 'model-b'],
  };
  const before = renders;
  fake.storageChanged.emit({ providers: { newValue: { webbrain_cloud: switched } } }, 'local');
  assert.equal(controller.status().provider.model, 'model-b');
  assert.ok(renders > before, 'the storage sync must repaint the card');
  assert.match(controller.render(), /value="model-b" selected/);

  // The same event repeated changes nothing and does not repaint again.
  const stable = renders;
  fake.storageChanged.emit({ providers: { newValue: { webbrain_cloud: switched } } }, 'local');
  assert.equal(renders, stable);

  // A sign-out-shaped entry (credential cleared) must be ignored: the
  // sign-out flow owns that repaint, half-cleared values never show.
  fake.storageChanged.emit({
    providers: { newValue: { webbrain_cloud: { ...switched, apiKey: '', agentxCloudManaged: false, model: '' } } },
  }, 'local');
  assert.equal(controller.status().provider.model, 'model-b');
});

test('Cloud vision sidecar uses the gateway key and ignores an empty selection', () => {
  const cloudConfig = {
    agentxCloudManaged: true,
    apiKey: 'sk-existing-secret',
    baseUrl: CONFIG.litellmBaseUrl,
    models: ['model-a', 'Qwen/Qwen2.5-VL-7B'],
    agentxCloudVisionModels: ['Qwen/Qwen2.5-VL-7B'],
    agentxCloudVisionModel: 'Qwen/Qwen2.5-VL-7B',
  };
  const sidecar = resolveCloudVisionSidecar(cloudConfig);
  assert.equal(sidecar.providerName, 'agentx-cloud');
  assert.equal(sidecar.model, 'Qwen/Qwen2.5-VL-7B');
  assert.equal(sidecar.apiKey, 'sk-existing-secret');
  assert.equal(sidecar.supportsVision, true);
  assert.equal(resolveCloudVisionSidecar({ ...cloudConfig, agentxCloudVisionModel: '' }), null);
  assert.equal(
    resolveCloudVisionSidecar({ ...cloudConfig, agentxCloudVisionModel: 'outside-gateway' }),
    null,
  );
  assert.deepEqual(
    visionModelsFromGateway(['model-a', 'Qwen/Qwen2.5-VL-7B']),
    ['Qwen/Qwen2.5-VL-7B'],
  );
});

test('the Cloud vision sidecar calls the feature vision model the key reaches outside the chat list', () => {
  const cloudConfig = {
    agentxCloudManaged: true,
    apiKey: 'sk-role-key',
    baseUrl: CONFIG.litellmBaseUrl,
    models: ['MiniMax/MiniMax-M3', 'Qwen/Qwen3.5-122B-A10B-FP8'],
    agentxCloudReachableModels: ROLE_CATALOG.data.map((m) => m.id),
    agentxCloudVisionModels: ['Qwen/Qwen3.6-35B-A3B-FP8', 'MiniMax/MiniMax-M3'],
    agentxCloudVisionModel: 'Qwen/Qwen3.6-35B-A3B-FP8',
  };
  const sidecar = resolveCloudVisionSidecar(cloudConfig);
  assert.equal(sidecar.model, 'Qwen/Qwen3.6-35B-A3B-FP8');
  assert.ok(sidecar.models.includes('Qwen/Qwen3.6-35B-A3B-FP8'));
  // Without the reachable list (a config from an older build) it is not called.
  assert.equal(resolveCloudVisionSidecar({ ...cloudConfig, agentxCloudReachableModels: undefined }), null);
});

test('installing a credential defaults the vision model but keeps a choice made in Settings', async () => {
  const { installCloudCredential } = await import(
    pathToFileURL(path.join(CHROME_ROOT, 'src/agentx/cloud-provider-install.js')).href
  );
  const fake = createApi({ [AGENTX_SESSION_STORAGE_KEY]: session() });
  const { credential: cred } = await service(fake.api, roleFetch()).retryProvision();
  const providerState = { providers: { webbrain_cloud: { type: 'openai', category: 'cloud' } } };
  const send = async (action, data = {}) => {
    if (action === 'update_provider') {
      Object.assign(providerState.providers.webbrain_cloud, data.config);
      return { ok: true };
    }
    if (action === 'get_providers') return structuredClone(providerState);
    if (action === 'set_active_provider') return { ok: true };
    throw new Error(`Unexpected background action: ${action}`);
  };

  await installCloudCredential(send, cred);
  const installed = providerState.providers.webbrain_cloud;
  assert.deepEqual(installed.models, ['MiniMax/MiniMax-M3', 'Qwen/Qwen3.5-122B-A10B-FP8']);
  assert.equal(installed.model, 'MiniMax/MiniMax-M3');
  assert.equal(installed.agentxCloudVisionModel, 'Qwen/Qwen3.6-35B-A3B-FP8');
  assert.equal(installed.agentxCloudReachableModels.length, 6); // the speech model too: reachable, never offered

  // Somebody turns the vision model off in Settings; the next install respects it.
  Object.assign(installed, { agentxCloudVisionModel: '', agentxCloudVisionModelUserSet: true });
  await installCloudCredential(send, cred);
  assert.equal(providerState.providers.webbrain_cloud.agentxCloudVisionModel, '');
});

// ─── Sign-in gate ─────────────────────────────────────────────────────────
// The gate runs in the side panel, so these tests stand in a DOM small enough
// to keep the assertions about behaviour rather than about markup.
function fakeElement(tag = 'div') {
  const classes = new Set();
  return {
    tag,
    textContent: '',
    disabled: false,
    inert: false,
    attributes: {},
    listeners: {},
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, force) => (force ? classes.add(name) : classes.delete(name)),
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); },
    removeEventListener(type, handler) {
      this.listeners[type] = (this.listeners[type] || []).filter((fn) => fn !== handler);
    },
    emit(type, ...args) {
      for (const handler of [...(this.listeners[type] || [])]) handler(...args);
    },
  };
}

function fakeGateDom() {
  const parts = {
    eyebrow: fakeElement('p'),
    title: fakeElement('h1'),
    body: fakeElement('p'),
    notice: fakeElement('p'),
    busy: fakeElement('p'),
    busyLabel: fakeElement('span'),
    signin: fakeElement('button'),
    settings: fakeElement('button'),
    footnote: fakeElement('p'),
  };
  const selectors = {
    '[data-agentx-gate-eyebrow]': parts.eyebrow,
    '[data-agentx-gate-title]': parts.title,
    '[data-agentx-gate-body]': parts.body,
    '[data-agentx-gate-notice]': parts.notice,
    '[data-agentx-gate-busy]': parts.busy,
    '[data-agentx-gate-busy-label]': parts.busyLabel,
    '[data-agentx-gate-signin]': parts.signin,
    '[data-agentx-gate-settings]': parts.settings,
    '[data-agentx-gate-footnote]': parts.footnote,
  };
  const root = fakeElement('div');
  root.querySelector = (selector) => selectors[selector] || null;
  const documentRef = fakeElement('document');
  documentRef.body = fakeElement('body');
  documentRef.visibilityState = 'visible';
  return { root, appRoot: fakeElement('div'), documentRef, parts };
}

/**
 * Manual timers for the gate's own deadlines: tests fire them by delay value
 * instead of waiting wall-clock time.
 */
function manualTimers() {
  const pending = new Map();
  let seq = 0;
  return {
    pending,
    setTimeout(fn, ms) {
      const id = ++seq;
      pending.set(id, { fn, ms: Number(ms) });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    fire(matcher = () => true) {
      for (const [id, timer] of [...pending]) {
        if (!matcher(timer)) continue;
        pending.delete(id);
        timer.fn();
      }
    },
  };
}

function gateHarness({ seed, clock, fetchImpl, sendToBackground, gateOptions = {} } = {}) {
  const fake = createApi(seed);
  const dom = fakeGateDom();
  const calls = [];
  const providerState = {
    providers: { webbrain_cloud: { type: 'openai', category: 'cloud' } },
    active: 'openai',
  };
  const defaultSendToBackground = async (action, data = {}) => {
    calls.push({ action, data });
    if (action === 'update_provider') {
      Object.assign(providerState.providers.webbrain_cloud, data.config);
      return { ok: true };
    }
    if (action === 'set_active_provider') {
      providerState.active = data.providerId;
      return { ok: true };
    }
    if (action === 'get_providers') return structuredClone(providerState);
    throw new Error(`Unexpected background action: ${action}`);
  };
  const gate = createAgentXLoginGate({
    api: fake.api,
    root: dom.root,
    appRoot: dom.appRoot,
    documentRef: dom.documentRef,
    locale: () => 'vi',
    config: { ...CONFIG, sessionIdleTimeoutMs: IDLE_MS },
    sendToBackground: sendToBackground
      ? (action, data) => sendToBackground(action, data, { calls, providerState, defaultSendToBackground })
      : defaultSendToBackground,
    serviceOptions: {
      fetchImpl: fetchImpl || (async () => jsonResponse({ data: [{ id: 'model-a' }] })),
      cryptoImpl: webcrypto,
      now: () => clock.now,
    },
    ...gateOptions,
  });
  return { gate, dom, calls, providerState, api: fake.api, values: fake.values, storageChanged: fake.storageChanged };
}

function flushMicrotasks(rounds = 3) {
  let chain = Promise.resolve();
  for (let i = 0; i < rounds; i++) chain = chain.then(() => new Promise((resolve) => setTimeout(resolve, 0)));
  return chain;
}

test('an untouched session expires on its idle deadline and reports why', async () => {
  const clock = { now: NOW };
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session({ lastActiveAt: NOW }),
  });
  const svc = createAgentXCloudService({
    api: fake.api,
    config: { ...CONFIG, sessionIdleTimeoutMs: IDLE_MS },
    fetchImpl: async () => { throw new Error('no network expected'); },
    cryptoImpl: webcrypto,
    now: () => clock.now,
  });

  clock.now = NOW + IDLE_MS - 1;
  assert.equal((await svc.publicStatus()).signedIn, true);

  clock.now = NOW + IDLE_MS;
  const expired = await svc.publicStatus();
  assert.equal(expired.signedIn, false);
  assert.equal(expired.idleExpired, true);
  assert.equal(expired.outcome, 'idle-expired');
  // The session is gone, so a later read cannot resurrect it.
  assert.equal(Object.hasOwn(fake.values, AGENTX_SESSION_STORAGE_KEY), false);
});

test('a session stored before idle expiry shipped is anchored to when it was issued', async () => {
  const clock = { now: NOW + IDLE_MS + 1 };
  const stored = session();
  delete stored.lastActiveAt;
  const fake = createApi({ [AGENTX_SESSION_STORAGE_KEY]: stored });
  const svc = createAgentXCloudService({
    api: fake.api,
    config: { ...CONFIG, sessionIdleTimeoutMs: IDLE_MS },
    fetchImpl: async () => { throw new Error('no network expected'); },
    cryptoImpl: webcrypto,
    now: () => clock.now,
  });
  const status = await svc.publicStatus();
  assert.equal(status.signedIn, false);
  assert.equal(status.idleExpired, true);
});

test('touchSession pushes the idle deadline out and throttles storage writes', async () => {
  const clock = { now: NOW };
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session({ lastActiveAt: NOW }),
  });
  const svc = createAgentXCloudService({
    api: fake.api,
    config: { ...CONFIG, sessionIdleTimeoutMs: IDLE_MS },
    fetchImpl: async () => { throw new Error('no network expected'); },
    cryptoImpl: webcrypto,
    now: () => clock.now,
  });

  clock.now = NOW + IDLE_MS - 1_000;
  assert.equal((await svc.touchSession({ force: true })).persisted, true);
  assert.equal(fake.values[AGENTX_SESSION_STORAGE_KEY].lastActiveAt, clock.now);

  // Past the original deadline, alive on the refreshed one.
  clock.now = NOW + IDLE_MS + 1;
  assert.equal((await svc.publicStatus()).signedIn, true);

  // A second touch inside the write interval stays in memory only.
  const persistedAt = fake.values[AGENTX_SESSION_STORAGE_KEY].lastActiveAt;
  const touchedAt = clock.now + 5_000;
  clock.now = touchedAt;
  assert.equal((await svc.touchSession()).persisted, false);
  assert.equal(fake.values[AGENTX_SESSION_STORAGE_KEY].lastActiveAt, persistedAt);

  // Touching a session that already went idle re-locks instead of reviving it.
  // The throttled touch above still moved the in-memory stamp, so the live
  // deadline runs from that touch rather than from the last storage write.
  clock.now = touchedAt + IDLE_MS;
  const dead = await svc.touchSession({ force: true });
  assert.deepEqual(dead, { signedIn: false, idleExpired: true });
});

test('activity in one document keeps the session alive for the other', async () => {
  const clock = { now: NOW };
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session({ lastActiveAt: NOW }),
  });
  const options = {
    api: fake.api,
    config: { ...CONFIG, sessionIdleTimeoutMs: IDLE_MS },
    fetchImpl: async () => { throw new Error('no network expected'); },
    cryptoImpl: webcrypto,
    now: () => clock.now,
  };
  // Two surfaces, two service instances — the panel and a Settings tab.
  const panel = createAgentXCloudService(options);
  const settings = createAgentXCloudService(options);

  // Both cache the session, then only the panel sees any activity.
  assert.equal((await panel.publicStatus()).signedIn, true);
  assert.equal((await settings.publicStatus()).signedIn, true);

  clock.now = NOW + IDLE_MS - 1_000;
  await panel.touchSession({ force: true });

  // The Settings tab has been sitting on a stale copy the whole time; it must
  // not decide the busy session went idle.
  clock.now = NOW + IDLE_MS + 1;
  assert.equal((await settings.publicStatus()).signedIn, true);
  assert.equal(Object.hasOwn(fake.values, AGENTX_SESSION_STORAGE_KEY), true);
});

test('the side panel stays locked until the cloud key is installed', async () => {
  const clock = { now: NOW };
  const harness = gateHarness({
    clock,
    seed: {
      [AGENTX_SESSION_STORAGE_KEY]: session({ lastActiveAt: NOW }),
      [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [credential()] },
    },
  });

  assert.equal(harness.gate.isLocked(), true);
  assert.equal(harness.dom.appRoot.inert, false);

  await harness.gate.start();
  harness.gate.stop();

  assert.equal(harness.gate.isLocked(), false);
  assert.equal(harness.dom.root.classList.contains('hidden'), true);
  assert.equal(harness.dom.appRoot.inert, false);
  assert.equal(harness.dom.appRoot.attributes['aria-hidden'], undefined);
  assert.equal(harness.providerState.active, 'webbrain_cloud');
  const update = harness.calls.find((call) => call.action === 'update_provider');
  assert.equal(update.data.config.apiKey, 'sk-existing-secret');
  assert.equal(update.data.config.agentxCloudManaged, true);
});

test('a signed-out panel offers sign-in and never unlocks on its own', async () => {
  const clock = { now: NOW };
  const harness = gateHarness({ clock, seed: {} });

  const pending = harness.gate.start();
  const settled = await Promise.race([
    pending.then(() => 'unlocked'),
    Promise.resolve('still-locked'),
  ]);
  harness.gate.stop();

  assert.equal(settled, 'still-locked');
  assert.equal(harness.gate.isLocked(), true);
  assert.equal(harness.dom.root.classList.contains('hidden'), false);
  assert.equal(harness.dom.appRoot.inert, true);
  assert.equal(harness.dom.parts.signin.textContent, 'Đăng nhập AgentX');
  assert.equal(harness.calls.length, 0);
});

test('the panel re-locks with an idle notice once the session times out', async () => {
  const clock = { now: NOW };
  const harness = gateHarness({
    clock,
    seed: {
      [AGENTX_SESSION_STORAGE_KEY]: session({ lastActiveAt: NOW }),
      [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [credential()] },
    },
  });
  await harness.gate.start();
  assert.equal(harness.gate.isLocked(), false);

  clock.now = NOW + IDLE_MS;
  await harness.gate.checkSession();
  // relock() kicks off a fresh status read; let it settle before asserting.
  await new Promise((resolve) => setTimeout(resolve, 0));
  harness.gate.stop();

  assert.equal(harness.gate.isLocked(), true);
  assert.equal(harness.dom.appRoot.inert, true);
  assert.equal(harness.dom.root.classList.contains('hidden'), false);
  assert.match(harness.dom.parts.notice.textContent, /không dùng/);
});

test('signing out elsewhere re-locks the panel that is already open', async () => {
  const clock = { now: NOW };
  const harness = gateHarness({
    clock,
    seed: {
      [AGENTX_SESSION_STORAGE_KEY]: session({ lastActiveAt: NOW }),
      [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [credential()] },
    },
  });
  await harness.gate.start();
  assert.equal(harness.gate.isLocked(), false);

  delete harness.values[AGENTX_SESSION_STORAGE_KEY];
  harness.storageChanged.emit(
    { [AGENTX_SESSION_STORAGE_KEY]: { oldValue: {}, newValue: undefined } },
    'local',
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  harness.gate.stop();

  assert.equal(harness.gate.isLocked(), true);
  assert.match(harness.dom.parts.notice.textContent, /đăng xuất/);
});

test('a locked panel unlocks on its own when the background signs in (Workmate auth_hint)', async () => {
  const clock = { now: NOW };
  const harness = gateHarness({ clock, seed: {} });

  const pending = harness.gate.start();
  await flushMicrotasks();
  assert.equal(harness.gate.isLocked(), true);
  assert.equal(harness.calls.length, 0);

  // The service worker's silent sign-in lands the session and the cached key in storage…
  harness.values[AGENTX_SESSION_STORAGE_KEY] = session({ lastActiveAt: NOW });
  harness.values[AGENTX_CREDENTIAL_STORAGE_KEY] = { version: 1, records: [credential()] };
  // …and the storage event is what the panel sees.
  harness.storageChanged.emit(
    { [AGENTX_SESSION_STORAGE_KEY]: { oldValue: undefined, newValue: harness.values[AGENTX_SESSION_STORAGE_KEY] } },
    'local',
  );
  await pending;
  harness.gate.stop();

  assert.equal(harness.gate.isLocked(), false, 'no click, no visibility change: the storage event alone unlocks');
  assert.equal(harness.providerState.active, 'webbrain_cloud');
  assert.equal(harness.calls.find((call) => call.action === 'update_provider').data.config.apiKey, 'sk-existing-secret');
});

/** A cloud service stand-in for the Workmate auth hooks: scripted answers, recorded calls. */
function fakeAuthService({ signedIn = false, email = '', silent, interactive } = {}) {
  const calls = [];
  const result = {
    session: { user: { subject: 'user-123', email: 'kien@example.test' } },
    credential: credential(),
  };
  return {
    calls,
    service: {
      async publicStatus() {
        calls.push(['status']);
        return signedIn ? { signedIn: true, outcome: 'stored', user: { email } } : { signedIn: false, outcome: 'needs-login', user: null };
      },
      async silentSignInAndProvision(options) {
        calls.push(['silent', options]);
        if (typeof silent === 'function') return silent(options);
        if (silent instanceof Error) throw silent;
        return result;
      },
      async signInAndProvision(options) {
        calls.push(['interactive', options]);
        if (typeof interactive === 'function') return interactive(options);
        if (interactive instanceof Error) throw interactive;
        return result;
      },
    },
  };
}

function authHarness(serviceOptions = {}, { now = () => NOW } = {}) {
  const { service: cloud, calls } = fakeAuthService(serviceOptions);
  const background = [];
  const providerState = { providers: { webbrain_cloud: {} }, active: 'openai' };
  const auth = createWorkmateAuth({
    api: {},
    service: cloud,
    now,
    sendToBackground: async (action, data = {}) => {
      background.push({ action, data });
      if (action === 'get_providers') return structuredClone(providerState);
      if (action === 'update_provider') {
        Object.assign(providerState.providers.webbrain_cloud, data.config);
        return { ok: true };
      }
      if (action === 'set_active_provider') {
        providerState.active = data.providerId;
        return { ok: true };
      }
      throw new Error(`Unexpected background action: ${action}`);
    },
  });
  return { auth, calls, background, providerState };
}

test('auth_hint signs in silently and installs the key; a signed-in browser is left alone', async () => {
  const fresh = authHarness();
  const outcome = await fresh.auth.hint({ loginHint: 'kien@example.test' });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.outcome, 'signed-in');
  assert.equal(outcome.signedIn, true);
  assert.equal(outcome.email, 'kien@example.test');
  assert.deepEqual(fresh.calls[1], ['silent', { loginHint: 'kien@example.test' }]);
  assert.equal(fresh.providerState.active, 'webbrain_cloud');
  assert.equal(fresh.providerState.providers.webbrain_cloud.apiKey, 'sk-existing-secret');

  const already = authHarness({ signedIn: true, email: 'other@example.test' });
  const kept = await already.auth.hint({ loginHint: 'kien@example.test' });
  assert.equal(kept.outcome, 'already-signed-in');
  assert.equal(kept.matchesHint, false, 'a different account is reported, never replaced');
  assert.equal(already.calls.some(([kind]) => kind === 'silent'), false);
  assert.equal(already.background.length, 0);
});

test('auth_hint answers login_required calmly and holds off for a minute; other failures are reported', async () => {
  let now = NOW;
  const noSession = authHarness(
    { silent: Object.assign(new Error('no session'), { code: 'login_required' }) },
    { now: () => now },
  );
  // The service throws a real AgentXCloudError in production; mirror its shape.
  const { AgentXCloudError } = await import(pathToFileURL(SERVICE_PATH).href);
  noSession.calls.length = 0;
  const denied = authHarness({ silent: new AgentXCloudError('login_required', 'no session') }, { now: () => now });
  const first = await denied.auth.hint({ loginHint: 'kien@example.test' });
  assert.equal(first.ok, true, 'no session is an ordinary answer, not a failure');
  assert.equal(first.outcome, 'login-required');
  assert.equal(first.signedIn, false);
  assert.equal(first.code, 'login_required');
  assert.equal('error' in first, false);
  assert.equal(denied.background.length, 0, 'nothing is installed');

  const again = await denied.auth.hint({ loginHint: 'kien@example.test' });
  assert.equal(again.heldOff, true, 'the same hint is not retried within the holdoff');
  assert.equal(denied.calls.filter(([kind]) => kind === 'silent').length, 1);

  now = NOW + LOGIN_REQUIRED_HOLDOFF_MS + 1;
  await denied.auth.hint({ loginHint: 'kien@example.test' });
  assert.equal(denied.calls.filter(([kind]) => kind === 'silent').length, 2, 'after the holdoff it asks Keycloak again');

  const broken = authHarness({ silent: new AgentXCloudError('network_unavailable', 'offline') });
  const failed = await broken.auth.hint({ loginHint: 'kien@example.test' });
  assert.equal(failed.ok, false);
  assert.equal(failed.outcome, 'error');
  assert.equal(failed.code, 'network_unavailable');
  assert.equal('error' in failed, false, 'a code must not travel as `error` — the offscreen bridge would turn the reply into a protocol failure');

  const noIdentity = authHarness({ silent: new AgentXCloudError('identity_unavailable_api', 'no identity') });
  const unsupported = await noIdentity.auth.hint({});
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.outcome, 'unsupported');
  assert.equal(unsupported.code, 'identity_unavailable_api');
});

test('auth_open starts the interactive sign-in with the hint, answers at once, and installs the key when it ends', async () => {
  let finish;
  const fresh = authHarness({
    interactive: () => new Promise((resolve) => { finish = resolve; }),
  });
  const outcome = await fresh.auth.open({ loginHint: 'kien@example.test' });
  assert.equal(outcome.outcome, 'opened', 'the reply does not wait for the person to type a password');
  assert.equal(outcome.signedIn, false);
  assert.deepEqual(fresh.calls[1], ['interactive', { loginHint: 'kien@example.test' }]);
  assert.equal((await fresh.auth.status()).interactiveOpen, true);
  assert.equal((await fresh.auth.open({ loginHint: 'kien@example.test' })).outcome, 'in-progress', 'no second tab while one is open');
  assert.equal(fresh.providerState.active, 'openai', 'nothing installed yet');

  finish({ session: { user: { subject: 'user-123', email: 'kien@example.test' } }, credential: credential() });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fresh.providerState.active, 'webbrain_cloud', 'the key lands once the sign-in ends');
  const after = await fresh.auth.status();
  assert.equal(after.interactiveOpen, false);
  assert.equal(after.lastInteractive.outcome, 'signed-in');

  // A sign-in that ends at once (already-known error) is reported in the reply itself.
  const { AgentXCloudError } = await import(pathToFileURL(SERVICE_PATH).href);
  const refused = authHarness({ interactive: new AgentXCloudError('sign_in_window_failed', 'no window') });
  const failed = await refused.auth.open({});
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'sign_in_window_failed');

  const same = authHarness({ signedIn: true, email: 'KIEN@example.test' });
  const kept = await same.auth.open({ loginHint: 'kien@example.test' });
  assert.equal(kept.outcome, 'already-signed-in');
  assert.equal(kept.matchesHint, true, 'email comparison ignores case');
  assert.equal(same.calls.some(([kind]) => kind === 'interactive'), false);
});

test('a hung status check times out to a retry button instead of spinning forever', async () => {
  const clock = { now: NOW };
  const timers = manualTimers();
  const harness = gateHarness({
    clock,
    seed: {
      [AGENTX_SESSION_STORAGE_KEY]: session({ lastActiveAt: NOW }),
      [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [credential()] },
    },
    gateOptions: {
      restoreTimeoutMs: 1_000,
      setTimeoutImpl: timers.setTimeout,
      clearTimeoutImpl: timers.clearTimeout,
    },
  });
  // The storage backend stops answering — the documented Chrome failure mode
  // this deadline exists for. Every read from here on parks forever.
  harness.api.storage.local.get = () => new Promise(() => {});

  const pending = harness.gate.start();
  await flushMicrotasks();
  assert.equal(harness.dom.parts.busy.classList.contains('hidden'), false);
  assert.equal(harness.dom.parts.busyLabel.textContent, 'Đang kiểm tra phiên đăng nhập…');
  assert.equal(harness.dom.parts.signin.classList.contains('hidden'), true);

  timers.fire((timer) => timer.ms === 1_000);
  harness.gate.stop();

  assert.equal(harness.gate.isLocked(), true);
  assert.equal(harness.dom.parts.busy.classList.contains('hidden'), true);
  assert.equal(harness.dom.parts.signin.classList.contains('hidden'), false);
  assert.equal(harness.dom.parts.signin.textContent, 'Thử lại');
  assert.match(harness.dom.parts.notice.textContent, /quá lâu/);
  const settled = await Promise.race([
    pending.then(() => 'unlocked'),
    flushMicrotasks().then(() => 'still-locked'),
  ]);
  assert.equal(settled, 'still-locked');
});

test('a background that never answers cannot park the gate at provisioning', async () => {
  const clock = { now: NOW };
  const timers = manualTimers();
  const harness = gateHarness({
    clock,
    seed: {
      [AGENTX_SESSION_STORAGE_KEY]: session({ lastActiveAt: NOW }),
      [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [credential()] },
    },
    sendToBackground: (action, data, { calls, defaultSendToBackground }) => {
      if (action === 'update_provider') {
        calls.push({ action, data });
        // The service worker accepted the message and then died: the promise
        // never settles.
        return new Promise(() => {});
      }
      return defaultSendToBackground(action, data);
    },
    gateOptions: {
      restoreTimeoutMs: 60_000,
      backgroundCallTimeoutMs: 500,
      setTimeoutImpl: timers.setTimeout,
      clearTimeoutImpl: timers.clearTimeout,
    },
  });

  const pending = harness.gate.start();
  await flushMicrotasks();
  // The cached key probed fine, so the gate is now waiting on update_provider.
  assert.equal(harness.dom.parts.busyLabel.textContent, 'Đang chuẩn bị kết nối mô hình…');

  timers.fire((timer) => timer.ms === 500);
  await flushMicrotasks();
  harness.gate.stop();

  assert.equal(harness.gate.isLocked(), true);
  assert.equal(harness.dom.parts.signin.classList.contains('hidden'), false);
  assert.equal(harness.dom.parts.signin.textContent, 'Thử lại');
  assert.match(harness.dom.parts.notice.textContent, /không phản hồi/);
  const settled = await Promise.race([
    pending.then(() => 'unlocked'),
    flushMicrotasks().then(() => 'still-locked'),
  ]);
  assert.equal(settled, 'still-locked');
});

test('a status check that finishes after its deadline may not unlock the panel', async () => {
  const clock = { now: NOW };
  const timers = manualTimers();
  const harness = gateHarness({
    clock,
    seed: {
      [AGENTX_SESSION_STORAGE_KEY]: session({ lastActiveAt: NOW }),
      [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [credential()] },
    },
    gateOptions: {
      restoreTimeoutMs: 1_000,
      setTimeoutImpl: timers.setTimeout,
      clearTimeoutImpl: timers.clearTimeout,
    },
  });
  // Storage answers only once the test releases it — after the deadline.
  let releaseReads;
  const readsReleased = new Promise((resolve) => { releaseReads = resolve; });
  const realGet = harness.api.storage.local.get.bind(harness.api.storage.local);
  harness.api.storage.local.get = async (keys) => {
    await readsReleased;
    return realGet(keys);
  };

  const pending = harness.gate.start();
  await flushMicrotasks();
  timers.fire((timer) => timer.ms === 1_000);
  assert.match(harness.dom.parts.notice.textContent, /quá lâu/);

  // The stale attempt now completes successfully — and must change nothing.
  releaseReads();
  await flushMicrotasks(6);
  harness.gate.stop();

  assert.equal(harness.gate.isLocked(), true);
  assert.match(harness.dom.parts.notice.textContent, /quá lâu/);
  assert.equal(harness.dom.parts.signin.classList.contains('hidden'), false);
  const settled = await Promise.race([
    pending.then(() => 'unlocked'),
    flushMicrotasks().then(() => 'still-locked'),
  ]);
  assert.equal(settled, 'still-locked');
  // The panel it refused to unlock is exactly the value of the guard: the
  // NEXT attempt (user-driven retry) starts clean instead of racing this one.
});

test('both branded targets gate the side panel and keep Cloud management in settings', async () => {
  for (const target of ['chrome', 'firefox']) {
    const root = path.join(ROOT, 'brand-dist', target);
    const [html, settings, runtime, manager, openai, sidepanelHtml, sidepanelJs] = await Promise.all([
      fs.readFile(path.join(root, 'src/ui/settings.html'), 'utf8'),
      fs.readFile(path.join(root, 'src/ui/settings.js'), 'utf8'),
      fs.readFile(path.join(root, 'src/agentx/runtime-config.js'), 'utf8'),
      fs.readFile(path.join(root, 'src/providers/manager.js'), 'utf8'),
      fs.readFile(path.join(root, 'src/providers/openai.js'), 'utf8'),
      fs.readFile(path.join(root, 'src/ui/sidepanel.html'), 'utf8'),
      fs.readFile(path.join(root, 'src/ui/sidepanel.js'), 'utf8'),
    ]);
    assert.match(html, /agentx-cloud\.css/);
    assert.match(html, /agentx-cloud-vision-panel/);
    assert.match(settings, /createAgentXCloudSettingsController/);
    assert.match(settings, /renderAgentXCloudMultimodalSettings/);
    assert.doesNotMatch(settings, /btn-manage-billing|api\.webbrain\.one\/account/);
    assert.match(runtime, /"secondBrainBaseUrl": "https:\/\/agentx\.astralx\.com\.vn\/keys"/);
    assert.match(runtime, /https:\/\/aigw\.dev-server\.cloud\/v1/);
    assert.match(runtime, /https:\/\/agentx\.astralx\.com\.vn\/auth\/realms\/agent-hub/);
    assert.match(runtime, /"oidcClientId": "agentx-workmate"/);
    assert.match(manager, /baseUrl: AGENTX_RUNTIME_CONFIG\.litellmBaseUrl/);
    assert.match(manager, /providerName: 'agentx-cloud'/);
    assert.match(manager, /requiresModel: true/);
    assert.match(manager, /resolveCloudVisionSidecar/);
    assert.match(manager, /activeProviderId === WEBBRAIN_CLOUD_PROVIDER_ID/);
    assert.match(openai, /not available through this gateway key/);
    assert.doesNotMatch(manager, /webbrain-cloud 1\.0|api\.webbrain\.one\/v1/);
    // The panel carries the sign-in gate plus the composer model chip.
    // Connection tests, the vision/transcription pickers and sign-out stay on
    // the Settings card; the chip switches models through the same
    // update_provider message the card uses, never through the settings
    // controller, so the panel still needs none of the card's machinery.
    assert.doesNotMatch(sidepanelHtml, /agentx-cloud-sidepanel|agentx-cloud\.css/);
    assert.doesNotMatch(sidepanelJs, /createAgentXCloudSettingsController|agentxCloudController/);
    assert.match(sidepanelHtml, /id="btn-model-picker"/);
    assert.match(sidepanelHtml, /id="model-picker-menu"/);
    assert.match(sidepanelJs, /refreshComposerModelPicker\(res\);/);
    assert.match(sidepanelJs, /sendToBackground\('get_vision_provider_status'\)/);
    assert.match(sidepanelHtml, /agentx-login-gate\.css/);
    assert.match(sidepanelHtml, /id="agentx-login-gate"/);
    assert.match(sidepanelHtml, /data-agentx-gate-signin/);
    // Ships without `hidden`: the gate must be up before its module parses.
    assert.match(sidepanelHtml, /class="agentx-gate"\n/);
    assert.match(sidepanelJs, /createAgentXLoginGate/);
    // Onboarding must not start asking about providers before sign-in settles.
    assert.match(sidepanelJs, /await agentxSignedIn\.catch\(\(\) => \{\}\);/);
    // The boot watchdog is a classic script outside the module graph: when the
    // module never runs, it swaps the shipped spinner for a reload button. The
    // module retires it the moment it takes over.
    const watchdog = await fs.readFile(path.join(root, 'src/ui/agentx-boot-watchdog.js'), 'utf8');
    assert.match(watchdog, /__netmindGateBootAlive/);
    assert.match(watchdog, /location\.reload\(\)/);
    assert.match(sidepanelHtml, /<script src="agentx-boot-watchdog\.js"><\/script>/);
    assert.ok(
      sidepanelHtml.indexOf('agentx-boot-watchdog.js') < sidepanelHtml.indexOf('<script src="sidepanel.js" type="module">'),
      `${target}: the watchdog must load before the module it watches`,
    );
    assert.match(sidepanelJs, /globalThis\.__netmindGateBootAlive\?\.\(\);/);
  }

  const [transcribe, recorderHost] = await Promise.all([
    fs.readFile(path.join(CHROME_ROOT, 'src/agent/transcribe.js'), 'utf8'),
    fs.readFile(path.join(CHROME_ROOT, 'src/recorder/host.js'), 'utf8'),
  ]);
  assert.match(transcribe, /restrictedProviderId/);
  assert.match(transcribe, /Transcription blocked: choose an AgentX WebMate transcription model/);
  assert.match(recorderHost, /allowedModels: cloudTranscription\?\.models/);
});

// ─── AgentX license ───────────────────────────────────────────────────────
// The keys service reports one bundle license per person (GET /v1/license,
// and beside every /v1/model-key answer). `access` is the blocking signal;
// everything else is display. An SSO from before licensing answers 404
// not_found and must leave WebMate exactly as it was.

const KEYS_BASE = CONFIG.secondBrainBaseUrl;
const LICENSE_URL = `${KEYS_BASE}/v1/license`;
const MODEL_KEY_URL = `${KEYS_BASE}/v1/model-key`;
const MODELS_URL = `${CONFIG.litellmBaseUrl}/models`;

/** The contract's LICENSE object for a plan whose last day is 31/12/2026. */
function licenseBody(overrides = {}) {
  return {
    state: 'active',
    access: 'full',
    enforced: true,
    notice: null,
    plan: { slug: 'pilot-2026', name: 'Pilot nội bộ 2026' },
    products: ['workmate', 'webmate', 'chat'],
    starts_at: '2026-10-14T17:00:00+00:00',
    ends_at: '2026-12-31T17:00:00+00:00',
    grace_until: '2027-01-07T17:00:00+00:00',
    starts_on: '2026-10-15',
    last_day: '2026-12-31',
    read_only_from: '2027-01-08',
    revoked_at: null,
    days_left: 30,
    reminder: null,
    warn_days: [14, 7, 1],
    contact: 'it@astralx.com.vn',
    server_time: '2026-12-01T02:30:00+00:00',
    ...overrides,
  };
}

const EXPIRED = { state: 'expired', access: 'read_only', notice: 'read_only', days_left: null };
const GRACE = { state: 'grace', notice: 'grace', days_left: 5 };
const EXPIRING_7 = { notice: 'expiring', days_left: 7, reminder: 7 };

/** A license record as the service stores it. */
function licenseRecord(license, overrides = {}) {
  return {
    version: 1,
    records: [{
      subject: 'user-123',
      license: normalizeLicense(license),
      checkedAt: NOW,
      fetchedAt: NOW,
      ...overrides,
    }],
  };
}

/**
 * fetch for the three services the panel talks to: `/v1/license`,
 * `/v1/model-key` and LiteLLM's `/models`. Each handler returns a fresh
 * Response (bodies are single-use); unknown URLs fail the test loudly.
 */
function keysServer({
  license = () => jsonResponse({ license: licenseBody() }),
  // No `license` by default, like an SSO from before licensing: tests that
  // care about what model-key reports say so.
  modelKey = () => jsonResponse({
    key: 'sk-current-secret',
    base_url: CONFIG.litellmBaseUrl,
    models: ['model-a'],
    default_model: 'model-a',
    status: 'reused',
  }),
  models = () => jsonResponse({ data: [{ id: 'model-a' }] }),
} = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, init });
    if (href === LICENSE_URL) return license(init);
    if (href === MODEL_KEY_URL) return modelKey(init);
    if (href === MODELS_URL) return models(init);
    throw new Error(`unexpected fetch: ${href}`);
  };
  return {
    calls,
    fetchImpl,
    count: (url) => calls.filter((call) => call.url === url).length,
  };
}

/** `promise`'s value, or a test failure once `rounds` turns pass first: a regression must fail, not hang. */
async function settles(promise, label, rounds = 200) {
  let outcome = null;
  promise.then((value) => { outcome = { value }; }, (error) => { outcome = { error }; });
  for (let i = 0; i < rounds && !outcome; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  if (!outcome) assert.fail(`did not settle: ${label}`);
  if (outcome.error) throw outcome.error;
  return outcome.value;
}

async function until(predicate, label, rounds = 100) {
  for (let i = 0; i < rounds; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(`timed out waiting for: ${label}`);
}

function storedLicense(values, subject = 'user-123') {
  return values[AGENTX_LICENSE_STORAGE_KEY]?.records?.find((record) => record.subject === subject) || null;
}

function fakeBanner() {
  const root = fakeElement('div');
  root.classList.add('hidden');
  root.dataset = {};
  const text = fakeElement('span');
  const dismiss = fakeElement('button');
  dismiss.classList.add('hidden');
  const selectors = {
    '[data-agentx-license-banner-text]': text,
    '[data-agentx-license-banner-dismiss]': dismiss,
  };
  root.querySelector = (selector) => selectors[selector] || null;
  return { root, text, dismiss };
}

test('normalizeLicense keeps the contract fields and refuses what cannot be a license', () => {
  const license = normalizeLicense(licenseBody({ notice: 'expiring', reminder: 7, days_left: 7 }));
  assert.equal(license.state, 'active');
  assert.equal(license.access, 'full');
  assert.equal(license.enforced, true);
  assert.equal(license.notice, 'expiring');
  assert.deepEqual(license.plan, { slug: 'pilot-2026', name: 'Pilot nội bộ 2026' });
  assert.deepEqual(license.products, ['workmate', 'webmate', 'chat']);
  assert.equal(license.last_day, '2026-12-31');
  assert.equal(license.read_only_from, '2027-01-08');
  assert.equal(license.ends_at, '2026-12-31T17:00:00+00:00');
  assert.equal(license.days_left, 7);
  assert.equal(license.reminder, 7);
  assert.deepEqual(license.warn_days, [14, 7, 1]);
  assert.equal(license.contact, 'it@astralx.com.vn');

  // `access` is the blocking signal: without a valid one there is no license.
  for (const broken of [
    null, 'license', [], {}, licenseBody({ access: 'admin' }), licenseBody({ access: undefined }),
    licenseBody({ state: '' }), licenseBody({ state: 'Not A State!' }),
  ]) {
    assert.equal(normalizeLicense(broken), null, JSON.stringify(broken));
  }
  // A state this build does not know is kept; access still decides.
  assert.equal(normalizeLicense(licenseBody({ state: 'suspended', access: 'read_only' })).state, 'suspended');
  // While not enforced, nothing nags — even a notice sent by mistake.
  assert.equal(normalizeLicense(licenseBody({ enforced: false, notice: 'grace' })).notice, null);
  // Display dates must be real calendar days; counts must be whole and non-negative.
  const odd = normalizeLicense(licenseBody({
    last_day: '2026-02-30', starts_on: '31/12/2026', ends_at: 'soon', days_left: -2, reminder: 1.5,
    plan: { slug: 'only-slug' }, contact: 42,
  }));
  assert.equal(odd.last_day, null);
  assert.equal(odd.starts_on, null);
  assert.equal(odd.ends_at, null);
  assert.equal(odd.days_left, null);
  assert.equal(odd.reminder, null);
  assert.deepEqual(odd.plan, { slug: 'only-slug', name: 'only-slug' });
  assert.equal(odd.contact, '');
});

test('license copy says why in Vietnamese and English, with dd/MM/yyyy dates', () => {
  assert.equal(formatLicenseDay('2026-12-31', 'vi'), '31/12/2026');
  assert.equal(formatLicenseDay('2027-01-08', 'en'), '8 Jan 2027');
  assert.equal(formatLicenseDay(null, 'vi'), '');

  const expired = normalizeLicense(licenseBody(EXPIRED));
  const read = (overrides, locale = 'vi') => licenseReadOnlySentence(normalizeLicense(licenseBody({ ...EXPIRED, ...overrides })), locale);
  assert.equal(read({ state: 'none', plan: null }), 'Tài khoản chưa được cấp giấy phép AgentX.');
  assert.equal(read({ state: 'scheduled' }), 'Gói Pilot nội bộ 2026 bắt đầu từ ngày 15/10/2026.');
  assert.equal(read({}), 'Gói Pilot nội bộ 2026 đã hết hạn ngày 31/12/2026.');
  assert.equal(read({ state: 'revoked' }), 'Giấy phép AgentX của bạn đã bị thu hồi.');
  assert.equal(read({}, 'en'), 'The Pilot nội bộ 2026 plan expired on 31 Dec 2026.');
  assert.equal(read({ state: 'none', plan: null }, 'en'), 'This account has not been given an AgentX license.');
  assert.equal(read({ last_day: null }), 'Gói Pilot nội bộ 2026 đã hết hạn.');
  assert.equal(read({ state: 'suspended' }), 'Giấy phép AgentX hiện không cho phép dùng WebMate.');

  assert.equal(licenseReinstateSentence(expired, 'vi'), 'Liên hệ it@astralx.com.vn để được cấp lại hoặc gia hạn.');
  assert.equal(
    licenseReinstateSentence(normalizeLicense(licenseBody({ ...EXPIRED, contact: '' })), 'vi'),
    'Liên hệ quản trị viên để được cấp lại hoặc gia hạn.',
  );

  assert.equal(
    licenseNoticeSentence(normalizeLicense(licenseBody(GRACE)), 'vi'),
    'Gói Pilot nội bộ 2026 đã hết hạn ngày 31/12/2026. Từ ngày 08/01/2027, WebMate sẽ ngừng hoạt động '
      + 'cho đến khi được gia hạn. Liên hệ it@astralx.com.vn để gia hạn.',
  );
  assert.equal(
    licenseNoticeSentence(normalizeLicense(licenseBody(EXPIRING_7)), 'vi'),
    'Gói Pilot nội bộ 2026 hết hạn ngày 31/12/2026 (còn 7 ngày). Liên hệ it@astralx.com.vn để gia hạn.',
  );
  assert.equal(
    licenseNoticeSentence(normalizeLicense(licenseBody({ ...EXPIRING_7, days_left: 1, reminder: 1, contact: '' })), 'en'),
    'The Pilot nội bộ 2026 plan expires on 31 Dec 2026 (1 day left).',
  );
  // Nothing to warn about: active without a reminder, read-only (the gate
  // speaks then), or not enforced.
  assert.equal(licenseNoticeSentence(normalizeLicense(licenseBody()), 'vi'), '');
  assert.equal(licenseNoticeSentence(expired, 'vi'), '');
  assert.equal(licenseNoticeSentence(normalizeLicense(licenseBody({ ...GRACE, enforced: false })), 'vi'), '');

  const labels = ['active', 'grace', 'expired', 'revoked', 'scheduled', 'none']
    .map((state) => licenseStateLabel({ state }, 'vi'));
  assert.deepEqual(labels, ['Đang hiệu lực', 'Đang ân hạn', 'Đã hết hạn', 'Đã thu hồi', 'Chưa bắt đầu', 'Chưa được cấp']);
  assert.deepEqual(
    ['active', 'grace', 'expired', 'revoked', 'scheduled', 'none'].map((state) => licenseStateLabel({ state }, 'en')),
    ['Active', 'Grace period', 'Expired', 'Revoked', 'Not started', 'Not assigned'],
  );
});

test('a refusal without a license body still reads as read-only, and the bridge message says why', () => {
  assert.equal(licenseFromRefusal('license_required').state, 'none');
  assert.equal(licenseFromRefusal('license_expired').access, 'read_only');
  assert.equal(licenseFromRefusal('license_revoked').state, 'revoked');
  assert.equal(licenseFromRefusal('device_revoked'), null);
  const message = licenseRefusalMessage(normalizeLicense(licenseBody(EXPIRED)));
  assert.match(message, /read-only/);
  assert.match(message, /"Pilot nội bộ 2026" plan ended on 2026-12-31/);
  assert.match(message, /Contact it@astralx\.com\.vn/);
  assert.equal(
    expiringNoticeKey(normalizeLicense(licenseBody(EXPIRING_7))),
    'pilot-2026|2026-12-31|7',
  );
  assert.equal(expiringNoticeKey(normalizeLicense(licenseBody(GRACE))), '');
});

test('GET /v1/license carries the bearer and device, and is asked at most once per interval', async () => {
  const clock = { now: NOW };
  const fake = createApi({ [AGENTX_SESSION_STORAGE_KEY]: session({ lastActiveAt: NOW }) });
  const server = keysServer();
  const svc = createAgentXCloudService({
    api: fake.api, config: CONFIG, fetchImpl: server.fetchImpl, cryptoImpl: webcrypto, now: () => clock.now,
  });

  const first = await svc.refreshLicense();
  assert.equal(first.outcome, 'fetched');
  assert.equal(first.signedIn, true);
  assert.equal(first.subject, 'user-123');
  assert.equal(first.license.state, 'active');
  const [call] = server.calls;
  assert.equal(call.url, LICENSE_URL);
  assert.equal(call.init.method, undefined, 'a plain GET');
  assert.equal(call.init.headers.Authorization, `Bearer ${session().idToken}`);
  assert.match(call.init.headers['X-AgentX-Device'], /^[0-9a-f-]{36}$/);
  assert.equal(call.init.headers['X-AgentX-Device-Name'], 'AgentX WebMate macOS');
  assert.equal(storedLicense(fake.values).license.state, 'active');
  assert.equal(storedLicense(fake.values).checkedAt, NOW);

  clock.now = NOW + LICENSE_CHECK_INTERVAL_MS - 1;
  const cached = await svc.refreshLicense();
  assert.equal(cached.outcome, 'cached');
  assert.equal(server.count(LICENSE_URL), 1, 'inside the interval nothing goes to the network');

  const forced = await svc.refreshLicense({ force: true });
  assert.equal(forced.outcome, 'fetched');
  assert.equal(server.count(LICENSE_URL), 2, '"Kiểm tra lại" skips the wait');

  clock.now += LICENSE_CHECK_INTERVAL_MS;
  assert.equal((await svc.refreshLicense()).outcome, 'fetched');
  assert.equal(server.count(LICENSE_URL), 3);

  // Two askers at once share one request.
  clock.now += LICENSE_CHECK_INTERVAL_MS;
  const [a, b] = await Promise.all([svc.refreshLicense(), svc.refreshLicense({ force: true })]);
  assert.equal(server.count(LICENSE_URL), 4);
  assert.equal(a.outcome, 'fetched');
  assert.equal(b.outcome, 'fetched');

  // Signed out: no request, no license.
  const signedOut = service(createApi({}).api, server.fetchImpl);
  assert.deepEqual(
    { ...(await signedOut.refreshLicense()) },
    { signedIn: false, subject: '', license: null, outcome: 'signed-out', checkedAt: null, fetchedAt: null, expiringNoticeShown: '', warningCode: '' },
  );
  assert.equal(server.count(LICENSE_URL), 4);
});

test('an SSO without licensing (404 not_found) means no license, and forgets an old one', async () => {
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session({ lastActiveAt: NOW }),
    [AGENTX_LICENSE_STORAGE_KEY]: licenseRecord(licenseBody(EXPIRED), { checkedAt: NOW - LICENSE_CHECK_INTERVAL_MS }),
  });
  const server = keysServer({
    license: () => jsonResponse({ error: 'not_found', detail: "No route 'v1/license' here." }, 404),
  });
  const result = await service(fake.api, server.fetchImpl).refreshLicense();
  assert.equal(result.outcome, 'unsupported');
  assert.equal(result.license, null);
  assert.equal(storedLicense(fake.values).license, null);

  // A 404 that is not the keys service's own answer (an HTML error page) is
  // an outage, not an SSO without licensing: the last license stands.
  const proxied = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session({ lastActiveAt: NOW }),
    [AGENTX_LICENSE_STORAGE_KEY]: licenseRecord(licenseBody(EXPIRED), { checkedAt: NOW - LICENSE_CHECK_INTERVAL_MS }),
  });
  const html = await service(proxied.api, keysServer({
    license: () => new Response('<h1>Not Found</h1>', { status: 404 }),
  }).fetchImpl).refreshLicense();
  assert.equal(html.outcome, 'unavailable');
  assert.equal(html.license.state, 'expired');
});

test('a license outage keeps the last known license and never invents one', async () => {
  // Nothing known + outage = full access (no license).
  const fresh = createApi({ [AGENTX_SESSION_STORAGE_KEY]: session({ lastActiveAt: NOW }) });
  const down = await service(fresh.api, keysServer({
    license: () => jsonResponse({ error: 'store_unavailable' }, 503),
  }).fetchImpl).refreshLicense();
  assert.equal(down.outcome, 'unavailable');
  assert.equal(down.warningCode, 'store_unavailable');
  assert.equal(down.license, null);
  assert.equal(storedLicense(fresh.values).checkedAt, NOW, 'the attempt counts toward the interval');

  // Read-only known + network error / garbage / rejected bearer = still read-only.
  for (const [label, license] of [
    ['network', () => { throw new TypeError('Failed to fetch'); }],
    ['garbage', () => jsonResponse({ license: { state: 'expired' } })],
    ['401', () => jsonResponse({ error: 'invalid_token', detail: 'expired' }, 401)],
  ]) {
    const fake = createApi({
      [AGENTX_SESSION_STORAGE_KEY]: session({ lastActiveAt: NOW }),
      [AGENTX_LICENSE_STORAGE_KEY]: licenseRecord(licenseBody(EXPIRED), { checkedAt: NOW - LICENSE_CHECK_INTERVAL_MS }),
    });
    const result = await service(fake.api, keysServer({ license }).fetchImpl).refreshLicense();
    assert.equal(result.outcome, 'unavailable', label);
    assert.equal(result.license.access, 'read_only', `${label}: the last license stands`);
    // A license check never ends the session, whatever it is told.
    assert.equal(fake.values[AGENTX_SESSION_STORAGE_KEY].user.subject, 'user-123', label);
  }
});

test('a model-key license refusal is definitive: no stale-offline key, session kept, license recorded', async () => {
  const cached = credential();
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session(),
    [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [cached] },
  });
  // The gateway already blocks the key; the key service says why.
  const server = keysServer({
    models: () => jsonResponse({ error: { message: 'key blocked' } }, 401),
    modelKey: () => jsonResponse({
      error: 'license_expired',
      detail: "This account's AgentX license ended on 2026-12-31; AI is off until it is renewed.",
      license: licenseBody(EXPIRED),
    }, 403),
  });
  await assert.rejects(
    () => service(fake.api, server.fetchImpl).retryProvision(),
    (error) => {
      assert.equal(error.code, 'license_expired');
      assert.equal(error.status, 403);
      assert.equal(error.transient, false);
      assert.equal(error.license.state, 'expired');
      assert.equal(error.license.access, 'read_only');
      return true;
    },
  );
  assert.equal(fake.values[AGENTX_SESSION_STORAGE_KEY].user.subject, 'user-123', 'read-only stays signed in');
  assert.equal(storedLicense(fake.values).license.state, 'expired');
  assert.equal(fake.values[AGENTX_CREDENTIAL_STORAGE_KEY].records[0].key, cached.key, 'the key is not deleted');

  // Each refusal code, with or without a license object, is just as final.
  for (const code of ['license_required', 'license_expired', 'license_revoked']) {
    const other = createApi({
      [AGENTX_SESSION_STORAGE_KEY]: session(),
      [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [credential()] },
    });
    await assert.rejects(
      () => service(other.api, keysServer({
        models: () => jsonResponse({ error: 'blocked' }, 401),
        modelKey: () => jsonResponse({ error: code, detail: 'refused' }, 403),
      }).fetchImpl).retryProvision(),
      (error) => error.code === code && error.license?.access === 'read_only',
    );
    assert.equal(storedLicense(other.values).license.access, 'read_only', code);
  }
});

test('a cached key whose grant changed does not paper over a license refusal', async () => {
  // LiteLLM has not blocked the key yet, but it now reaches something new, so
  // the key service is asked — and says read-only.
  const cached = credential({ serviceModels: ['model-a'], featureModels: [], reachableModels: ['model-a'] });
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session(),
    [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [cached] },
  });
  const server = keysServer({
    models: () => jsonResponse({ data: [{ id: 'model-a' }, { id: 'model-new' }] }),
    modelKey: () => jsonResponse({ error: 'license_revoked', detail: 'revoked', license: licenseBody({ ...EXPIRED, state: 'revoked' }) }, 403),
  });
  await assert.rejects(
    () => service(fake.api, server.fetchImpl).retryProvision(),
    (error) => error.code === 'license_revoked',
  );
});

test('model-key records the license it carries; an SSO without licensing changes nothing', async () => {
  const fake = createApi({ [AGENTX_SESSION_STORAGE_KEY]: session() });
  const result = await service(fake.api, keysServer({
    modelKey: () => jsonResponse({
      key: 'sk-new', base_url: CONFIG.litellmBaseUrl, models: ['model-a'], default_model: 'model-a',
      status: 'created', license: licenseBody(GRACE),
    }),
  }).fetchImpl).retryProvision();
  assert.equal(result.credential.key, 'sk-new');
  assert.equal(storedLicense(fake.values).license.state, 'grace');

  const old = createApi({ [AGENTX_SESSION_STORAGE_KEY]: session() });
  const legacy = await service(old.api, keysServer({
    modelKey: () => jsonResponse({
      key: 'sk-old-sso', base_url: CONFIG.litellmBaseUrl, models: ['model-a'], default_model: 'model-a', status: 'created',
    }),
  }).fetchImpl).retryProvision();
  assert.equal(legacy.credential.key, 'sk-old-sso');
  assert.equal(old.values[AGENTX_LICENSE_STORAGE_KEY], undefined, 'nothing to record, nothing recorded');
});

test('sign-out forgets the account license and keeps everyone else’s', async () => {
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session(),
    [AGENTX_LICENSE_STORAGE_KEY]: {
      version: 1,
      records: [
        { subject: 'user-123', license: normalizeLicense(licenseBody(EXPIRED)), checkedAt: NOW },
        { subject: 'other-user', license: normalizeLicense(licenseBody()), checkedAt: NOW },
      ],
    },
  });
  await service(fake.api, async () => new Response(null, { status: 204 })).signOut();
  assert.deepEqual(fake.values[AGENTX_LICENSE_STORAGE_KEY].records.map((record) => record.subject), ['other-user']);
});

test('a Workmate run is refused while the account is read-only, and only then', async () => {
  const clock = { now: NOW };
  const build = (seed, server) => {
    const fake = createApi(seed);
    const svc = createAgentXCloudService({
      api: fake.api, config: CONFIG, fetchImpl: server.fetchImpl, cryptoImpl: webcrypto, now: () => clock.now,
    });
    return { fake, svc, gate: () => svc.licenseRunRefusal() };
  };
  const signedIn = { [AGENTX_SESSION_STORAGE_KEY]: session({ lastActiveAt: NOW }) };

  // Read-only and checked moments ago: refused at once, without the network.
  const readOnlyServer = keysServer({ license: () => jsonResponse({ license: licenseBody(EXPIRED) }) });
  const readOnly = build({ ...signedIn, [AGENTX_LICENSE_STORAGE_KEY]: licenseRecord(licenseBody(EXPIRED)) }, readOnlyServer);
  const refusal = await readOnly.gate();
  assert.equal(refusal.code, LICENSE_READ_ONLY_CODE);
  assert.equal(refusal.code, 'license_read_only');
  assert.equal(refusal.status, 403);
  assert.equal(refusal.license.state, 'expired');
  assert.match(refusal.message, /read-only/);
  assert.equal(readOnlyServer.count(LICENSE_URL), 0);

  // Read-only but last checked long ago, and renewed since: the run goes.
  const renewedServer = keysServer();
  const renewed = build({
    ...signedIn,
    [AGENTX_LICENSE_STORAGE_KEY]: licenseRecord(licenseBody(EXPIRED), { checkedAt: NOW - LICENSE_CHECK_INTERVAL_MS }),
  }, renewedServer);
  assert.equal(await renewed.gate(), null);
  assert.equal(renewedServer.count(LICENSE_URL), 1, 'confirmed before refusing');

  // Read-only, stale, and the license service is down: the last answer stands.
  const outage = build({
    ...signedIn,
    [AGENTX_LICENSE_STORAGE_KEY]: licenseRecord(licenseBody(EXPIRED), { checkedAt: NOW - LICENSE_CHECK_INTERVAL_MS }),
  }, keysServer({ license: () => jsonResponse({ error: 'store_unavailable' }, 503) }));
  assert.equal((await outage.gate()).code, 'license_read_only');

  // Full (or nothing known): never waits on the network; re-checks behind the run.
  let release;
  const slowServer = keysServer({
    license: () => new Promise((resolve) => { release = () => resolve(jsonResponse({ license: licenseBody(EXPIRED) })); }),
  });
  const full = build({
    ...signedIn,
    [AGENTX_LICENSE_STORAGE_KEY]: licenseRecord(licenseBody(), { checkedAt: NOW - LICENSE_CHECK_INTERVAL_MS }),
  }, slowServer);
  assert.equal(await full.gate(), null, 'answered while the license request is still open');
  await flushMicrotasks();
  release();
  await flushMicrotasks();
  assert.equal(storedLicense(full.fake.values).license.access, 'read_only', 'the next run will know');
  assert.equal((await full.gate()).code, 'license_read_only');

  // Signed out: the run is not the license's to stop.
  assert.equal(await build({ [AGENTX_LICENSE_STORAGE_KEY]: licenseRecord(licenseBody(EXPIRED)) }, keysServer()).gate(), null);
});

// ─── License in the side panel ────────────────────────────────────────────

function licenseGate({ seed, server, clock = { now: NOW }, gateOptions = {} } = {}) {
  const banner = fakeBanner();
  const harness = gateHarness({
    clock,
    seed,
    fetchImpl: server.fetchImpl,
    gateOptions: { bannerRoot: banner.root, ...gateOptions },
  });
  return { ...harness, banner, clock };
}

const SIGNED_IN_WITH_KEY = () => ({
  [AGENTX_SESSION_STORAGE_KEY]: session({ lastActiveAt: NOW }),
  [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [credential()] },
});

test('a read-only license locks the panel on the license screen: why, whom to ask, Kiểm tra lại', async () => {
  const server = keysServer({ license: () => jsonResponse({ license: licenseBody(EXPIRED) }) });
  const harness = licenseGate({
    server,
    seed: { ...SIGNED_IN_WITH_KEY(), [AGENTX_LICENSE_STORAGE_KEY]: licenseRecord(licenseBody(EXPIRED)) },
  });
  const pending = harness.gate.start();
  await flushMicrotasks(6);
  const settled = await Promise.race([pending.then(() => 'unlocked'), flushMicrotasks().then(() => 'still-locked')]);
  harness.gate.stop();

  assert.equal(settled, 'still-locked');
  assert.equal(harness.gate.isLocked(), true);
  assert.equal(harness.gate.mode(), 'license');
  assert.equal(harness.dom.appRoot.inert, true);
  assert.equal(harness.dom.parts.title.textContent, 'Giấy phép AgentX');
  assert.equal(
    harness.dom.parts.body.textContent,
    'Gói Pilot nội bộ 2026 đã hết hạn ngày 31/12/2026. Liên hệ it@astralx.com.vn để được cấp lại hoặc gia hạn.',
  );
  assert.equal(harness.dom.parts.signin.textContent, 'Kiểm tra lại');
  assert.equal(harness.dom.parts.signin.classList.contains('hidden'), false);
  assert.equal(harness.dom.parts.settings.classList.contains('hidden'), false, 'Settings (plan, sign-out) stays reachable');
  assert.equal(harness.dom.parts.notice.classList.contains('hidden'), true);
  assert.equal(harness.banner.root.classList.contains('hidden'), true);
  // Known read-only and checked moments ago: no gateway probe, no key request, no install.
  assert.equal(server.calls.length, 0);
  assert.equal(harness.calls.some((call) => call.action === 'update_provider'), false);
});

test('Kiểm tra lại says when nothing changed or the check failed, and unlocks once renewed', async () => {
  let answer = () => jsonResponse({ license: licenseBody(EXPIRED) });
  const server = keysServer({ license: () => answer() });
  const harness = licenseGate({
    server,
    seed: { ...SIGNED_IN_WITH_KEY(), [AGENTX_LICENSE_STORAGE_KEY]: licenseRecord(licenseBody(EXPIRED)) },
  });
  const pending = harness.gate.start();
  await flushMicrotasks(6);
  assert.equal(harness.gate.mode(), 'license');

  harness.dom.parts.signin.emit('click');
  await flushMicrotasks(6);
  assert.equal(server.count(LICENSE_URL), 1, 'the button asks now, whatever the interval says');
  assert.equal(harness.dom.parts.notice.textContent, 'Đã kiểm tra lại: giấy phép vẫn chưa cho phép dùng WebMate.');
  assert.equal(harness.gate.isLocked(), true);

  answer = () => jsonResponse({ error: 'store_unavailable' }, 503);
  harness.dom.parts.signin.emit('click');
  await flushMicrotasks(6);
  assert.equal(harness.dom.parts.notice.textContent, 'Chưa kiểm tra được giấy phép lúc này. Hãy thử lại sau ít phút.');
  assert.equal(harness.gate.isLocked(), true, 'an outage keeps the last license');

  answer = () => jsonResponse({ license: licenseBody() });
  harness.dom.parts.signin.emit('click');
  await settles(pending, 'the panel to unlock');
  harness.gate.stop();
  assert.equal(harness.gate.isLocked(), false);
  assert.equal(harness.gate.mode(), 'auth');
  assert.equal(harness.providerState.active, 'webbrain_cloud');
  assert.equal(storedLicense(harness.values).license.state, 'active');
});

test('a model-key license refusal opens the license screen and keeps the user signed in', async () => {
  const server = keysServer({
    license: () => jsonResponse({ error: 'store_unavailable' }, 503),
    modelKey: () => jsonResponse({ error: 'license_revoked', detail: 'revoked', license: licenseBody({ ...EXPIRED, state: 'revoked', contact: '' }) }, 403),
  });
  const harness = licenseGate({ server, seed: { [AGENTX_SESSION_STORAGE_KEY]: session({ lastActiveAt: NOW }) } });
  harness.gate.start();
  await flushMicrotasks(8);
  harness.gate.stop();
  assert.equal(harness.gate.mode(), 'license');
  assert.equal(harness.gate.isLocked(), true);
  assert.equal(
    harness.dom.parts.body.textContent,
    'Giấy phép AgentX của bạn đã bị thu hồi. Liên hệ quản trị viên để được cấp lại hoặc gia hạn.',
  );
  assert.equal(harness.values[AGENTX_SESSION_STORAGE_KEY].user.subject, 'user-123');
  assert.equal(harness.calls.some((call) => call.action === 'update_provider'), false);
});

test('an unlocked panel locks when its poll learns the account went read-only', async () => {
  let answer = () => jsonResponse({ license: licenseBody() });
  const server = keysServer({ license: () => answer() });
  const harness = licenseGate({ server, seed: SIGNED_IN_WITH_KEY() });
  await settles(harness.gate.start(), 'the panel to unlock');
  assert.equal(harness.gate.isLocked(), false);
  assert.equal(server.count(LICENSE_URL), 1, 'asked on open');

  // Within the interval the poll reads storage only.
  answer = () => jsonResponse({ license: licenseBody(EXPIRED) });
  harness.clock.now = NOW + 60_000;
  await harness.gate.checkSession();
  assert.equal(server.count(LICENSE_URL), 1);
  assert.equal(harness.gate.isLocked(), false);

  harness.clock.now = NOW + LICENSE_CHECK_INTERVAL_MS + 1;
  await harness.gate.checkSession();
  await flushMicrotasks();
  harness.gate.stop();
  assert.equal(server.count(LICENSE_URL), 2);
  assert.equal(harness.gate.isLocked(), true);
  assert.equal(harness.gate.mode(), 'license');
  assert.equal(harness.dom.appRoot.inert, true);
  assert.match(harness.dom.parts.body.textContent, /đã hết hạn ngày 31\/12\/2026/);
});

test('a slow license answer does not hold the panel, but still locks it when it arrives', async () => {
  const timers = manualTimers();
  let release;
  const server = keysServer({
    license: () => new Promise((resolve) => { release = () => resolve(jsonResponse({ license: licenseBody(EXPIRED) })); }),
  });
  const harness = licenseGate({
    server,
    seed: SIGNED_IN_WITH_KEY(),
    gateOptions: { licenseGraceMs: 1_500, setTimeoutImpl: timers.setTimeout, clearTimeoutImpl: timers.clearTimeout },
  });
  const pending = harness.gate.start();
  await flushMicrotasks(8);
  assert.equal(harness.gate.isLocked(), true, 'waits out the grace first');
  timers.fire((timer) => timer.ms === 1_500);
  await settles(pending, 'the panel to unlock');
  assert.equal(harness.gate.isLocked(), false, 'a keys outage costs a blink, not the panel');

  release();
  await flushMicrotasks(6);
  harness.gate.stop();
  assert.equal(harness.gate.isLocked(), true);
  assert.equal(harness.gate.mode(), 'license');
});

test('the grace warning stays; the reminder before the last day shows once per reminder', async () => {
  // Grace: always, never dismissible.
  const grace = licenseGate({ server: keysServer({ license: () => jsonResponse({ license: licenseBody(GRACE) }) }), seed: SIGNED_IN_WITH_KEY() });
  await settles(grace.gate.start(), 'the panel to unlock');
  grace.gate.stop();
  assert.equal(grace.banner.root.classList.contains('hidden'), false);
  assert.equal(grace.banner.dismiss.classList.contains('hidden'), true);
  assert.equal(grace.banner.root.dataset.kind, 'grace');
  assert.match(grace.banner.text.textContent, /^Gói Pilot nội bộ 2026 đã hết hạn ngày 31\/12\/2026\. Từ ngày 08\/01\/2027/);

  // Expiring: shown, dismissible, remembered as shown.
  const seed = SIGNED_IN_WITH_KEY();
  const first = licenseGate({ server: keysServer({ license: () => jsonResponse({ license: licenseBody(EXPIRING_7) }) }), seed });
  await settles(first.gate.start(), 'the panel to unlock');
  assert.equal(first.banner.root.classList.contains('hidden'), false);
  assert.equal(first.banner.dismiss.classList.contains('hidden'), false);
  assert.equal(
    first.banner.text.textContent,
    'Gói Pilot nội bộ 2026 hết hạn ngày 31/12/2026 (còn 7 ngày). Liên hệ it@astralx.com.vn để gia hạn.',
  );
  await flushMicrotasks();
  assert.equal(storedLicense(first.values).expiringNoticeShown, 'pilot-2026|2026-12-31|7');
  first.banner.dismiss.emit('click');
  first.gate.stop();
  assert.equal(first.banner.root.classList.contains('hidden'), true);

  // The next panel, same reminder: not again.
  const second = licenseGate({ server: keysServer(), seed: structuredClone(first.values) });
  await settles(second.gate.start(), 'the panel to unlock');
  second.gate.stop();
  assert.equal(second.banner.root.classList.contains('hidden'), true);

  // A new threshold (1 day left) is a new reminder.
  const later = { ...structuredClone(first.values) };
  later[AGENTX_LICENSE_STORAGE_KEY].records[0].license = normalizeLicense(licenseBody({ notice: 'expiring', days_left: 1, reminder: 1 }));
  const third = licenseGate({ server: keysServer(), seed: later });
  await settles(third.gate.start(), 'the panel to unlock');
  third.gate.stop();
  assert.equal(third.banner.root.classList.contains('hidden'), false);
  assert.match(third.banner.text.textContent, /\(còn 1 ngày\)/);

  // Not enforced: plan info only, never a banner.
  const off = licenseGate({
    server: keysServer({ license: () => jsonResponse({ license: licenseBody({ ...GRACE, enforced: false }) }) }),
    seed: SIGNED_IN_WITH_KEY(),
  });
  await settles(off.gate.start(), 'the panel to unlock');
  off.gate.stop();
  assert.equal(off.banner.root.classList.contains('hidden'), true);
});

test('an SSO without licensing leaves the panel exactly as before', async () => {
  const server = keysServer({ license: () => jsonResponse({ error: 'not_found', detail: 'No route' }, 404) });
  const harness = licenseGate({ server, seed: SIGNED_IN_WITH_KEY() });
  await settles(harness.gate.start(), 'the panel to unlock');
  harness.gate.stop();
  assert.equal(harness.gate.isLocked(), false);
  assert.equal(harness.gate.mode(), 'auth');
  assert.equal(harness.banner.root.classList.contains('hidden'), true);
  assert.equal(harness.providerState.active, 'webbrain_cloud');
});

test('the license screen ignores its own session writes and follows the license record', async () => {
  const server = keysServer({ license: () => jsonResponse({ license: licenseBody(EXPIRED) }) });
  const harness = licenseGate({
    server,
    seed: { ...SIGNED_IN_WITH_KEY(), [AGENTX_LICENSE_STORAGE_KEY]: licenseRecord(licenseBody(EXPIRED)) },
  });
  const pending = harness.gate.start();
  await flushMicrotasks(6);
  assert.equal(harness.gate.mode(), 'license');
  harness.dom.parts.signin.emit('click');
  await flushMicrotasks(6);
  const checked = 'Đã kiểm tra lại: giấy phép vẫn chưa cho phép dùng WebMate.';
  assert.equal(harness.dom.parts.notice.textContent, checked);
  assert.equal(server.count(LICENSE_URL), 1);

  // Activity stamps and token refreshes rewrite the same account's session
  // record all the time; none of it may restart the gate (and wipe what the
  // person was just told), let alone provision.
  for (let i = 0; i < 3; i++) {
    harness.storageChanged.emit(
      { [AGENTX_SESSION_STORAGE_KEY]: { oldValue: {}, newValue: harness.values[AGENTX_SESSION_STORAGE_KEY] } },
      'local',
    );
  }
  // …nor may the echo of this panel's own license write.
  harness.storageChanged.emit(
    { [AGENTX_LICENSE_STORAGE_KEY]: { newValue: harness.values[AGENTX_LICENSE_STORAGE_KEY] } },
    'local',
  );
  await flushMicrotasks(6);
  assert.equal(harness.gate.mode(), 'license');
  assert.equal(harness.dom.parts.notice.textContent, checked);
  assert.equal(harness.dom.parts.busy.classList.contains('hidden'), true);
  assert.equal(server.count(LICENSE_URL), 1);
  assert.equal(server.count(MODELS_URL) + server.count(MODEL_KEY_URL), 0);

  // Another document (Settings, a Workmate run) records the renewal.
  harness.values[AGENTX_LICENSE_STORAGE_KEY] = licenseRecord(licenseBody());
  harness.storageChanged.emit(
    { [AGENTX_LICENSE_STORAGE_KEY]: { newValue: harness.values[AGENTX_LICENSE_STORAGE_KEY] } },
    'local',
  );
  await settles(pending, 'the panel to unlock');
  harness.gate.stop();
  assert.equal(harness.gate.isLocked(), false);
  assert.equal(harness.gate.mode(), 'auth');
});

test('signing out elsewhere takes the license screen back to sign-in', async () => {
  const harness = licenseGate({
    server: keysServer(),
    seed: { ...SIGNED_IN_WITH_KEY(), [AGENTX_LICENSE_STORAGE_KEY]: licenseRecord(licenseBody(EXPIRED)) },
  });
  harness.gate.start();
  await flushMicrotasks(6);
  assert.equal(harness.gate.mode(), 'license');
  delete harness.values[AGENTX_SESSION_STORAGE_KEY];
  harness.storageChanged.emit({ [AGENTX_SESSION_STORAGE_KEY]: { oldValue: {}, newValue: undefined } }, 'local');
  await flushMicrotasks(6);
  harness.gate.stop();
  assert.equal(harness.gate.mode(), 'auth');
  assert.equal(harness.gate.isLocked(), true);
  assert.equal(harness.dom.parts.signin.textContent, 'Thử lại');
  assert.match(harness.dom.parts.notice.textContent, /đăng xuất/);
});

// ─── License in Settings ──────────────────────────────────────────────────

test('the Settings card shows plan, state, last day and contact — enforced or not', () => {
  const base = {
    signedIn: true,
    connected: true,
    user: { email: 'kien@example.test', displayName: 'Kien' },
    provider: { model: 'model-a', models: ['model-a'], baseUrl: CONFIG.litellmBaseUrl },
  };
  const quiet = renderAgentXCloudPanel({ ...base, license: normalizeLicense(licenseBody({ enforced: false })) }, 'vi');
  assert.match(quiet, /data-agentx-license/);
  assert.match(quiet, /Giấy phép AgentX/);
  assert.match(quiet, /Pilot nội bộ 2026/);
  assert.match(quiet, /Đang hiệu lực/);
  assert.match(quiet, /Ngày cuối/);
  assert.match(quiet, /31\/12\/2026/);
  assert.match(quiet, /it@astralx\.com\.vn/);
  assert.doesNotMatch(quiet, /agentx-cloud-notice-warning|agentx-cloud-notice-error/, 'not enforced: no warning');

  const grace = renderAgentXCloudPanel({ ...base, license: normalizeLicense(licenseBody(GRACE)) }, 'en');
  assert.match(grace, /AgentX license/);
  assert.match(grace, /Grace period/);
  assert.match(grace, /Last day/);
  assert.match(grace, /31 Dec 2026/);
  assert.match(grace, /agentx-cloud-notice-warning/);
  assert.match(grace, /From 8 Jan 2027, WebMate will stop working until it is renewed\./);

  const scheduled = renderAgentXCloudPanel({
    ...base, connected: false, license: normalizeLicense(licenseBody({ ...EXPIRED, state: 'scheduled' })),
  }, 'vi');
  assert.match(scheduled, /Bắt đầu/);
  assert.match(scheduled, /15\/10\/2026/);

  // Nothing known (an SSO without licensing): the card is what it always was.
  const legacy = renderAgentXCloudPanel({ ...base, license: null }, 'vi');
  assert.doesNotMatch(legacy, /data-agentx-license|Giấy phép AgentX/);
});

test('a read-only account in Settings sees why and can check again', () => {
  const markup = renderAgentXCloudPanel({
    signedIn: true,
    connected: false,
    user: { email: 'kien@example.test', displayName: 'Kien' },
    license: normalizeLicense(licenseBody(EXPIRED)),
    error: { code: 'license_expired', message: 'refused' },
  }, 'vi');
  assert.match(markup, /Gói Pilot nội bộ 2026 đã hết hạn ngày 31\/12\/2026\. Liên hệ it@astralx\.com\.vn để được cấp lại hoặc gia hạn\./);
  assert.match(markup, /data-agentx-cloud-action="retry"[^>]*>Kiểm tra lại</);
  assert.match(markup, /Đã hết hạn/);
  assert.doesNotMatch(markup, /Còn một bước nữa/, 'read-only is not one step from connected');
  assert.doesNotMatch(markup, /Giấy phép AgentX của tài khoản này đã hết hạn/, 'the refusal is not said twice');
  // Without a license object (should not happen) the code still reads.
  const bare = renderAgentXCloudPanel({
    signedIn: true, connected: false, user: { email: 'k@example.test' }, error: { code: 'license_revoked' },
  }, 'vi');
  assert.match(bare, /Giấy phép AgentX của tài khoản này đã bị thu hồi\./);
});

test('the Settings controller reports a license refusal and re-checks the license on retry', async () => {
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session(),
    [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [credential()] },
  });
  let refuse = true;
  const server = keysServer({
    models: () => (refuse ? jsonResponse({ error: 'blocked' }, 401) : jsonResponse({ data: [{ id: 'model-a' }] })),
    modelKey: () => (refuse
      ? jsonResponse({ error: 'license_expired', detail: 'ended', license: licenseBody(EXPIRED) }, 403)
      : jsonResponse({ key: 'sk-renewed', base_url: CONFIG.litellmBaseUrl, models: ['model-a'], default_model: 'model-a', status: 'reused', license: licenseBody() })),
    license: () => jsonResponse({ license: refuse ? licenseBody(EXPIRED) : licenseBody() }),
  });
  const providerState = { providers: { webbrain_cloud: { type: 'openai', category: 'cloud' } }, active: 'openai' };
  const controller = createAgentXCloudSettingsController({
    api: fake.api,
    locale: () => 'vi',
    config: CONFIG,
    sendToBackground: async (action, data = {}) => {
      if (action === 'update_provider') {
        Object.assign(providerState.providers.webbrain_cloud, data.config);
        return { ok: true };
      }
      if (action === 'get_providers') return structuredClone(providerState);
      if (action === 'set_active_provider') return { ok: true };
      throw new Error(`Unexpected background action: ${action}`);
    },
    serviceOptions: { fetchImpl: server.fetchImpl, cryptoImpl: webcrypto, now: () => NOW },
  });
  await controller.initialize();
  let status = controller.status();
  assert.equal(status.signedIn, true);
  assert.equal(status.connected, false);
  assert.equal(status.error.code, 'license_expired');
  assert.equal(status.license.state, 'expired');
  assert.match(controller.render(), /Kiểm tra lại/);

  // The license is renewed; "Kiểm tra lại" is the card's retry button.
  refuse = false;
  const before = server.count(LICENSE_URL);
  const button = fakeElement('button');
  button.dataset = { agentxCloudAction: 'retry' };
  controller.bind({ querySelectorAll: () => [button], querySelector: () => null });
  button.emit('click');
  await until(() => controller.status().action === null && controller.status().connected, 'retry to finish');
  status = controller.status();
  assert.equal(status.error, null);
  assert.equal(status.license.state, 'active');
  assert.equal(server.count(LICENSE_URL), before + 1, 'retry asks for the license now, not within the interval');
  assert.equal(providerState.providers.webbrain_cloud.apiKey, 'sk-renewed');
  assert.doesNotMatch(controller.render(), /Kiểm tra lại/);
});

test('both branded targets carry the license banner under the panel header', async () => {
  for (const target of ['chrome', 'firefox']) {
    const root = path.join(ROOT, 'brand-dist', target);
    const sidepanelHtml = await fs.readFile(path.join(root, 'src/ui/sidepanel.html'), 'utf8');
    assert.match(sidepanelHtml, /id="agentx-license-banner" class="agentx-license-banner hidden" role="status"/);
    assert.match(sidepanelHtml, /data-agentx-license-banner-dismiss/);
    assert.ok(
      sidepanelHtml.indexOf('id="agentx-license-banner"') > sidepanelHtml.indexOf('</header>'),
      `${target}: the banner sits under the header`,
    );
    const css = await fs.readFile(path.join(root, 'src/ui/agentx-login-gate.css'), 'utf8');
    assert.match(css, /\.agentx-license-banner\.hidden/);
  }
});

// ─── License and Workmate-driven runs ─────────────────────────────────────

test('the background run gate asks the license service and fails open', async () => {
  const refusal = { status: 403, code: 'license_read_only', message: 'read-only', license: { access: 'read_only' } };
  const asked = [];
  const gate = createAgentXLicenseRunGate({ api: {}, service: { licenseRunRefusal: async () => { asked.push(1); return refusal; } } });
  assert.equal(await gate(), refusal);
  assert.equal(asked.length, 1);
  // A service that throws, or cannot even be built: the run is not the gate's to stop.
  const broken = createAgentXLicenseRunGate({ api: {}, service: { licenseRunRefusal: async () => { throw new Error('boom'); } } });
  assert.equal(await broken(), null);
  const unbuildable = createAgentXLicenseRunGate({ api: {} });
  assert.equal(await unbuildable(), null, 'no extension API: fail open');
});

test('only the Chrome background gates bridge runs on the license, and forwards the refusal', async () => {
  const chromeBackground = await fs.readFile(path.join(CHROME_ROOT, 'src/background.js'), 'utf8');
  assert.match(chromeBackground, /import \{ createAgentXLicenseRunGate \} from '\.\/agentx\/license-run-gate\.js';/);
  assert.match(chromeBackground, /runGate: createAgentXLicenseRunGate\(\{ api: chrome \}\)/);
  assert.match(chromeBackground, /typeof e\.code === 'string' && e\.code \? \{ code: e\.code \} : \{\}/);
  assert.match(chromeBackground, /e\.license && typeof e\.license === 'object' \? \{ license: e\.license \} : \{\}/);
  const firefoxBackground = await fs.readFile(path.join(ROOT, 'brand-dist/firefox/src/background.js'), 'utf8');
  assert.doesNotMatch(firefoxBackground, /runGate|license-run-gate/, 'Firefox has no cloud bridge to gate');
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`✗ ${name}`);
    console.error(error?.stack || error);
  }
}
console.log(`\nAgentX auth: ${tests.length - failed}/${tests.length} passed`);
if (failed) process.exitCode = 1;
