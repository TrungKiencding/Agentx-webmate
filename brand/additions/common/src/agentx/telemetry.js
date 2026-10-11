/** Operational metrics for completed agent turns; never prompts, page URLs or raw errors. */
export function createUsageReporter({ cloud, api, fetchImpl = globalThis.fetch, now = () => performance.now(), uuid = () => crypto.randomUUID(), userAgent = globalThis.navigator?.userAgent || '' }) {
  const runs = new Map();
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /OPR\//.test(userAgent) ? 'Opera' : /Firefox\//.test(userAgent) ? 'Firefox' : /Chrome\//.test(userAgent) ? 'Chrome' : 'Other';
  function begin(key, mode) {
    if (runs.size >= 256) runs.delete(runs.keys().next().value);
    const identity = Promise.resolve().then(() => cloud.readSession()).catch(() => null);
    runs.set(key, { started: now(), mode, identity });
  }
  async function end(key, status) {
    const run = runs.get(key);
    if (!run) return false;
    runs.delete(key);
    if (['cancelled', 'scheduled_resume'].includes(status)) return false;
    try {
      const first = await run.identity;
      if (!first?.user?.subject) return false;
      const current = await cloud.telemetrySession();
      if (!current?.accessToken || current.user?.subject !== first.user.subject) return false;
      const issuer = new URL(current.issuer);
      if (issuer.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(issuer.hostname)) return false;
      const platform = await api.runtime.getPlatformInfo();
      const os = { win: 'Windows', mac: 'macOS', linux: 'Linux', android: 'Android' }[platform.os] || 'Other';
      const failed = status !== 'done';
      const event = { product: 'agentx-webmate', event_id: uuid(), occurred_at: new Date().toISOString(),
        feature: run.mode === 'act' ? 'agent.run' : 'chat.turn', outcome: failed ? 'failure' : 'success',
        version: api.runtime.getManifest().version, os, browser,
        duration_ms: Math.min(3600000, Math.max(0, Math.round(now() - run.started))),
        ...(failed ? { error_code: 'operation_failed' } : {}) };
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetchImpl(`${issuer.origin}/sso/api/analytics/events`, {
            method: 'POST', credentials: 'omit', redirect: 'error',
            headers: { Authorization: `Bearer ${current.accessToken}`, 'Content-Type': 'application/json', 'X-SSO-Request': '1' },
            body: JSON.stringify({ events: [event] }), signal: AbortSignal.timeout(3000) });
          if (response.status === 202) return true;
          if (response.status < 500 && response.status !== 429) return false;
        } catch { /* a retry keeps the same event UUID */ }
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 1000));
      }
    } catch { /* operational metrics must never change a run result */ }
    return false;
  }
  return { begin, end };
}
