/**
 * Offscreen document — outbound WebSocket bridge for managed cloud sessions.
 *
 * The droplet sidecar listens on localhost. The extension connects outbound
 * from this offscreen page, receives command messages, forwards them to the
 * background service worker, then returns the response over the socket.
 *
 * Two ways this extension can be installed, and the bridge tells them apart
 * by one packaged file:
 *
 *   • Workmate-managed ("workmate"): AgentX Workmate unpacked this folder and
 *     dropped a `workmate.json` next to the manifest carrying the socket URL
 *     and a pairing token. The file is re-read before every dial (Workmate may
 *     move the port), the URL still has to pass the loopback check below, and
 *     the server has to echo the token back in `hello_ack` or the socket is
 *     dropped — a stray local process on the same port must not be able to
 *     drive the browser just because it speaks the frame format.
 *   • Developer / store ("dev"): no `workmate.json`. Everything behaves as it
 *     always did — Settings URL, no token, protocol v3 hello that a v2 server
 *     simply ignores the extra fields of.
 *
 * An offscreen document has no chrome.* API beyond runtime messaging, so the
 * facts the hello needs — manifest version, sign-in state, the per-profile
 * instance id, the parsed workmate.json — come from the background
 * (`cloud_bridge_identity`, cloud-runs.js) before every dial. Only the
 * loopback check on the URL and the hello_ack token comparison live here, at
 * the socket. A sign-in change after the hello arrives from the background as
 * `cloud-bridge-session` and goes out as a `session` frame, so the server's
 * picture of "signed in" does not wait for a reconnect.
 */

