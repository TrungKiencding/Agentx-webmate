import { AGENTX_RUNTIME_CONFIG } from '../agentx/runtime-config.js';
import {
  AGENTX_LICENSE_STORAGE_KEY,
  createAgentXCloudService,
  AgentXCloudError,
} from '../agentx/cloud-service.js';
import {
  AGENTX_CLOUD_PROVIDER_ID,
  installCloudCredential,
  removeCloudCredential,
} from '../agentx/cloud-provider-install.js';
import { transcriptionModelsFromGateway, visionModelsFromGateway } from '../agentx/cloud-models.js';
import {
  bindAgentXCloudPanel,
  bindAgentXCloudTranscriptionPanel,
  bindAgentXCloudVisionPanel,
  renderAgentXCloudPanel,
  renderAgentXCloudTranscriptionPanel,
  renderAgentXCloudVisionPanel,
} from './agentx-cloud-ui.js';

const PROVIDER_ID = AGENTX_CLOUD_PROVIDER_ID;

function publicProvider(credential) {
  if (!credential) return null;
  const models = Array.isArray(credential.models) ? [...credential.models] : [];
  const visionModels = Array.isArray(credential.visionModels)
    ? [...credential.visionModels]
    : visionModelsFromGateway(models);
  const transcriptionModels = Array.isArray(credential.transcriptionModels)
    ? [...credential.transcriptionModels]
    : transcriptionModelsFromGateway(models);
  return {
    account: credential.account || '',
    baseUrl: credential.baseUrl || '',
    model: credential.model || '',
    models,
    visionModel: credential.visionModel || '',
    visionModels,
    transcriptionModel: credential.transcriptionModel || '',
    transcriptionModels,
    keyAlias: credential.keyAlias || '',
    status: credential.status || credential.provisionOutcome || '',
  };
}

function publicError(error) {
  if (!error) return null;
  return {
    code: String(error.code || 'unknown_error'),
    message: String(error.message || 'Unknown error'),
    detail: String(error.detail || ''),
    status: Number(error.status) || 0,
    transient: error.transient === true,
  };
}

/**
 * Bridges the standalone AgentX auth service into the existing provider page.
 * The controller owns only UI state; tokens and plaintext keys never enter DOM.
 */
