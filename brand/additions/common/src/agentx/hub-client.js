// AgentX AgentHub client for WebMate (plan Phase 4, item 1).
//
// One place that knows how the extension talks to the hub: the base URL
// (build-time default, storage override for a local hub), the bearer (the
// AgentX ID token the sign-in gate already holds, the same way
// `requestModelKey` uses it), the device headers, timeouts, and the error
// vocabulary the UI translates on. Nothing here writes skills — hub-sync.js
// owns that — so a Settings page can search and preview with this client
// while the background remains the only writer of `customSkills`.
import { AGENTX_RUNTIME_CONFIG } from './runtime-config.js';
import { createAgentXCloudService } from './cloud-service.js';

export const AGENTX_HUB_CONFIG_STORAGE_KEY = 'agentxHubConfigV1';
export const AGENTX_HUB_PRODUCT = 'webmate';
export const AGENTX_HUB_KIND = 'browser';
export const AGENTX_HUB_RENDER_TARGET = 'webmate';
export const AGENTX_HUB_DEFAULT_TIMEOUT_MS = 15_000;
export const AGENTX_HUB_RENDER_HASH_HEADER = 'X-AgentX-Render-Hash';

// `name` (Workmate ∩ WebMate rule) or `owner/name` when a slug was taken.
const HUB_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)?$/;
const HUB_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const HUB_HASH_RE = /^sha256:[0-9a-f]{64}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export class AgentXHubError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AgentXHubError';
    this.code = code || 'unknown_error';
    this.status = Number(options.status) || 0;
    this.detail = options.detail ?? null;
    this.transient = options.transient === true;
  }
}

export function publicHubError(error) {
  if (!error) return null;
  return {
    code: String(error.code || 'unknown_error'),
    message: String(error.message || 'Unknown error'),
    status: Number(error.status) || 0,
    detail: error.detail ?? null,
    transient: error.transient === true,
  };
}

export function isValidHubSlug(value) {
  return HUB_SLUG_RE.test(String(value || ''));
}

export function isValidHubVersion(value) {
  const text = String(value || '');
  return text === 'latest' || HUB_VERSION_RE.test(text);
}

export function isValidHubHash(value) {
  return HUB_HASH_RE.test(String(value || ''));
}

/**
 * `sha256:<hex>` of the UTF-8 bytes of `text` — the address the hub gives a
 * render in `X-AgentX-Render-Hash`, and what hub-sync keeps per record to
 * tell a copy changed outside the extension from the render it installed.
 */
export async function sha256Address(text) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text ?? '')));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * A hub base URL must be HTTPS, without credentials, query or fragment. The
 * one exception is plain HTTP on a loopback host, so a developer (or the e2e
 * suite) can point the extension at a hub on this machine.
 */
