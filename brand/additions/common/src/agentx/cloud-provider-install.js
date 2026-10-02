import { AgentXCloudError } from './cloud-service.js';
import {
  normalizeGatewayModels,
  pickGatewayModel,
  pickGatewayTranscriptionModel,
  pickGatewayVisionModel,
  transcriptionModelsFromGateway,
  visionModelsFromGateway,
} from './cloud-models.js';

export const AGENTX_CLOUD_PROVIDER_ID = 'webbrain_cloud';

/**
 * Writes a freshly provisioned gateway credential onto the managed provider and
 * makes it the active one.
 *
 * Both the Settings card and the side-panel sign-in gate provision the same
 * credential, so this lives here rather than in either UI: a model list that
 * one surface accepts and the other rejects would strand the user on whichever
 * screen they happened to sign in from.
 */
export async function installCloudCredential(sendToBackground, credential) {
  const models = Array.isArray(credential.models)
    ? [...new Set(credential.models.map(String).map((model) => model.trim()).filter(Boolean))]
    : [String(credential.model || '').trim()].filter(Boolean);
  // The vision picker leads with the key service's vision model, which is not
  // a chat model; a credential from an older build carries no such list.
  const visionModels = Array.isArray(credential.visionModels) && credential.visionModels.length
    ? normalizeGatewayModels(credential.visionModels)
    : visionModelsFromGateway(models, credential.visionFromInfo);
  const transcriptionModels = transcriptionModelsFromGateway(models, credential.transcriptionFromInfo);
  const current = await sendToBackground('get_providers').catch(() => null);
  const currentConfig = current?.providers?.[AGENTX_CLOUD_PROVIDER_ID] || {};
  const model = pickGatewayModel(currentConfig.model, models, credential.model);
  if (!model) {
    throw new AgentXCloudError(
      'gateway_models_empty',
      'LiteLLM không trả về mô hình nào cho khóa này.',
    );
  }
  // A vision model somebody picked (or cleared) in Settings is theirs; until
  // then the key service's vision model is the default.
  const visionModel = pickGatewayVisionModel(
    currentConfig.agentxCloudVisionModelUserSet === true
      ? currentConfig.agentxCloudVisionModel
      : credential.visionModel || currentConfig.agentxCloudVisionModel,
    visionModels,
  );
  const transcriptionModel = pickGatewayTranscriptionModel(
    currentConfig.agentxCloudTranscriptionModel || credential.transcriptionModel,
    transcriptionModels,
  );
  const installedCredential = {
    ...credential,
    models,
    model,
    visionModels,
    visionModel,
    transcriptionModels,
    transcriptionModel,
  };
  await sendToBackground('update_provider', {
    providerId: AGENTX_CLOUD_PROVIDER_ID,
    markConfigured: false,
    config: {
      apiKey: installedCredential.key,
      baseUrl: installedCredential.baseUrl,
      model: installedCredential.model,
      providerName: 'agentx-cloud',
      models: installedCredential.models,
      // Everything the key reaches, feature models included — what the vision
      // sidecar may call. `models` above is the chat picker only.
      agentxCloudReachableModels: normalizeGatewayModels(
        installedCredential.reachableModels || installedCredential.models,
      ),
      agentxCloudManaged: true,
      agentxCloudAuthority: installedCredential.authority,
      agentxCloudKeyAlias: installedCredential.keyAlias,
      agentxCloudAccount: installedCredential.account,
      agentxCloudVisionModel: installedCredential.visionModel,
      agentxCloudVisionModels: installedCredential.visionModels,
      agentxCloudTranscriptionModel: installedCredential.transcriptionModel,
      agentxCloudTranscriptionModels: installedCredential.transcriptionModels,
    },
  });
  await sendToBackground('set_active_provider', { providerId: AGENTX_CLOUD_PROVIDER_ID });
  return installedCredential;
}

/**
 * Strips the managed credential after a sign-out. The provider entry itself
 * stays so the Settings card can still render its signed-out state.
 */
export async function removeCloudCredential(sendToBackground) {
  await sendToBackground('update_provider', {
    providerId: AGENTX_CLOUD_PROVIDER_ID,
    markConfigured: false,
    config: {
      apiKey: '',
      model: '',
      models: [],
      agentxCloudManaged: false,
      agentxCloudKeyAlias: '',
      agentxCloudAccount: '',
      agentxCloudVisionModel: '',
      agentxCloudVisionModelUserSet: false,
      agentxCloudVisionModels: [],
      agentxCloudReachableModels: [],
      agentxCloudTranscriptionModel: '',
      agentxCloudTranscriptionModels: [],
    },
  });
}