export function createAgentXCloudSettingsController({
  api,
  locale = () => 'en',
  sendToBackground,
  onProvidersChanged,
  onRender,
  config = AGENTX_RUNTIME_CONFIG,
  serviceOptions = {},
}) {
  if (typeof sendToBackground !== 'function') {
    throw new TypeError('sendToBackground is required');
  }

  const service = createAgentXCloudService({ ...serviceOptions, api, config });
  let running = null;
  let status = {
    signedIn: false,
    connected: false,
    action: 'restoring',
    error: null,
    provider: null,
    // The account's AgentX license as last reported by the keys service; null
    // while none is known (signed out, or an SSO from before licensing).
    license: null,
    configuredLiteLlmBaseUrl: config.litellmBaseUrl,
    secondBrainBaseUrl: config.secondBrainBaseUrl,
  };

  function paint(patch = {}) {
    status = { ...status, ...patch };
    onRender?.();
    return status;
  }

  /**
   * The license to show once the key is installed: a check (throttled, or
   * `force` when the user asked for one) — a cached key LiteLLM still accepts
   * never reaches the keys service, so this is how the card learns of it.
   * Never throws; a failed check keeps the last license recorded.
   */
  async function checkedLicense({ force = false } = {}) {
    const checked = await service.refreshLicense({ force }).catch(() => null);
    if (checked) return checked.signedIn ? checked.license : null;
    return recordedLicense();
  }

  /** After a failure: the license a refusal carried, else the last one recorded. No network. */
  async function recordedLicense(error = null) {
    if (error?.license) return error.license;
    const known = await service.knownLicense().catch(() => null);
    return known?.signedIn ? known.license : null;
  }

  // The panel, or a Workmate-driven run in the background, may learn of a new
  // license while this page is open: follow the record.
  api?.storage?.onChanged?.addListener?.((changes, area) => {
    if (area && area !== 'local') return;
    if (!changes || !(AGENTX_LICENSE_STORAGE_KEY in changes) || !status.signedIn) return;
    void service.knownLicense().then((known) => {
      if (!known.signedIn || !status.signedIn) return;
      if (JSON.stringify(known.license) === JSON.stringify(status.license)) return;
      paint({ license: known.license });
    }).catch(() => {});
  });

  // The composer model chip writes the same provider entry this card renders
  // (update_provider with { model }), so a Settings page left open must follow
  // storage instead of keeping the model that was current at initialize time.
  // Managed catalog fields only — session state and credentials stay owned by
  // the flows below, and a cleared entry (sign-out in flight) is ignored so
  // the card never repaints half-removed values before the sign-out settles.
  api?.storage?.onChanged?.addListener?.((changes, area) => {
    if (area && area !== 'local') return;
    const config = changes?.providers?.newValue?.[PROVIDER_ID];
    if (!config || typeof config !== 'object') return;
    if (config.agentxCloudManaged !== true || !String(config.apiKey || '').trim()) return;
    if (!status.connected || !status.provider) return;
    const list = (value, fallback) => (Array.isArray(value) && value.length
      ? value.map(String)
      : fallback);
    const next = {
      ...status.provider,
      model: String(config.model || ''),
      models: list(config.models, status.provider.models),
      visionModel: String(config.agentxCloudVisionModel || ''),
      visionModels: list(config.agentxCloudVisionModels, status.provider.visionModels),
      transcriptionModel: String(config.agentxCloudTranscriptionModel || ''),
      transcriptionModels: list(config.agentxCloudTranscriptionModels, status.provider.transcriptionModels),
    };
    if (JSON.stringify(next) === JSON.stringify(status.provider)) return;
    paint({ provider: next });
  });

  async function refreshProviders() {
    const refreshed = await sendToBackground('get_providers');
    onProvidersChanged?.(refreshed);
    return refreshed;
  }

  async function installCredential(credential) {
    const installedCredential = await installCloudCredential(sendToBackground, credential);
    await refreshProviders();
    return installedCredential;
  }

  async function removeProviderCredential() {
    await removeCloudCredential(sendToBackground);
    await refreshProviders();
  }

  async function statusFromSession(extra = {}) {
    const sessionStatus = await service.publicStatus();
    return {
      ...sessionStatus,
      connected: status.connected,
      provider: status.provider,
      ...extra,
    };
  }

  async function connectWith(operation, { forceLicense = false } = {}) {
    const result = await operation();
    const installedCredential = await installCredential(result.credential);
    const license = await checkedLicense({ force: forceLicense });
    paint({
      ...(await statusFromSession()),
      signedIn: true,
      connected: true,
      action: null,
      error: null,
      provider: publicProvider(installedCredential),
      license,
      outcome: result.credential.provisionOutcome || result.credential.status || 'connected',
      warningCode: result.credential.warningCode || '',
      persistenceWarning: result.persistenceWarning || '',
      testOk: false,
      testModel: '',
    });
  }

  async function initialize() {
    if (running) return running;
    running = (async () => {
      paint({ action: 'restoring', error: null });
      try {
        const restored = await service.publicStatus();
        if (!restored.signedIn) {
          paint({
            ...restored,
            connected: false,
            provider: null,
            license: null,
            action: null,
            error: null,
          });
          return;
        }
        paint({ ...restored, signedIn: true, action: 'provisioning' });
        await connectWith(() => service.retryProvision());
      } catch (error) {
        const latest = await service.publicStatus().catch(() => ({ signedIn: false }));
        paint({
          ...latest,
          connected: false,
          provider: null,
          license: latest.signedIn ? await recordedLicense(error) : null,
          action: null,
          error: publicError(error),
        });
      } finally {
        running = null;
      }
    })();
    return running;
  }

  async function perform(action, payload = {}) {
    if (running) return running;
    running = (async () => {
      const actionName = {
        'sign-in': 'signing-in',
        retry: 'provisioning',
        test: 'testing',
        'select-model': 'selecting-model',
        'select-vision-model': 'selecting-vision-model',
        'test-vision': 'testing-vision',
        'clear-vision': 'clearing-vision',
        'select-transcription-model': 'selecting-transcription-model',
        'test-transcription': 'testing-transcription',
        'clear-transcription': 'clearing-transcription',
        'sign-out': 'signing-out',
      }[action];
      if (!actionName) return;
      // Clear every panel's success banner up front, so a passing vision test
      // does not keep claiming success while the user is off switching the
      // transcription model (and vice versa).
      paint({
        action: actionName,
        error: null,
        testOk: false,
        testModel: '',
        visionTestOk: false,
        visionTestModel: '',
        transcriptionTestOk: false,
        transcriptionTestModel: '',
      });
      try {
        if (action === 'sign-in') {
          await connectWith(() => service.signInAndProvision());
          return;
        }
        if (action === 'retry') {
          // Also the "Kiểm tra lại" of a read-only account: ask for the
          // license now rather than within the usual interval.
          await connectWith(() => service.retryProvision(), { forceLicense: true });
          return;
        }
        if (action === 'test') {
          const result = await sendToBackground('test_provider', { providerId: PROVIDER_ID });
          if (!result?.ok) {
            throw new AgentXCloudError(
              'gateway_test_failed',
              result?.error || 'LiteLLM gateway connection test failed.',
            );
          }
          paint({
            action: null,
            error: null,
            testOk: true,
            testModel: result.model || status.provider?.model || '',
          });
          return;
        }
        if (action === 'select-model') {
          const model = String(payload.model || '').trim();
          const availableModels = Array.isArray(status.provider?.models)
            ? status.provider.models
            : [];
          if (!model || !availableModels.includes(model)) {
            throw new AgentXCloudError(
              'invalid_model_selection',
              'Mô hình bạn chọn không có trong danh sách mà cổng cấp.',
            );
          }
          await sendToBackground('update_provider', {
            providerId: PROVIDER_ID,
            markConfigured: false,
            config: { model },
          });
          await refreshProviders();
          paint({
            action: null,
            error: null,
            provider: { ...status.provider, model },
            testOk: false,
            testModel: '',
            visionTestOk: false,
            visionTestModel: '',
          });
          return;
        }
        if (action === 'select-vision-model') {
          const model = String(payload.model || '').trim();
          const availableModels = Array.isArray(status.provider?.visionModels)
            ? status.provider.visionModels
            : [];
          if (model && !availableModels.includes(model)) {
            throw new AgentXCloudError(
              'invalid_vision_model_selection',
              'Mô hình đọc ảnh bạn chọn không có trong danh sách mà cổng này cấp.',
            );
          }
          await sendToBackground('update_provider', {
            providerId: PROVIDER_ID,
            markConfigured: false,
            config: { agentxCloudVisionModel: model, agentxCloudVisionModelUserSet: true },
          });
          await refreshProviders();
          paint({
            action: null,
            error: null,
            provider: { ...status.provider, visionModel: model },
            visionTestOk: false,
            visionTestModel: '',
          });
          return;
        }
        if (action === 'test-vision') {
          if (!String(status.provider?.visionModel || '').trim()) {
            throw new AgentXCloudError(
              'vision_model_required',
              'Hãy chọn mô hình đọc ảnh trên Cloud trước khi kiểm tra kết nối.',
            );
          }
          const result = await sendToBackground('test_vision_provider');
          if (!result?.ok) {
            throw new AgentXCloudError(
              'gateway_vision_test_failed',
              result?.error || 'Không kiểm tra được kết nối đọc ảnh qua LiteLLM.',
            );
          }
          paint({
            action: null,
            error: null,
            visionTestOk: true,
            visionTestModel: result.model || status.provider?.visionModel || '',
          });
          return;
        }
        if (action === 'clear-vision') {
          await sendToBackground('update_provider', {
            providerId: PROVIDER_ID,
            markConfigured: false,
            config: { agentxCloudVisionModel: '', agentxCloudVisionModelUserSet: true },
          });
          await refreshProviders();
          paint({
            action: null,
            error: null,
            provider: { ...status.provider, visionModel: '' },
            visionTestOk: false,
            visionTestModel: '',
          });
          return;
        }
        if (action === 'select-transcription-model') {
          const model = String(payload.model || '').trim();
          const availableModels = Array.isArray(status.provider?.transcriptionModels)
            ? status.provider.transcriptionModels
            : [];
          if (model && !availableModels.includes(model)) {
            throw new AgentXCloudError(
              'invalid_transcription_model_selection',
              'Mô hình chép lời bạn chọn không có trong danh sách mà cổng này cấp.',
            );
          }
          await sendToBackground('update_provider', {
            providerId: PROVIDER_ID,
            markConfigured: false,
            config: { agentxCloudTranscriptionModel: model },
          });
          await refreshProviders();
          paint({
            action: null,
            error: null,
            provider: { ...status.provider, transcriptionModel: model },
            transcriptionTestOk: false,
            transcriptionTestModel: '',
          });
          return;
        }
        if (action === 'test-transcription') {
          if (!String(status.provider?.transcriptionModel || '').trim()) {
            throw new AgentXCloudError(
              'transcription_model_required',
              'Hãy chọn mô hình chép lời trên Cloud trước khi kiểm tra kết nối.',
            );
          }
          const result = await sendToBackground('test_transcription_provider');
          if (!result?.ok) {
            throw new AgentXCloudError(
              'gateway_transcription_test_failed',
              result?.error || 'Không kiểm tra được kết nối chép lời qua LiteLLM.',
            );
          }
          paint({
            action: null,
            error: null,
            transcriptionTestOk: true,
            transcriptionTestModel: result.model || status.provider?.transcriptionModel || '',
          });
          return;
        }
        if (action === 'clear-transcription') {
          await sendToBackground('update_provider', {
            providerId: PROVIDER_ID,
            markConfigured: false,
            config: { agentxCloudTranscriptionModel: '' },
          });
          await refreshProviders();
          paint({
            action: null,
            error: null,
            provider: { ...status.provider, transcriptionModel: '' },
            transcriptionTestOk: false,
            transcriptionTestModel: '',
          });
          return;
        }
        await service.signOut();
        await removeProviderCredential();
        paint({
          ...(await service.publicStatus()),
          signedIn: false,
          connected: false,
          provider: null,
          license: null,
          action: null,
          error: null,
          testOk: false,
          testModel: '',
          visionTestOk: false,
          visionTestModel: '',
          transcriptionTestOk: false,
          transcriptionTestModel: '',
        });
      } catch (error) {
        const latest = await service.publicStatus().catch(() => ({
          signedIn: status.signedIn,
        }));
        paint({
          ...latest,
          connected: status.connected,
          provider: status.provider,
          license: latest.signedIn ? await recordedLicense(error) : null,
          action: null,
          error: publicError(error),
        });
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return {
    bind(root) {
      bindAgentXCloudPanel(root, (action, payload) => void perform(action, payload));
    },
    bindVision(root) {
      bindAgentXCloudVisionPanel(root, (action, payload) => void perform(action, payload));
    },
    bindTranscription(root) {
      bindAgentXCloudTranscriptionPanel(root, (action, payload) => void perform(action, payload));
    },
    initialize,
    selectModel(model) {
      return perform('select-model', { model });
    },
    selectVisionModel(model) {
      return perform('select-vision-model', { model });
    },
    selectTranscriptionModel(model) {
      return perform('select-transcription-model', { model });
    },
    isConnected() {
      return status.connected === true;
    },
    render() {
      return renderAgentXCloudPanel(status, locale());
    },
    renderVision() {
      return renderAgentXCloudVisionPanel(status, locale());
    },
    renderTranscription() {
      return renderAgentXCloudTranscriptionPanel(status, locale());
    },
    status() {
      return { ...status };
    },
  };
}
