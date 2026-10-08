/**
 * The AgentX license in front of every AI call the extension's background
 * makes. While the signed-in account's last known license is read-only there
 * is no AI in WebMate at all — whichever provider would answer, the managed
 * gateway or one the person configured with their own key. Brand patch 091
 * puts it in front of:
 *
 *   - every agent run (the run-start guard): side-panel chat and streaming,
 *     continuations, saved-workflow replays, scheduled runs, bridge runs;
 *   - Workmate-driven bridge runs (cloud-runs.js `runGate`), refused with
 *     `license_read_only` and the license before anything happens;
 *   - scheduled and watch jobs (scheduler.js `runGate`): held — queued,
 *     retried, never failed — and released as soon as the license allows AI;
 *   - user-memory extraction after a turn (held in its queue);
 *   - conversation compaction and the Settings connection tests;
 *   - Tab Recorder transcription (Chrome).
 *
 * Everything here fails open: no session, no license known, a license service
 * that is down or slow, a service that cannot even be built — AI runs exactly
 * as it did before licensing. The hard stop for a read-only account is the
 * gateway blocking its key; this is what keeps the app from trying, and says
 * why.
 */

import { AGENTX_LICENSE_STORAGE_KEY, createAgentXCloudService } from './cloud-service.js';
import { LICENSE_READ_ONLY_CODE } from './license.js';
import { licenseReadOnlySentence, licenseReinstateSentence } from '../ui/agentx-license-copy.js';

/** Whether `error` is a license refusal thrown by this gate. */
export function isLicenseRefusalError(error) {
  return error?.code === LICENSE_READ_ONLY_CODE;
}

export function createAgentXLicenseGate({
  api,
  service = null,
  serviceOptions = {},
  locale = () => 'vi',
} = {}) {
  let cloud = service;

  function cloudService() {
    if (!cloud) cloud = createAgentXCloudService({ ...serviceOptions, api });
    return cloud;
  }

  /**
   * null while AI may run; else `{ status: 403, code: 'license_read_only',
   * message, license }` with an English message for the calling agent (the
   * bridge). Never throws.
   */
  async function refusal() {
    try {
      return await cloudService().licenseRunRefusal();
    } catch {
      return null;
    }
  }

  function language() {
    try {
      return String(locale() || 'vi');
    } catch {
      return 'vi';
    }
  }

  /**
   * The same refusal worded for the person, in the UI language — the
   * sentences the side panel's license screen shows.
   */
  async function userRefusal() {
    const found = await refusal();
    if (!found) return null;
    const lang = language();
    return {
      ...found,
      message: `${licenseReadOnlySentence(found.license, lang)} ${licenseReinstateSentence(found.license, lang)}`,
    };
  }

  /** Throws the person-facing refusal as an Error carrying `code`, `status` and `license`. */
  async function assertAllowed() {
    const found = await userRefusal();
    if (!found) return;
    throw Object.assign(new Error(found.message), {
      code: found.code,
      status: found.status,
      license: found.license,
    });
  }

  /**
   * Calls `listener` whenever a license answer is recorded (by the panel,
   * Settings or a bridge run) — the moment held work may be released. Returns
   * the unsubscribe function.
   */
  function onLicenseRecorded(listener) {
    const onChanged = (changes, area) => {
      if (area !== 'local' || !changes || !(AGENTX_LICENSE_STORAGE_KEY in changes)) return;
      try {
        listener();
      } catch { /* a listener must not break the others */ }
    };
    api?.storage?.onChanged?.addListener?.(onChanged);
    return () => api?.storage?.onChanged?.removeListener?.(onChanged);
  }

  return { refusal, userRefusal, assertAllowed, onLicenseRecorded };
}
