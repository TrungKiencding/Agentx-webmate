/**
 * The run gate the background hands to cloud-runs.js (`createCloudRunController
 * ({ runGate })`, brand patch 091): a Workmate-driven run — any bridge
 * `cloud_run` or `cloud_workflow_run` — is refused while the signed-in
 * account's AgentX license is read-only, with code `license_read_only` and the
 * license object, so Workmate can say why instead of relaying a gateway 401
 * from halfway through the task.
 *
 * Everything here fails open: no session, no license known, a license service
 * that is down or slow, a service that cannot even be built — the run starts
 * exactly as it did before licensing. The hard stop for a read-only account is
 * the gateway blocking its key; this is what makes the refusal legible.
 */

import { createAgentXCloudService } from './cloud-service.js';

export function createAgentXLicenseRunGate({ api, service = null, serviceOptions = {} } = {}) {
  let cloud = service;
  return async function agentxLicenseRunGate() {
    try {
      if (!cloud) cloud = createAgentXCloudService({ ...serviceOptions, api });
      return await cloud.licenseRunRefusal();
    } catch {
      return null;
    }
  };
}
