import { AGENTX_RUNTIME_CONFIG } from './runtime-config.js';
import {
  chatModelsFromGrant,
  featureModelsFromKey,
  gatewayCatalogFromPayload,
  normalizeGatewayModels,
  pickGatewayModel,
  pickGatewayTranscriptionModel,
  pickGatewayVisionModel,
  transcriptionModelsFromGateway,
  visionModelsForGrant,
} from './cloud-models.js';

export const AGENTX_SESSION_STORAGE_KEY = 'agentxAuthSessionV1';
export const AGENTX_DEVICE_STORAGE_KEY = 'agentxDeviceIdentityV1';
export const AGENTX_CREDENTIAL_STORAGE_KEY = 'agentxModelCredentialsV1';

const DEVICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REFRESH_AHEAD_MS = 60_000;
// Writing lastActiveAt on every keystroke would hammer storage. One write per
// minute is far finer-grained than the multi-hour idle window it feeds.
const ACTIVITY_WRITE_INTERVAL_MS = 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 12 * 60 * 60_000;
const MODEL_PROBE_TIMEOUT_MS = 8_000;
const MAX_CACHED_ACCOUNTS = 8;

export class AgentXCloudError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AgentXCloudError';
    this.code = code || 'unknown_error';
    this.status = Number(options.status) || 0;
    this.detail = options.detail || message;
    this.transient = options.transient === true;
  }
}

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

export function normalizeHttpsBaseUrl(value, label = 'URL', { openAiCompatible = false } = {}) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new AgentXCloudError('invalid_configuration', `${label} phải là URL HTTPS tuyệt đối.`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new AgentXCloudError(
      'invalid_configuration',
      `${label} phải là URL HTTPS không chứa thông tin xác thực, query hoặc fragment.`,
    );
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = openAiCompatible && !/\/v1$/i.test(pathname)
    ? `${pathname}/v1`
    : (pathname || '/');
  return stripTrailingSlash(url.toString());
}

function isSecureEndpoint(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function sameIssuer(left, right) {
  return stripTrailingSlash(left) === stripTrailingSlash(right);
}

function base64UrlToBytes(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new AgentXCloudError('invalid_token', 'ID token không có payload base64url hợp lệ.');
  }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) {
    throw new AgentXCloudError('invalid_token', 'ID token không có cấu trúc JWT hợp lệ.');
  }
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[1])));
  } catch (error) {
    if (error instanceof AgentXCloudError) throw error;
    throw new AgentXCloudError('invalid_token', 'Không đọc được payload của ID token.');
  }
}

function tokenAudienceMatches(audience, clientId) {
  return Array.isArray(audience)
    ? audience.includes(clientId)
    : String(audience || '') === clientId;
}