(() => {
  // Provisioning seeds Settings from a privileged extension page before this
  // bridge starts. Keep configuration mutations out of the WebSocket command
  // surface; the bridge is intentionally limited to managed run operations,
  // the two Workmate update hooks (drain, reload) and the two Workmate sign-in
  // hooks (auth_hint: silent prompt=none authorize; auth_open: the interactive
  // sign-in). Neither sign-in hook takes credentials over the socket — they
  // carry at most a login_hint (an email), and the browser's own Keycloak
  // cookies decide whether anything happens.
  const BRIDGE_PROTOCOL_VERSION = 3;
  const BRIDGE_CAPABILITIES = ['saved_workflows_v1', 'run_modes_v1', 'scheduled_jobs_v1', 'workmate_update_v1'];
  const ALLOWED_BRIDGE_ACTIONS = new Set([
    'cloud_run',
    'cloud_workflow_compile',
    'cloud_workflow_run',
    'cloud_status',
    'cloud_scheduled_jobs',
    'cloud_respond',
    'cloud_abort',
    'workmate_prepare_update',
    'workmate_reload',
    'auth_hint',
    'auth_open',
  ]);
  // Ceiling on the reconnect backoff. This dials loopback, so a refused attempt
  // costs a syscall pair and no network traffic — a long ceiling buys nothing
  // and delays the case that matters: the controller was down for a while and
  // has just come back up.
  const MAX_RECONNECT_DELAY_MS = 10000;
  // A WebSocket that never finishes its handshake stays CONNECTING forever, and
  // connect() short-circuits on CONNECTING — so without this the bridge wedges
  // permanently against anything that accepts TCP and then goes quiet.
  const CONNECT_TIMEOUT_MS = 10000;
  // A server that rejects the pairing handshake (wrong token, protocol too old)
  // will reject the next attempt too. Retrying on the normal backoff would hit
  // it twice a second for nothing; hold off for a minute instead.
  const HANDSHAKE_REJECTED_HOLDOFF_MS = 60000;
  let socket = null;
  let bridgeUrl = null;
  let enabled = false;
  let reconnectTimer = null;
  let connectTimer = null;
  let reconnectAttempt = 0;
  let lastError = '';
  let connectedAt = null;
  let dialing = false;
  let holdoffUntil = 0;
  // Snapshot of workmate.json from the most recent dial, or null in dev mode.
  let workmate = null;
  let workmateError = '';
  // From the background's identity answer at the most recent dial.
  let extensionVersion = '';
  let instanceId = '';
  // What the server told us in hello_ack on the current socket.
  let server = null;

  function normalizeBridgeUrl(value) {
    const url = new URL(String(value || 'ws://127.0.0.1:17374/extension'));
    const host = url.hostname.toLowerCase();
    // WHATWG URL keeps the brackets on IPv6 literals: ws://[::1]/… parses to
    // hostname "[::1]", so both spellings must be allowlisted.
    if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
      throw new Error('Cloud bridge URL must use ws:// on localhost.');
    }
    return url.href;
  }

  /**
   * "Chrome 152", "Edge 152", … from the UA-CH brand list. The generic
   * "Chromium" entry is present in every Chromium browser, so it is only the
   * fallback; the legacy UA string covers browsers without userAgentData.
   */
  function describeBrowser() {
    const brands = globalThis.navigator?.userAgentData?.brands;
    if (Array.isArray(brands)) {
      const KNOWN = [
        ['Microsoft Edge', 'Edge'],
        ['Google Chrome', 'Chrome'],
        ['Brave', 'Brave'],
        ['Opera', 'Opera'],
        ['Vivaldi', 'Vivaldi'],
        ['Arc', 'Arc'],
      ];
      for (const [brand, label] of KNOWN) {
        const hit = brands.find(entry => entry?.brand === brand);
        if (hit) return `${label} ${String(hit.version || '').trim()}`.trim();
      }
      const chromium = brands.find(entry => entry?.brand === 'Chromium');
      if (chromium) return `Chromium ${String(chromium.version || '').trim()}`.trim();
    }
    const ua = String(globalThis.navigator?.userAgent || '');
    const edge = /Edg\/(\d+)/.exec(ua);
    if (edge) return `Edge ${edge[1]}`;
    const chrome = /Chrome\/(\d+)/.exec(ua);
    if (chrome) return `Chrome ${chrome[1]}`;
    return ua ? 'Chromium' : null;
  }

  /**
   * Ask the background who we are before dialling: manifest version, whether
   * an AgentX session is signed in (null when it cannot tell — never guessed),
   * and the parsed workmate.json (null in a dev checkout). A background that
   * cannot answer leaves us in dev mode with the Settings URL, which is the
   * behaviour this bridge always had.
   */
  async function requestIdentity() {
    try {
      const identity = await chrome.runtime.sendMessage({ target: 'background', action: 'cloud_bridge_identity' });
      if (identity && typeof identity === 'object' && !identity.error) return identity;
      return { version: '', signedIn: null, workmate: null, workmateError: identity?.error || '' };
    } catch (error) {
      return { version: '', signedIn: null, workmate: null, workmateError: error?.message || String(error) };
    }
  }

  /**
   * Adopt an identity answer. The one check that belongs at the socket is the
   * loopback rule on `wsUrl`: a workmate.json pointing anywhere but this
   * machine is never dialled, and the Settings URL is used instead.
   */
  function applyIdentity(identity) {
    extensionVersion = typeof identity.version === 'string' ? identity.version : '';
    instanceId = typeof identity.instanceId === 'string' ? identity.instanceId : '';
    workmateError = typeof identity.workmateError === 'string' ? identity.workmateError : '';
    const raw = identity.workmate && typeof identity.workmate === 'object' ? identity.workmate : null;
    if (!raw) {
      workmate = null;
      return typeof identity.signedIn === 'boolean' ? identity.signedIn : null;
    }
    let wsUrl = null;
    if (raw.wsUrl != null && raw.wsUrl !== '') {
      try {
        wsUrl = normalizeBridgeUrl(raw.wsUrl);
      } catch (error) {
        workmateError = `workmate.json wsUrl rejected: ${error.message || error}`;
      }
    }
    workmate = {
      wsUrl,
      token: typeof raw.token === 'string' ? raw.token.trim() : '',
      installId: typeof raw.installId === 'string' ? raw.installId : '',
      workmateVersion: typeof raw.workmateVersion === 'string' ? raw.workmateVersion : '',
      minServerVersion: typeof raw.minServerVersion === 'string' ? raw.minServerVersion : '',
    };
    return typeof identity.signedIn === 'boolean' ? identity.signedIn : null;
  }

  function status() {
    return {
      enabled,
      url: bridgeUrl,
      connected: socket?.readyState === WebSocket.OPEN,
      readyState: socket ? socket.readyState : null,
      reconnectAttempt,
      connectedAt,
      lastError,
      installType: workmate ? 'workmate' : 'dev',
      version: extensionVersion,
      instanceId,
      browser: describeBrowser(),
      workmate: workmate
        ? {
            wsUrl: workmate.wsUrl,
            hasToken: Boolean(workmate.token),
            installId: workmate.installId,
            workmateVersion: workmate.workmateVersion,
            minServerVersion: workmate.minServerVersion,
            error: workmateError,
          }
        : (workmateError ? { error: workmateError } : null),
      server,
      holdoffUntil: holdoffUntil > Date.now() ? holdoffUntil : null,
    };
  }

  function clearConnectTimer() {
    if (connectTimer) clearTimeout(connectTimer);
    connectTimer = null;
  }

  function clearReconnectTimer() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function dropSocket(code, reason) {
    clearConnectTimer();
    if (!socket) return;
    const previousSocket = socket;
    socket = null;
    connectedAt = null;
    server = null;
    try {
      // Browsers only accept 1000 or 3000–4999 from the closing side.
      if (code) previousSocket.close(code, reason);
      else previousSocket.close();
    } catch {
      try { previousSocket.close(); } catch {}
    }
  }

  function sendJson(obj, target = socket) {
    if (!target || target.readyState !== WebSocket.OPEN) return;
    try {
      target.send(JSON.stringify(obj));
    } catch (e) {
      lastError = e.message || String(e);
    }
  }

  function scheduleReconnect() {
    if (!enabled || !bridgeUrl || reconnectTimer) return;
    const backoff = Math.min(MAX_RECONNECT_DELAY_MS, 500 * Math.pow(2, reconnectAttempt++));
    const delay = Math.max(backoff, holdoffUntil - Date.now());
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function rejectHandshake(message, closeCode) {
    lastError = message;
    holdoffUntil = Date.now() + HANDSHAKE_REJECTED_HOLDOFF_MS;
    dropSocket(closeCode, message.slice(0, 120));
    scheduleReconnect();
  }

  function helloFrame(signedIn) {
    const hello = {
      type: 'hello',
      client: 'webbrain-extension',
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      version: extensionVersion,
      browser: describeBrowser(),
      installType: workmate ? 'workmate' : 'dev',
      signedIn,
      capabilities: BRIDGE_CAPABILITIES,
      status: status(),
    };
    if (workmate?.token) hello.token = workmate.token;
    if (instanceId) hello.instanceId = instanceId;
    return hello;
  }

  function handleHelloAck(msg, nextSocket) {
    server = {
      version: typeof msg.serverVersion === 'string' ? msg.serverVersion : '',
      minExtensionVersion: typeof msg.minExtensionVersion === 'string' ? msg.minExtensionVersion : '',
      minProtocol: Number.isFinite(msg.minProtocol) ? msg.minProtocol : null,
      tokenEchoed: typeof msg.token === 'string' && msg.token.length > 0,
    };
    if (workmate?.token && msg.token !== workmate.token) {
      if (socket !== nextSocket) return;
      rejectHandshake(
        'The bridge server did not present this installation\'s pairing token; refusing to be driven by it.',
        4008,
      );
      return;
    }
    if (server.minProtocol != null && server.minProtocol > BRIDGE_PROTOCOL_VERSION) {
      lastError = `The bridge server needs bridge protocol v${server.minProtocol}; this extension speaks v${BRIDGE_PROTOCOL_VERSION}. Update the extension.`;
    }
  }

  function openSocket(url, signedIn) {
    try {
      const nextSocket = new WebSocket(url);
      socket = nextSocket;
      server = null;
      clearConnectTimer();
      connectTimer = setTimeout(() => {
        connectTimer = null;
        if (socket !== nextSocket || nextSocket.readyState !== WebSocket.CONNECTING) return;
        lastError = `Handshake did not complete within ${CONNECT_TIMEOUT_MS}ms.`;
        socket = null;
        try { nextSocket.close(); } catch {}
        scheduleReconnect();
      }, CONNECT_TIMEOUT_MS);
      nextSocket.addEventListener('open', () => {
        if (socket !== nextSocket) return;
        clearConnectTimer();
        reconnectAttempt = 0;
        connectedAt = Date.now();
        lastError = '';
        sendJson(helloFrame(signedIn), nextSocket);
      });
      nextSocket.addEventListener('message', async (event) => {
        if (socket !== nextSocket) return;
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch (e) {
          sendJson({ ok: false, error: `Invalid JSON message: ${e.message}` }, nextSocket);
          return;
        }

        if (msg && msg.type === 'hello_ack') {
          handleHelloAck(msg, nextSocket);
          return;
        }

        const id = msg.id || null;
        const action = msg.action || msg.command;
        const payload = msg.payload || msg;
        if (!action) {
          sendJson({ id, ok: false, error: 'Missing action' }, nextSocket);
          return;
        }
        if (!ALLOWED_BRIDGE_ACTIONS.has(action)) {
          sendJson({ id, ok: false, error: `Unsupported cloud bridge action: ${action}` }, nextSocket);
          return;
        }

        try {
          const response = await chrome.runtime.sendMessage({
            ...payload,
            target: 'background',
            action,
          });
          const isRunSnapshot = !!response
            && (response.runId != null || response.run_id != null)
            && typeof response.status === 'string';
          if (response?.error && !isRunSnapshot) {
            // `code` and `license` ride along when the background refused for
            // a reason the caller can act on (AgentX: `license_read_only`).
            sendJson({
              id,
              ok: false,
              error: response.error,
              status: response.status || 500,
              ...(typeof response.code === 'string' && response.code ? { code: response.code } : {}),
              ...(response.license && typeof response.license === 'object' ? { license: response.license } : {}),
            }, nextSocket);
          } else {
            sendJson({ id, ok: true, result: response }, nextSocket);
          }
        } catch (e) {
          sendJson({ id, ok: false, error: e.message || String(e) }, nextSocket);
        }
      });
      nextSocket.addEventListener('close', (event) => {
        if (socket !== nextSocket) return;
        clearConnectTimer();
        socket = null;
        connectedAt = null;
        server = null;
        // 1008 is the server saying the handshake itself was unacceptable —
        // wrong pairing token, protocol too old. Same answer next time, so
        // stop hammering it.
        if (event && event.code === 1008) {
          lastError = `The bridge server rejected the handshake${event.reason ? `: ${event.reason}` : '.'}`;
          holdoffUntil = Date.now() + HANDSHAKE_REJECTED_HOLDOFF_MS;
        }
        scheduleReconnect();
      });
      nextSocket.addEventListener('error', () => {
        if (socket !== nextSocket) return;
        lastError = 'WebSocket error';
      });
    } catch (e) {
      lastError = e.message || String(e);
      socket = null;
      scheduleReconnect();
    }
  }

  function connect() {
    if (!enabled || !bridgeUrl || dialing) return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    if (Date.now() < holdoffUntil) {
      scheduleReconnect();
      return;
    }
    // Re-read the identity (and with it workmate.json) on every dial: Workmate
    // rewrites the file when its port or token changes and then asks for a
    // reload, and a stale copy here would send the old token to the new server.
    dialing = true;
    requestIdentity().then(
      (identity) => {
        dialing = false;
        const signedIn = applyIdentity(identity);
        if (!enabled || !bridgeUrl) return;
        if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
        openSocket(workmate?.wsUrl || bridgeUrl, signedIn);
      },
      (error) => {
        dialing = false;
        lastError = error?.message || String(error);
        scheduleReconnect();
      },
    );
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'cloud-bridge-start') {
      let nextUrl;
      try {
        nextUrl = normalizeBridgeUrl(msg.url || bridgeUrl);
      } catch (error) {
        lastError = error.message || String(error);
        sendResponse({ ...status(), error: lastError });
        return false;
      }
      const changed = bridgeUrl && bridgeUrl !== nextUrl;
      enabled = true;
      bridgeUrl = nextUrl;
      // Only a dev-mode socket follows the Settings URL. A Workmate-managed
      // socket is on workmate.json's URL, which this message does not change.
      if (changed && !workmate?.wsUrl) dropSocket();
      // An explicit start is a fresh intent — from the user, from a cold
      // service worker, or from the watchdog alarm. Waiting out a backoff that
      // may already have grown to its ceiling would make "the controller is up
      // now" take up to MAX_RECONNECT_DELAY_MS to notice, so retry at once.
      // The handshake-rejected holdoff is the one wait an explicit start does
      // not skip: the server's answer will not have changed in the meantime.
      if (!socket) {
        clearReconnectTimer();
        reconnectAttempt = 0;
      }
      connect();
      sendResponse(status());
      return false;
    }
    if (msg.type === 'cloud-bridge-stop') {
      enabled = false;
      clearReconnectTimer();
      reconnectAttempt = 0;
      holdoffUntil = 0;
      dropSocket();
      sendResponse(status());
      return false;
    }
    if (msg.type === 'cloud-bridge-status') {
      sendResponse(status());
      return false;
    }
    if (msg.type === 'cloud-bridge-session') {
      // Relayed by the background when the AgentX session appears or goes;
      // the server updates its "signed in" fact for this socket in place.
      if (typeof msg.signedIn === 'boolean' && socket?.readyState === WebSocket.OPEN) {
        sendJson({ type: 'session', signedIn: msg.signedIn }, socket);
      }
      sendResponse(status());
      return false;
    }
    return false;
  });
})();