export function normalizeHubBaseUrl(value, label = 'Hub URL') {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new AgentXHubError('invalid_configuration', `${label} phải là URL HTTPS tuyệt đối.`);
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash
  ) {
    throw new AgentXHubError(
      'invalid_configuration',
      `${label} phải là URL HTTPS không chứa thông tin xác thực, query hoặc fragment (HTTP chỉ cho 127.0.0.1/localhost).`,
    );
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathname}`;
}

export function hubOriginOf(baseUrl) {
  return new URL(baseUrl).origin;
}

export function hubSkillPageUrl(baseUrl, slug) {
  return `${baseUrl}/skills/${slug}`;
}

async function readStorage(api, key) {
  try {
    const stored = await api.storage.local.get(key);
    return stored?.[key];
  } catch {
    return undefined;
  }
}

/** The base URL in force: a valid storage override wins over the build default. */
export async function readHubConfig(api, config = AGENTX_RUNTIME_CONFIG) {
  const stored = await readStorage(api, AGENTX_HUB_CONFIG_STORAGE_KEY);
  const override = stored && typeof stored === 'object' ? String(stored.baseUrl || '').trim() : '';
  if (override) {
    try {
      return { baseUrl: normalizeHubBaseUrl(override), source: 'override' };
    } catch {
      // A broken override must not take the hub down: fall back to the default.
    }
  }
  return { baseUrl: normalizeHubBaseUrl(config.skillHubBaseUrl), source: 'default' };
}

/** Set (or, with an empty value, clear) the storage override. */
export async function writeHubConfig(api, { baseUrl } = {}) {
  const text = String(baseUrl || '').trim();
  if (!text) {
    await api.storage.local.remove([AGENTX_HUB_CONFIG_STORAGE_KEY]);
    return { baseUrl: '', source: 'default' };
  }
  const normalized = normalizeHubBaseUrl(text);
  await api.storage.local.set({ [AGENTX_HUB_CONFIG_STORAGE_KEY]: { baseUrl: normalized, updatedAt: Date.now() } });
  return { baseUrl: normalized, source: 'override' };
}

function errorFromResponse(status, json) {
  const code = json && typeof json.code === 'string' ? json.code : '';
  const message = json && typeof json.message === 'string' ? json.message : `Hub trả HTTP ${status}.`;
  const detail = json && 'detail' in json ? json.detail : null;
  if (status === 401) return new AgentXHubError(code || 'invalid_token', message, { status, detail });
  if (status === 403) return new AgentXHubError(code || 'forbidden', message, { status, detail });
  if (status === 404) return new AgentXHubError(code || 'skill_not_found', message, { status, detail });
  if (status === 429) return new AgentXHubError(code || 'rate_limited', message, { status, detail, transient: true });
  if (status === 503) return new AgentXHubError(code || 'hub_unavailable', message, { status, detail, transient: true });
  if (status >= 500) return new AgentXHubError(code || 'hub_unavailable', message, { status, detail, transient: true });
  return new AgentXHubError(code || 'http_error', message, { status, detail });
}

export function createAgentXHubClient({
  api,
  config = AGENTX_RUNTIME_CONFIG,
  fetchImpl = (...args) => globalThis.fetch(...args),
  service = null,
  timeoutMs = AGENTX_HUB_DEFAULT_TIMEOUT_MS,
  product = AGENTX_HUB_PRODUCT,
} = {}) {
  if (!api?.storage?.local) throw new TypeError('createAgentXHubClient needs the extension storage API');
  const cloud = service || createAgentXCloudService({ api, config });

  async function baseUrl() {
    return (await readHubConfig(api, config)).baseUrl;
  }

  async function currentSession() {
    const restored = await cloud.restoreSession();
    return restored?.session || null;
  }

  /**
   * Who is calling. With `required` (the default) a signed-out extension is a
   * `not_signed_in` error; without it the call proceeds anonymously, which
   * the public catalog allows.
   */
  async function identity({ required = true } = {}) {
    const session = await currentSession();
    if (!session) {
      if (required) throw new AgentXHubError('not_signed_in', 'Chưa đăng nhập AgentX trong WebMate.');
      return { token: '', device: null, subject: '', signedIn: false };
    }
    const device = await cloud.deviceIdentity();
    return { token: String(session.idToken || ''), device, subject: String(session.user?.subject || ''), signedIn: true };
  }

  async function request(path, { method = 'GET', body, auth = 'required', accept = 'application/json', query } = {}) {
    const base = await baseUrl();
    const url = new URL(`${base}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
      }
    }
    const headers = { Accept: accept };
    if (auth !== 'none') {
      const who = await identity({ required: auth === 'required' });
      if (who.token) {
        headers.Authorization = `Bearer ${who.token}`;
        if (who.device?.id) {
          headers['X-AgentX-Device'] = who.device.id;
          if (who.device.name) headers['X-AgentX-Device-Name'] = who.device.name;
        }
      }
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let text;
    try {
      response = await fetchImpl(url.toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit',
        // `latest` moves under one URL: the browser cache must never answer for the hub.
        cache: 'no-store',
      });
      text = await response.text();
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new AgentXHubError('request_timeout', `Hub không trả lời trong ${Math.round(timeoutMs / 1000)} giây.`, { transient: true });
      }
      throw new AgentXHubError('network_unavailable', 'Không kết nối được AgentX AgentHub.', { transient: true, detail: String(error?.message || error) });
    } finally {
      clearTimeout(timer);
    }
    let json = null;
    if ((response.headers.get('content-type') || '').includes('application/json')) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!response.ok) throw errorFromResponse(response.status, json);
    return { status: response.status, json, text, headers: response.headers };
  }

  function encodeSlug(slug) {
    return String(slug).split('/').map(encodeURIComponent).join('/');
  }

  return {
    baseUrl,
    identity,
    product,
    request,

    async wellKnown() {
      return (await request('/.well-known/agentx-hub.json', { auth: 'none' })).json;
    },

    async me() {
      return (await request('/v1/me')).json;
    },

    /** Browser skills the caller may see: public ones anonymously, plus their own and their organisation's when signed in. */
    async listBrowserSkills(q = '', { limit = 30, cursor = '', sort = '' } = {}) {
      const result = await request('/v1/skills', { auth: 'optional', query: { kind: AGENTX_HUB_KIND, q: String(q || '').trim(), limit, cursor, sort } });
      return result.json;
    },

    async getSkill(slug) {
      if (!isValidHubSlug(slug)) throw new AgentXHubError('invalid_request', `Slug không hợp lệ: ${slug}`);
      return (await request(`/v1/skills/${encodeSlug(slug)}`, { auth: 'optional' })).json;
    },

    /**
     * The WebMate render of one version, with the hub's provenance headers.
     * `contentHash` and the signature cover the package the render was made
     * from, so they cannot be checked against these bytes; `renderHash` can:
     * it is computed here over what was received and, when the hub states
     * one, must agree with it — a disagreement installs nothing.
     */
    async getRender(slug, version = 'latest', target = AGENTX_HUB_RENDER_TARGET) {
      if (!isValidHubSlug(slug)) throw new AgentXHubError('invalid_request', `Slug không hợp lệ: ${slug}`);
      const ref = version || 'latest';
      if (!isValidHubVersion(ref)) throw new AgentXHubError('invalid_request', `Phiên bản không hợp lệ: ${version}`);
      const result = await request(`/v1/skills/${encodeSlug(slug)}/versions/${encodeURIComponent(ref)}/render/${target}`, {
        auth: 'optional',
        accept: 'text/markdown, text/plain;q=0.9, */*;q=0.1',
      });
      const renderHash = await sha256Address(result.text);
      const stated = result.headers.get(AGENTX_HUB_RENDER_HASH_HEADER) || '';
      if (stated && stated !== renderHash) {
        throw new AgentXHubError('render_hash_mismatch', `Nội dung nhận được của ${slug} không khớp hash hub công bố.`, { detail: { stated, actual: renderHash } });
      }
      return {
        slug: result.headers.get('X-AgentX-Slug') || slug,
        version: result.headers.get('X-AgentX-Version') || (ref === 'latest' ? '' : ref),
        contentHash: result.headers.get('X-AgentX-Content-Hash') || '',
        renderHash,
        signature: result.headers.get('X-AgentX-Signature') || '',
        kid: result.headers.get('X-AgentX-Kid') || '',
        content: result.text,
      };
    },

    async listMyInstalls(forProduct = product) {
      return (await request('/v1/me/installs', { query: { product: forProduct } })).json;
    },

    /**
     * Record an install on the hub. `allDevices` makes it a "for every device
     * of mine" row (`device_id: null`); otherwise the row is pinned to this
     * device by the header, which is what a product installing for itself does.
     */
    async createInstall({ slug, version = null, allDevices = false, desiredState = 'installed' } = {}) {
      if (!isValidHubSlug(slug)) throw new AgentXHubError('invalid_request', `Slug không hợp lệ: ${slug}`);
      const body = { slug, product, desired_state: desiredState };
      if (version && version !== 'latest') body.version = version;
      if (allDevices) body.device_id = null;
      return (await request('/v1/installs', { method: 'POST', body })).json;
    },

    async removeInstall(installId) {
      return (await request(`/v1/installs/${encodeURIComponent(installId)}`, { method: 'DELETE' })).json;
    },

    async setInstallDesired(installId, desiredState, reason = '') {
      return (await request(`/v1/installs/${encodeURIComponent(installId)}/desired`, { method: 'POST', body: { desired_state: desiredState, reason } })).json;
    },

    async reportInstall(installId, { state, version = '', error = '' } = {}) {
      const body = { state };
      if (version) body.version = version;
      if (error) body.error = String(error).slice(0, 500);
      return (await request(`/v1/installs/${encodeURIComponent(installId)}/report`, { method: 'POST', body })).json;
    },

    /** The desired-state snapshot for this product and device (+ events past `cursor`). */
    async changes(cursor = null, { limit = 200 } = {}) {
      const query = { product, limit };
      if (cursor !== null && cursor !== undefined && cursor !== '') query.cursor = cursor;
      return (await request('/v1/me/changes', { query })).json;
    },
  };
}