function validateIdTokenClaims(claims, oidc, { nonce = null, now = Date.now() } = {}) {
  if (!claims || typeof claims !== 'object') {
    throw new AgentXCloudError('invalid_token', 'ID token không có claims hợp lệ.');
  }
  if (!claims.sub || !Number.isFinite(Number(claims.exp))) {
    throw new AgentXCloudError('invalid_token', 'ID token thiếu claim sub hoặc exp.');
  }
  if (!sameIssuer(claims.iss, oidc.issuer)) {
    throw new AgentXCloudError('invalid_token', 'Issuer trong ID token không khớp cấu hình.');
  }
  if (!tokenAudienceMatches(claims.aud, oidc.clientId)) {
    throw new AgentXCloudError('invalid_token', 'Audience trong ID token không khớp client_id.');
  }
  if (nonce != null && claims.nonce !== nonce) {
    throw new AgentXCloudError('invalid_token', 'Nonce trong ID token không khớp phiên đăng nhập.');
  }
  if ((Number(claims.exp) * 1000) <= now) {
    throw new AgentXCloudError('invalid_token', 'ID token vừa nhận đã hết hạn.');
  }
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Base64Url(value, cryptoImpl) {
  const bytes = new TextEncoder().encode(value);
  const digest = await cryptoImpl.subtle.digest('SHA-256', bytes);
  return base64UrlEncode(new Uint8Array(digest));
}

function randomBase64Url(cryptoImpl, length = 32) {
  return base64UrlEncode(cryptoImpl.getRandomValues(new Uint8Array(length)));
}

function createUuidV4(cryptoImpl) {
  if (typeof cryptoImpl.randomUUID === 'function') return cryptoImpl.randomUUID().toLowerCase();
  const bytes = cryptoImpl.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

export function sanitizeDeviceName(value) {
  return String(value || '')
    .replace(/[^A-Za-z0-9 ._-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64);
}

function normalizeScopes(value) {
  const scopes = Array.isArray(value)
    ? value.map(String)
    : String(value || 'openid profile email').split(/\s+/);
  const unique = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
  if (!unique.includes('openid')) unique.unshift('openid');
  return unique.join(' ');
}

export function selectPublicOidcProvider(payload) {
  const providers = Array.isArray(payload?.providers) ? payload.providers : [];
  const provider = providers.find((entry) => {
    const native = entry?.native_oidc;
    return native && typeof native === 'object' && native.confidential === false;
  });
  if (!provider) {
    throw new AgentXCloudError(
      'oidc_provider_unavailable',
      'Second Brain không công bố public native_oidc provider.',
    );
  }
  const native = provider.native_oidc;
  const issuer = normalizeHttpsBaseUrl(native.issuer, 'OIDC issuer');
  const clientId = String(native.client_id || '').trim();
  if (!clientId) {
    throw new AgentXCloudError('invalid_configuration', 'OIDC provider thiếu client_id.');
  }
  return {
    name: String(provider.name || 'keycloak'),
    displayName: String(provider.display_name || 'AgentX'),
    issuer,
    clientId,
    scopes: normalizeScopes(native.scopes),
  };
}

function configuredOidcProvider(config) {
  const issuerValue = String(config?.oidcIssuer || '').trim();
  const clientId = String(config?.oidcClientId || '').trim();
  if (!issuerValue && !clientId) return null;
  if (!issuerValue || !clientId) {
    throw new AgentXCloudError(
      'invalid_configuration',
      'OIDC trực tiếp yêu cầu cả issuer và client_id.',
    );
  }
  return {
    name: 'keycloak',
    displayName: 'AgentX',
    issuer: normalizeHttpsBaseUrl(issuerValue, 'OIDC issuer'),
    clientId,
    scopes: normalizeScopes(config.oidcScopes),
  };
}

async function responseBody(response) {
  const text = await response.text().catch(() => '');
  if (!text) return { json: null, text: '' };
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

function safeErrorDetail(body, fallback) {
  const detail = body?.json?.detail || body?.json?.error_description || body?.json?.message;
  return String(detail || fallback || '').slice(0, 500);
}

function serviceErrorFromResponse(response, body, fallbackCode = 'service_request_failed') {
  const code = String(body?.json?.error || fallbackCode);
  const transient = response.status >= 500 || [
    'identity_unavailable',
    'store_unavailable',
    'litellm_unconfigured',
    'litellm_unavailable',
    'key_unreadable',
  ].includes(code);
  return new AgentXCloudError(
    code,
    safeErrorDetail(body, `Dịch vụ trả HTTP ${response.status}.`),
    { status: response.status, transient },
  );
}

function credentialIsUsable(value, subject, authority) {
  return !!value &&
    typeof value === 'object' &&
    value.subject === subject &&
    value.authority === authority &&
    typeof value.key === 'string' &&
    value.key.length > 0 &&
    typeof value.baseUrl === 'string' &&
    value.baseUrl.length > 0 &&
    typeof value.model === 'string' &&
    value.model.length > 0;
}

function publicUser(claims) {
  return {
    subject: String(claims.sub),
    email: String(claims.email || ''),
    displayName: String(
      claims.name ||
      claims.preferred_username ||
      claims.email ||
      claims.sub,
    ),
  };
}

export function createAgentXCloudService(options = {}) {
  const api = options.api;
  const fetchImpl = options.fetchImpl || globalThis.fetch?.bind(globalThis);
  const cryptoImpl = options.cryptoImpl || globalThis.crypto;
  const now = options.now || (() => Date.now());
  const config = options.config || AGENTX_RUNTIME_CONFIG;
  const setTimer = options.setTimeout || globalThis.setTimeout.bind(globalThis);
  const clearTimer = options.clearTimeout || globalThis.clearTimeout.bind(globalThis);

  if (!api?.storage?.local || !api?.tabs || !api?.runtime) {
    throw new AgentXCloudError('invalid_configuration', 'API tiện ích chưa sẵn sàng.');
  }
  if (typeof fetchImpl !== 'function' || !cryptoImpl?.subtle) {
    throw new AgentXCloudError('invalid_configuration', 'Fetch hoặc Web Crypto chưa sẵn sàng.');
  }

  const secondBrainBaseUrl = normalizeHttpsBaseUrl(
    config.secondBrainBaseUrl,
    'Second Brain base URL',
  );
  const configuredLiteLlmBaseUrl = normalizeHttpsBaseUrl(
    config.litellmBaseUrl,
    'LiteLLM base URL',
    { openAiCompatible: true },
  );
  const redirectUris = (config.oidcRedirectUris || []).map(String);
  if (!redirectUris.length) {
    throw new AgentXCloudError('invalid_configuration', 'Không có OIDC redirect URI.');
  }
  // A session that has sat unused past this window is treated as gone, even
  // though Keycloak would still refresh it. Zero disables the idle window and
  // falls back to plain token lifetime.
  const idleTimeoutMs = Number.isFinite(Number(config.sessionIdleTimeoutMs))
    ? Math.max(0, Number(config.sessionIdleTimeoutMs))
    : DEFAULT_IDLE_TIMEOUT_MS;

  let memorySession = null;
  let refreshInFlight = null;
  let lastActivityWriteAt = 0;

  async function fetchWithTimeout(url, init = {}, timeoutMs = config.requestTimeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimer(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      const timedOut = error?.name === 'AbortError';
      throw new AgentXCloudError(
        timedOut ? 'request_timeout' : 'network_unavailable',
        timedOut ? 'Gọi dịch vụ quá lâu, đã hết thời gian chờ.' : 'Không kết nối được dịch vụ.',
        { transient: true, detail: error?.message || String(error) },
      );
    } finally {
      clearTimer(timeoutId);
    }
  }

  async function readStorage(key) {
    try {
      return (await api.storage.local.get([key]))?.[key];
    } catch {
      return undefined;
    }
  }

  async function persistSession(session) {
    const stamped = { ...session, lastActiveAt: Number(session.lastActiveAt) || now() };
    memorySession = stamped;
    lastActivityWriteAt = stamped.lastActiveAt;
    try {
      await api.storage.local.set({ [AGENTX_SESSION_STORAGE_KEY]: stamped });
      return { persisted: true };
    } catch {
      return { persisted: false };
    }
  }

  function idleDeadline(session) {
    if (!idleTimeoutMs) return Number.POSITIVE_INFINITY;
    // Sessions written before this build carry no lastActiveAt. Treating a
    // missing stamp as "issued now" would hand them a fresh idle window on
    // every read, so fall back to when the tokens were obtained.
    const anchor = Number(session?.lastActiveAt) || Number(session?.obtainedAt) || 0;
    return anchor ? anchor + idleTimeoutMs : 0;
  }

  function sessionIsIdleExpired(session, at = now()) {
    return at >= idleDeadline(session);
  }

  /**
   * Records that the signed-in user is still around. Callers fire this from UI
   * activity, so it must stay cheap: it only touches storage once a minute and
   * never revives a session that has already gone idle.
   */
  async function touchSession({ force = false } = {}) {
    const session = await readSession();
    if (!session) return { signedIn: false, idleExpired: false };
    const at = now();
    if (sessionIsIdleExpired(session, at)) {
      await clearSession();
      return { signedIn: false, idleExpired: true };
    }
    memorySession = { ...session, lastActiveAt: at };
    if (!force && at - lastActivityWriteAt < ACTIVITY_WRITE_INTERVAL_MS) {
      return { signedIn: true, idleExpired: false, persisted: false };
    }
    const persistence = await persistSession(memorySession);
    return { signedIn: true, idleExpired: false, persisted: persistence.persisted };
  }

  async function readSession() {
    const stored = await readStorage(AGENTX_SESSION_STORAGE_KEY);
    const valid = stored && typeof stored === 'object' && stored.idToken && stored.user?.subject
      ? stored
      : null;
    if (!memorySession) {
      memorySession = valid;
      return memorySession;
    }
    // The panel and the Settings page each hold their own copy. Whichever one
    // the user is actually working in records the activity, so adopt the newer
    // stamp — otherwise a Settings tab left open all day would judge a busy
    // session idle and sign everyone out.
    //
    // Memory still wins when storage has nothing: a failed write must not cost
    // the user the session it could not persist.
    if (valid && Number(valid.lastActiveAt) > Number(memorySession.lastActiveAt || 0)) {
      memorySession = valid;
    }
    return memorySession;
  }

  async function clearSession() {
    memorySession = null;
    await api.storage.local.remove([AGENTX_SESSION_STORAGE_KEY]).catch(() => {});
  }

  async function discoverOidc() {
    let advertised = configuredOidcProvider(config);
    if (!advertised) {
      const providersUrl = new URL(
        String(config.oidcProvidersPath || '/api/auth/providers').replace(/^\//, ''),
        `${secondBrainBaseUrl}/`,
      ).toString();
      const providersResponse = await fetchWithTimeout(providersUrl, {
        headers: { Accept: 'application/json' },
      });
      const providersBody = await responseBody(providersResponse);
      if (!providersResponse.ok) {
        throw serviceErrorFromResponse(providersResponse, providersBody, 'oidc_discovery_failed');
      }
      advertised = selectPublicOidcProvider(providersBody.json);
    }
    const discoveryUrl = `${advertised.issuer}/.well-known/openid-configuration`;
    const discoveryResponse = await fetchWithTimeout(discoveryUrl, {
      headers: { Accept: 'application/json' },
    });
    const discoveryBody = await responseBody(discoveryResponse);
    if (!discoveryResponse.ok || !discoveryBody.json) {
      throw serviceErrorFromResponse(
        discoveryResponse,
        discoveryBody,
        'oidc_discovery_failed',
      );
    }
    const document = discoveryBody.json;
    if (!sameIssuer(document.issuer, advertised.issuer)) {
      throw new AgentXCloudError(
        'issuer_mismatch',
        'Issuer trong discovery document không khớp issuer đã cấu hình.',
      );
    }
    if (
      !isSecureEndpoint(document.authorization_endpoint) ||
      !isSecureEndpoint(document.token_endpoint)
    ) {
      throw new AgentXCloudError(
        'insecure_oidc_endpoint',
        'OIDC authorization/token endpoint phải dùng HTTPS.',
      );
    }
    return {
      ...advertised,
      authorizationEndpoint: document.authorization_endpoint,
      tokenEndpoint: document.token_endpoint,
      endSessionEndpoint: isSecureEndpoint(document.end_session_endpoint)
        ? document.end_session_endpoint
        : '',
      revocationEndpoint: isSecureEndpoint(document.revocation_endpoint)
        ? document.revocation_endpoint
        : '',
    };
  }

  function awaitAuthorizationCode(authUrl, redirectUri, expectedState) {
    return new Promise(async (resolve, reject) => {
      let authTabId = null;
      let settled = false;
      let timeoutId = null;
      const redirect = new URL(redirectUri);

      const cleanup = () => {
        if (timeoutId) clearTimer(timeoutId);
        try { api.tabs.onUpdated.removeListener(onUpdated); } catch {}
        try { api.tabs.onRemoved.removeListener(onRemoved); } catch {}
      };
      const finish = (handler, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (authTabId != null) api.tabs.remove(authTabId).catch(() => {});
        handler(value);
      };
      const onUpdated = (tabId, changeInfo) => {
        if (tabId !== authTabId || !changeInfo?.url) return;
        let callback;
        try {
          callback = new URL(changeInfo.url);
        } catch {
          return;
        }
        if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname) return;
        const returnedState = callback.searchParams.get('state');
        if (returnedState !== expectedState) {
          return finish(reject, new AgentXCloudError(
            'state_mismatch',
            'OAuth state không khớp nên đăng nhập bị hủy.',
          ));
        }
        const oauthError = callback.searchParams.get('error');
        if (oauthError) {
          return finish(reject, new AgentXCloudError(
            oauthError,
            callback.searchParams.get('error_description') || 'Keycloak từ chối đăng nhập.',
          ));
        }
        const code = callback.searchParams.get('code');
        if (!code) {
          return finish(reject, new AgentXCloudError(
            'authorization_code_missing',
            'Callback đăng nhập không chứa authorization code.',
          ));
        }
        finish(resolve, code);
      };
      const onRemoved = (tabId) => {
        if (tabId === authTabId) {
          finish(reject, new AgentXCloudError(
            'sign_in_cancelled',
            'Cửa sổ đăng nhập bị đóng khi chưa xong.',
          ));
        }
      };

      try {
        api.tabs.onUpdated.addListener(onUpdated);
        api.tabs.onRemoved.addListener(onRemoved);
        const authTab = await api.tabs.create({ url: authUrl, active: true });
        authTabId = authTab.id;
        timeoutId = setTimer(() => finish(reject, new AgentXCloudError(
          'sign_in_timeout',
          'Quá 5 phút chưa đăng nhập xong. Hãy làm lại từ đầu.',
        )), Number(config.authTimeoutMs) || 5 * 60_000);
      } catch (error) {
        finish(reject, new AgentXCloudError(
          'sign_in_window_failed',
          `Không mở được cửa sổ đăng nhập: ${error?.message || error}`,
        ));
      }
    });
  }

  async function exchangeAuthorizationCode(oidc, details) {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: oidc.clientId,
      code: details.code,
      code_verifier: details.codeVerifier,
      redirect_uri: details.redirectUri,
    });
    const response = await fetchWithTimeout(oidc.tokenEndpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    const body = await responseBody(response);
    if (!response.ok || !body.json) {
      throw serviceErrorFromResponse(response, body, 'token_exchange_failed');
    }
    if (!body.json.id_token) {
      throw new AgentXCloudError('id_token_missing', 'Keycloak không trả về id_token.');
    }
    const claims = decodeJwtPayload(body.json.id_token);
    validateIdTokenClaims(claims, oidc, { nonce: details.nonce, now: now() });
    const session = {
      idToken: body.json.id_token,
      refreshToken: body.json.refresh_token || '',
      expiresAt: Number(claims.exp) * 1000,
      issuer: oidc.issuer,
      clientId: oidc.clientId,
      scopes: oidc.scopes,
      tokenEndpoint: oidc.tokenEndpoint,
      endSessionEndpoint: oidc.endSessionEndpoint,
      revocationEndpoint: oidc.revocationEndpoint,
      redirectUri: details.redirectUri,
      user: publicUser(claims),
      obtainedAt: now(),
    };
    const persistence = await persistSession(session);
    return { session, persistence };
  }

  /** A fresh PKCE authorize request; `extra` adds prompt/login_hint for the silent flow. */
  async function buildAuthorizeRequest(oidc, redirectUri, { loginHint = '', extra = {} } = {}) {
    const codeVerifier = randomBase64Url(cryptoImpl, 48);
    const codeChallenge = await sha256Base64Url(codeVerifier, cryptoImpl);
    const state = randomBase64Url(cryptoImpl, 32);
    const nonce = randomBase64Url(cryptoImpl, 32);
    const authUrl = new URL(oidc.authorizationEndpoint);
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: oidc.clientId,
      redirect_uri: redirectUri,
      scope: oidc.scopes,
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      ...(loginHint ? { login_hint: loginHint } : {}),
      ...extra,
    })) {
      authUrl.searchParams.set(key, value);
    }
    return { authUrl: authUrl.toString(), codeVerifier, state, nonce };
  }

  /**
   * Interactive sign-in: a tab on Keycloak, the loopback redirect watched via
   * tabs.onUpdated. `loginHint` (an email) pre-fills the account when the
   * Workmate desktop app asked for the sign-in (`auth_open`).
   */
  async function signIn({ loginHint = '' } = {}) {
    const oidc = await discoverOidc();
    const redirectUri = redirectUris[0];
    const request = await buildAuthorizeRequest(oidc, redirectUri, { loginHint });
    const code = await awaitAuthorizationCode(request.authUrl, redirectUri, request.state);
    return exchangeAuthorizationCode(oidc, {
      code,
      codeVerifier: request.codeVerifier,
      nonce: request.nonce,
      redirectUri,
    });
  }

  /**
   * The redirect the silent flow lands on: chrome.identity's own
   * https://<extension id>.chromiumapp.org/ — never fetched, only observed by
   * the browser, and it must be registered on the Keycloak client.
   */
  function silentRedirectUri() {
    let fromApi = '';
    try {
      fromApi = String(api.identity?.getRedirectURL?.() || '');
    } catch {
      fromApi = '';
    }
    if (fromApi) return fromApi;
    const id = String(api.runtime?.id || '').trim();
    if (!id) {
      throw new AgentXCloudError(
        'identity_unavailable_api',
        'chrome.identity chưa sẵn sàng trong ngữ cảnh này nên không đăng nhập im lặng được.',
      );
    }
    return `https://${id}.chromiumapp.org/`;
  }

  function launchWebAuthFlow(details) {
    const identity = api.identity;
    if (typeof identity?.launchWebAuthFlow !== 'function') {
      throw new AgentXCloudError(
        'identity_unavailable_api',
        'chrome.identity chưa sẵn sàng trong ngữ cảnh này nên không đăng nhập im lặng được.',
      );
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (error, url) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(url);
      };
      let returned;
      try {
        returned = identity.launchWebAuthFlow(details, (responseUrl) => {
          const lastError = api.runtime?.lastError;
          if (lastError) done(new Error(lastError.message || String(lastError)));
          else done(null, responseUrl);
        });
      } catch (error) {
        done(error);
        return;
      }
      // MV3 returns a promise when no callback is given; some shims return
      // one regardless. Either way the first settlement wins.
      if (returned && typeof returned.then === 'function') {
        returned.then((url) => done(null, url), (error) => done(error));
      }
    });
  }

  /** Chrome's own wording for "no session to reuse" in the non-interactive flow. */
  function isInteractionRequiredMessage(message) {
    return /interaction required|not signed in|did not approve|not approve access|user cancelled|user canceled/i
      .test(String(message || ''));
  }

  /**
   * Silent sign-in for AgentX Workmate (`auth_hint`): a prompt=none authorize
   * in a hidden chrome.identity flow. Succeeds only when this browser profile
   * already holds a Keycloak SSO session for the account — the one Workmate
   * signed in with, when Workmate opened its sign-in in this browser. Every
   * "no session" outcome surfaces as code `login_required`; the caller then
   * leaves the person alone or offers the interactive sign-in.
   */
  async function silentSignIn({ loginHint = '', timeoutMs = 20_000 } = {}) {
    const oidc = await discoverOidc();
    const redirectUri = silentRedirectUri();
    const request = await buildAuthorizeRequest(oidc, redirectUri, {
      loginHint,
      extra: { prompt: 'none' },
    });
    let responseUrl;
    try {
      responseUrl = await launchWebAuthFlow({
        url: request.authUrl,
        interactive: false,
        // Keycloak answers prompt=none with a server-side redirect straight
        // back to the redirect URI, so nothing has to run after page load.
        abortOnLoadForNonInteractive: true,
        timeoutMsForNonInteractive: timeoutMs,
      });
    } catch (error) {
      if (error instanceof AgentXCloudError) throw error;
      const detail = error?.message || String(error);
      if (isInteractionRequiredMessage(detail)) {
        throw new AgentXCloudError(
          'login_required',
          'Trình duyệt này chưa có phiên đăng nhập AgentX để dùng lại.',
          { detail },
        );
      }
      throw new AgentXCloudError(
        'silent_sign_in_failed',
        `Không chạy được đăng nhập im lặng: ${detail}`,
        { detail, transient: true },
      );
    }
    let callback;
    try {
      callback = new URL(String(responseUrl || ''));
    } catch {
      throw new AgentXCloudError('silent_sign_in_failed', 'Trình duyệt không trả về URL kết thúc đăng nhập.');
    }
    const params = callback.searchParams;
    if (params.get('state') !== request.state) {
      throw new AgentXCloudError('state_mismatch', 'OAuth state không khớp nên đăng nhập bị hủy.');
    }
    const oauthError = params.get('error');
    if (oauthError) {
      if (['login_required', 'interaction_required', 'consent_required', 'account_selection_required']
        .includes(oauthError)) {
        throw new AgentXCloudError(
          'login_required',
          'Trình duyệt này chưa có phiên đăng nhập AgentX để dùng lại.',
          { detail: params.get('error_description') || oauthError },
        );
      }
      throw new AgentXCloudError(
        oauthError,
        params.get('error_description') || 'Keycloak từ chối đăng nhập im lặng.',
      );
    }
    const code = params.get('code');
    if (!code) {
      throw new AgentXCloudError(
        'authorization_code_missing',
        'Callback đăng nhập không chứa authorization code.',
      );
    }
    return exchangeAuthorizationCode(oidc, {
      code,
      codeVerifier: request.codeVerifier,
      nonce: request.nonce,
      redirectUri,
    });
  }

  async function doRefresh(session) {
    if (!session.refreshToken || !session.tokenEndpoint || !session.clientId) {
      await clearSession();
      throw new AgentXCloudError(
        'needs_login',
        'Phiên đăng nhập không có refresh token. Hãy đăng nhập lại.',
      );
    }
    let response;
    try {
      response = await fetchWithTimeout(session.tokenEndpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: session.refreshToken,
          client_id: session.clientId,
        }).toString(),
      });
    } catch (error) {
      if (error.transient) {
        return { session, outcome: 'stale-offline', warningCode: error.code };
      }
      throw error;
    }
    const body = await responseBody(response);
    const oauthCode = String(body.json?.error || '');
    if ([400, 401, 403].includes(response.status) && oauthCode === 'invalid_grant') {
      await clearSession();
      throw new AgentXCloudError(
        'needs_login',
        'Refresh token đã bị từ chối. Hãy đăng nhập lại.',
        { status: response.status },
      );
    }
    if (!response.ok || !body.json?.id_token) {
      return {
        session,
        outcome: 'stale-offline',
        warningCode: oauthCode || `identity_http_${response.status}`,
      };
    }
    const claims = decodeJwtPayload(body.json.id_token);
    validateIdTokenClaims(claims, {
      issuer: session.issuer,
      clientId: session.clientId,
    }, { now: now() });
    const refreshed = {
      ...session,
      idToken: body.json.id_token,
      refreshToken: body.json.refresh_token || session.refreshToken,
      expiresAt: Number(claims.exp) * 1000,
      user: publicUser(claims),
      obtainedAt: now(),
    };
    const persistence = await persistSession(refreshed);
    return {
      session: refreshed,
      outcome: 'refreshed',
      persistenceWarning: persistence.persisted ? '' : 'session_not_persisted',
    };
  }

  function refreshSession(session) {
    if (!refreshInFlight) {
      refreshInFlight = doRefresh(session).finally(() => {
        refreshInFlight = null;
      });
    }
    return refreshInFlight;
  }

  async function restoreSession() {
    const session = await readSession();
    if (!session) return { session: null, outcome: 'needs-login' };
    // Idle expiry is checked before the token refresh: an untouched session
    // must not be silently renewed just because Keycloak would still allow it.
    if (sessionIsIdleExpired(session)) {
      await clearSession();
      return { session: null, outcome: 'idle-expired' };
    }
    if (now() < (Number(session.expiresAt) - REFRESH_AHEAD_MS)) {
      return { session, outcome: 'stored' };
    }
    // An issuer that hands out no refresh token (the netMind branch's SSO
    // wrapper is one) used to kill the session right here at the ID token's
    // exp — locking the user out of a panel whose chat never presents that
    // token at all: chat runs on the provisioned LiteLLM key, which does not
    // expire. A session with nothing to refresh is therefore held instead of
    // cleared. What still ends it: the idle window above, sign-out, and the
    // backend rejecting the stale bearer the next time provisioning actually
    // needs it (401 invalid_token). Sessions that do carry a refresh token —
    // everything Keycloak issues — keep the strict path below, where
    // invalid_grant means sign in again.
    if (!session.refreshToken) {
      return { session, outcome: 'stored' };
    }
    try {
      return await refreshSession(session);
    } catch (error) {
      if (error.code === 'needs_login') return { session: null, outcome: 'needs-login' };
      return {
        session,
        outcome: 'stale-offline',
        warningCode: error.code || 'identity_unavailable',
      };
    }
  }

  async function deviceIdentity() {
    const stored = await readStorage(AGENTX_DEVICE_STORAGE_KEY);
    if (
      stored &&
      typeof stored === 'object' &&
      DEVICE_ID_RE.test(String(stored.id || '').toLowerCase())
    ) {
      return {
        id: String(stored.id).toLowerCase(),
        name: sanitizeDeviceName(stored.name),
        createdAt: Number(stored.createdAt) || now(),
      };
    }
    let platform = {};
    try {
      platform = await api.runtime.getPlatformInfo();
    } catch {
      platform = {};
    }
    const platformLabel = {
      mac: 'macOS',
      win: 'Windows',
      linux: 'Linux',
      android: 'Android',
      cros: 'ChromeOS',
      openbsd: 'OpenBSD',
    }[platform?.os] || 'Browser';
    const identity = {
      id: createUuidV4(cryptoImpl),
      name: sanitizeDeviceName(`AgentX WebMate ${platformLabel}`),
      createdAt: now(),
    };
    await api.storage.local.set({ [AGENTX_DEVICE_STORAGE_KEY]: identity }).catch(() => {});
    return identity;
  }

  async function credentialRecords() {
    const stored = await readStorage(AGENTX_CREDENTIAL_STORAGE_KEY);
    if (!stored || stored.version !== 1 || !Array.isArray(stored.records)) return [];
    return stored.records.filter((record) => record && typeof record === 'object');
  }

  async function saveCredential(credential) {
    const existing = await credentialRecords();
    const records = [
      credential,
      ...existing.filter((record) => record.subject !== credential.subject),
    ].slice(0, MAX_CACHED_ACCOUNTS);
    await api.storage.local.set({
      [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records },
    }).catch(() => {});
  }

  async function removeCredential(subject) {
    if (!subject) return;
    const existing = await credentialRecords();
    const records = existing.filter((record) => record.subject !== subject);
    if (records.length === existing.length) return;
    await api.storage.local.set({
      [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records },
    }).catch(() => {});
  }

  async function probeCredential(credential) {
    const url = `${stripTrailingSlash(credential.baseUrl)}/models`;
    let response;
    try {
      response = await fetchWithTimeout(url, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${credential.key}`,
        },
      }, MODEL_PROBE_TIMEOUT_MS);
    } catch (error) {
      return { ok: false, transient: true, code: error.code };
    }
    if (response.ok) {
      const body = await responseBody(response);
      const catalog = gatewayCatalogFromPayload(body.json);
      return catalog.models.length
        ? { ok: true, ...catalog }
        : { ok: false, rejected: true, code: 'gateway_models_empty' };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, rejected: true, code: `gateway_http_${response.status}` };
    }
    return { ok: false, transient: true, code: `gateway_http_${response.status}` };
  }

  async function discoverGatewayCatalog(key, baseUrl) {
    const response = await fetchWithTimeout(`${stripTrailingSlash(baseUrl)}/models`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${key}`,
      },
    }, MODEL_PROBE_TIMEOUT_MS);
    const body = await responseBody(response);
    if (!response.ok || !body.json) {
      throw serviceErrorFromResponse(response, body, 'gateway_model_discovery_failed');
    }
    const catalog = gatewayCatalogFromPayload(body.json);
    if (!catalog.models.length) {
      throw new AgentXCloudError(
        'gateway_models_empty',
        'LiteLLM không trả về mô hình nào cho khóa này.',
      );
    }
    return catalog;
  }

  /**
   * The model lists one credential carries, from what LiteLLM serves now
   * (`catalog`) and what the key service granted (`grant`): the chat picker,
   * the vision and transcription pickers, and the defaults.
   */
  function modelsForGrant(catalog, grant, { model = '', visionModel = '', transcriptionModel = '' } = {}) {
    const chatModels = chatModelsFromGrant(catalog.models, grant.serviceModels, grant.featureModels);
    const visionModels = visionModelsForGrant(
      chatModels,
      catalog.visionFromInfo,
      grant.serviceVisionModel,
      catalog.models,
    );
    // A transcription model is not a chat model, so it is looked for among
    // everything the key reaches — except the feature models.
    const features = new Set(normalizeGatewayModels(grant.featureModels));
    const transcriptionModels = transcriptionModelsFromGateway(
      normalizeGatewayModels(catalog.models).filter((id) => !features.has(id)),
      catalog.transcriptionFromInfo,
    );
    return {
      models: chatModels,
      reachableModels: normalizeGatewayModels(catalog.models),
      model: pickGatewayModel(model, chatModels, grant.defaultModel),
      visionFromInfo: catalog.visionFromInfo,
      visionModels,
      // The key service's vision model is the default; a model already chosen stays.
      visionModel: pickGatewayVisionModel(visionModel || grant.serviceVisionModel, visionModels),
      transcriptionFromInfo: catalog.transcriptionFromInfo,
      transcriptionModels,
      transcriptionModel: pickGatewayTranscriptionModel(transcriptionModel, transcriptionModels),
    };
  }

  /** What the key service granted beside the key: the chat list and one model per feature. */
  function grantFromKeyBody(body) {
    return {
      serviceModels: normalizeGatewayModels(body.models),
      defaultModel: String(body.default_model || '').trim(),
      featureModels: featureModelsFromKey(body),
      webSearchModel: String(body.web_search_model || '').trim(),
      imageModel: String(body.image_model || '').trim(),
      // The key service's vision model; `visionModel` on a credential is the one in use.
      serviceVisionModel: String(body.vision_model || '').trim(),
      // Text-to-speech: reachable with the key, never offered for chat, vision or transcription.
      speechModel: String(body.speech_model || '').trim(),
    };
  }

  async function requestModelKey(session, { rotate = false } = {}) {
    const device = await deviceIdentity();
    const response = await fetchWithTimeout(`${secondBrainBaseUrl}/v1/model-key`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${session.idToken}`,
        'Content-Type': 'application/json',
        'X-AgentX-Device': device.id,
        ...(device.name ? { 'X-AgentX-Device-Name': device.name } : {}),
      },
      body: JSON.stringify({ rotate: rotate === true }),
    });
    const body = await responseBody(response);
    if (!response.ok || !body.json) {
      const error = serviceErrorFromResponse(response, body, 'model_key_failed');
      if (
        (response.status === 401 && ['invalid_token', 'missing_bearer'].includes(error.code)) ||
        (response.status === 403 && error.code === 'device_revoked')
      ) {
        await clearSession();
      }
      throw error;
    }
    const key = String(body.json.key || '');
    const grant = grantFromKeyBody(body.json);
    const baseUrl = normalizeHttpsBaseUrl(
      body.json.base_url || configuredLiteLlmBaseUrl,
      'LiteLLM base_url',
      { openAiCompatible: true },
    );
    if (!key) {
      throw new AgentXCloudError(
        'invalid_model_key_response',
        'Second Brain trả về khóa mô hình không hợp lệ.',
      );
    }
    // LiteLLM says what is live; the key service says which of it is for chat.
    // Never install a model until the issued key can actually reach it, and
    // never offer a feature model (web search, images, vision) in a picker.
    const catalog = await discoverGatewayCatalog(key, baseUrl);
    return {
      subject: session.user.subject,
      authority: secondBrainBaseUrl,
      key,
      baseUrl,
      ...modelsForGrant(catalog, grant, { model: grant.defaultModel }),
      ...grant,
      keyAlias: String(body.json.key_alias || ''),
      keyToken: String(body.json.token || ''),
      account: String(body.json.account || ''),
      status: String(body.json.status || 'reused'),
      createdAt: String(body.json.created_at || ''),
      rotatedAt: body.json.rotated_at == null ? null : String(body.json.rotated_at),
      cachedAt: now(),
      device,
      provisionOutcome: String(body.json.status || 'reused'),
      warningCode: '',
    };
  }

  /** Whether a cached record's grant may be out of date with what its key reaches now. */
  function grantIsStale(record, liveModels) {
    if (!Array.isArray(record.serviceModels) || !Array.isArray(record.reachableModels)) return true;
    const before = new Set(normalizeGatewayModels(record.reachableModels));
    const now = normalizeGatewayModels(liveModels);
    return now.length !== before.size || now.some((id) => !before.has(id));
  }

  async function provisionModelKey(session, options = {}) {
    const records = await credentialRecords();
    const cached = records.find((record) => credentialIsUsable(
      record,
      session.user.subject,
      secondBrainBaseUrl,
    ));
    if (cached && options.rotate !== true) {
      const probe = await probeCredential(cached);
      if (probe.ok) {
        if (grantIsStale(cached, probe.models)) {
          // The key reaches something other than it did (an operator changed the
          // grant), or this record predates the chat/feature split: ask the key
          // service what is for chat now. It hands back the same key.
          try {
            const credential = await requestModelKey(session, { rotate: false });
            const merged = {
              ...credential,
              ...modelsForGrant(
                { models: credential.reachableModels, visionFromInfo: credential.visionFromInfo, transcriptionFromInfo: credential.transcriptionFromInfo },
                credential,
                { model: cached.model, transcriptionModel: cached.transcriptionModel },
              ),
            };
            await saveCredential(merged);
            return merged;
          } catch (error) {
            // Offline or refused: keep going with what this record knows.
          }
        }
        const refreshed = {
          ...cached,
          ...modelsForGrant(probe, cached, {
            model: cached.model,
            visionModel: cached.visionModel,
            transcriptionModel: cached.transcriptionModel,
          }),
          provisionOutcome: 'reused-local',
          warningCode: '',
        };
        await saveCredential(refreshed);
        return refreshed;
      }
      if (probe.transient) {
        return {
          ...cached,
          provisionOutcome: 'stale-offline',
          warningCode: probe.code || 'gateway_unavailable',
        };
      }
      // A 401/403 from LiteLLM means another device may already have rotated.
      // Fetch the account's current key with rotate:false; never start a second rotation.
    }

    try {
      const credential = await requestModelKey(session, { rotate: options.rotate === true });
      await saveCredential(credential);
      return credential;
    } catch (error) {
      const definitive = [
        'invalid_token',
        'missing_bearer',
        'device_revoked',
        'gateway_models_empty',
        'invalid_model_key_response',
      ].includes(error.code);
      if (cached && !definitive) {
        return {
          ...cached,
          provisionOutcome: 'stale-offline',
          warningCode: error.code || 'model_key_unavailable',
        };
      }
      throw error;
    }
  }

  async function signInAndProvision(options = {}) {
    const signedIn = await signIn(options);
    const credential = await provisionModelKey(signedIn.session, { rotate: false });
    return {
      credential,
      session: signedIn.session,
      persistenceWarning: signedIn.persistence.persisted ? '' : 'session_not_persisted',
    };
  }

  /** silentSignIn followed by the same provisioning the interactive path does. */
  async function silentSignInAndProvision(options = {}) {
    const signedIn = await silentSignIn(options);
    const credential = await provisionModelKey(signedIn.session, { rotate: false });
    return {
      credential,
      session: signedIn.session,
      persistenceWarning: signedIn.persistence.persisted ? '' : 'session_not_persisted',
    };
  }

  async function retryProvision() {
    const restored = await restoreSession();
    if (!restored.session) {
      throw new AgentXCloudError('needs_login', 'Hãy đăng nhập AgentX trước khi kết nối Cloud.');
    }
    const credential = await provisionModelKey(restored.session, { rotate: false });
    return {
      credential,
      session: restored.session,
      persistenceWarning: restored.persistenceWarning || '',
    };
  }

  async function revokeRefreshTokenBestEffort(session) {
    if (!session?.revocationEndpoint || !session.refreshToken) return;
    await fetchWithTimeout(session.revocationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: session.refreshToken,
        token_type_hint: 'refresh_token',
        client_id: session.clientId,
      }).toString(),
    }).catch(() => {});
  }

  async function signOut() {
    const session = await readSession();
    if (session) await revokeRefreshTokenBestEffort(session);
    await clearSession();
    await removeCredential(session?.user?.subject);
    if (session?.endSessionEndpoint && session.idToken) {
      try {
        const url = new URL(session.endSessionEndpoint);
        url.searchParams.set('id_token_hint', session.idToken);
        await api.tabs.create({ url: url.toString(), active: true });
      } catch {
        // Local session is already gone. Remote logout is explicitly best-effort.
      }
    }
    return { signedIn: false, outcome: 'signed-out' };
  }

  async function publicStatus() {
    const restored = await restoreSession();
    const session = restored.session;
    const device = await deviceIdentity();
    if (!session) {
      return {
        signedIn: false,
        outcome: restored.outcome,
        idleExpired: restored.outcome === 'idle-expired',
        idleTimeoutMs,
        idleDeadline: null,
        user: null,
        expiresAt: null,
        device: { id: device.id, name: device.name },
        redirectUri: redirectUris[0],
        secondBrainBaseUrl,
        configuredLiteLlmBaseUrl,
      };
    }
    const deadline = idleDeadline(session);
    return {
      signedIn: true,
      outcome: restored.outcome,
      idleExpired: false,
      idleTimeoutMs,
      idleDeadline: Number.isFinite(deadline) ? deadline : null,
      warningCode: restored.warningCode || '',
      persistenceWarning: restored.persistenceWarning || '',
      user: session.user,
      expiresAt: session.expiresAt,
      device: { id: device.id, name: device.name },
      redirectUri: session.redirectUri || redirectUris[0],
      secondBrainBaseUrl,
      configuredLiteLlmBaseUrl,
    };
  }

  return {
    clearSession,
    deviceIdentity,
    discoverOidc,
    idleTimeoutMs,
    provisionModelKey,
    publicStatus,
    readSession,
    restoreSession,
    retryProvision,
    signIn,
    signInAndProvision,
    silentRedirectUri,
    silentSignIn,
    silentSignInAndProvision,
    signOut,
    touchSession,
  };
}
