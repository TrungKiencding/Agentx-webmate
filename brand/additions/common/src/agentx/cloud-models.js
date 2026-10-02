const VISION_MODEL_RE = /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|claude|gemini|kimi-k(?:-?3|2\.[5-9])|minimax-m3|llava|qwen.*vl|qwen2.*vl|qwen3.*vl|qwen3\.[5-9]|pixtral|llama.*vision|gemma.*vision|gemma-?[34]|[-_/]vl(?:[-_/]|$)|vision/;
// Transcription models are named far less consistently than vision ones, so
// this covers the common hosted families (OpenAI/Groq Whisper, gpt-4o-transcribe,
// Mistral Voxtral, ElevenLabs Scribe, Deepgram Nova, NVIDIA Canary/Parakeet)
// plus the generic stt/speech-to-text suffixes local gateways tend to use.
const TRANSCRIPTION_MODEL_RE = /whisper|transcribe|transcription|voxtral|scribe|nova-[23]|canary|parakeet|speech[-_]?to[-_]?text|(?:^|[-_/])(?:stt|asr)(?:[-_/]|$)/;

export const AGENTX_CLOUD_PROVIDER_ID = 'webbrain_cloud';

export function normalizeGatewayModels(models) {
  return [...new Set(
    (Array.isArray(models) ? models : [])
      .map((model) => String(model || '').trim())
      .filter(Boolean),
  )];
}

export function isLikelyVisionModel(id) {
  return VISION_MODEL_RE.test(String(id || '').toLowerCase());
}

export function isLikelyTranscriptionModel(id) {
  return TRANSCRIPTION_MODEL_RE.test(String(id || '').toLowerCase());
}

export function gatewayCatalogFromPayload(payload) {
  const entries = Array.isArray(payload?.data) ? payload.data : [];
  const models = [];
  const visionFromInfo = [];
  const transcriptionFromInfo = [];
  for (const entry of entries) {
    const id = String(entry?.id || entry?.model_name || '').trim();
    if (!id) continue;
    models.push(id);
    const flag = entry?.model_info?.supports_vision
      ?? entry?.supports_vision
      ?? entry?.capabilities?.vision;
    if (flag === true) visionFromInfo.push(id);
    // LiteLLM tags transcription deployments with mode "audio_transcription".
    // When the gateway says so we trust it over the name heuristic below.
    const mode = String(entry?.model_info?.mode ?? entry?.mode ?? '').trim().toLowerCase();
    if (mode === 'audio_transcription') transcriptionFromInfo.push(id);
  }
  return {
    models: normalizeGatewayModels(models),
    visionFromInfo: normalizeGatewayModels(visionFromInfo),
    transcriptionFromInfo: normalizeGatewayModels(transcriptionFromInfo),
  };
}

export function visionModelsFromGateway(models, visionFromInfo = []) {
  const list = normalizeGatewayModels(models);
  const advertised = normalizeGatewayModels(visionFromInfo).filter((id) => list.includes(id));
  if (advertised.length) return advertised;
  const guessed = list.filter(isLikelyVisionModel);
  return guessed.length ? guessed : list;
}

/**
 * Same shape as visionModelsFromGateway: prefer what the gateway advertises,
 * fall back to the name heuristic, and offer the whole list when neither
 * narrows it down — a gateway that names its ASR deployment `corp-audio-1`
 * would otherwise leave the picker empty with no way to select anything.
 */
export function transcriptionModelsFromGateway(models, transcriptionFromInfo = []) {
  const list = normalizeGatewayModels(models);
  const advertised = normalizeGatewayModels(transcriptionFromInfo).filter((id) => list.includes(id));
  if (advertised.length) return advertised;
  const guessed = list.filter(isLikelyTranscriptionModel);
  return guessed.length ? guessed : list;
}

/**
 * The models the key service names for a feature rather than for chat — web
 * search, image generation, vision, speech (text-to-speech). The key reaches
 * them; no picker shows them.
 */
export function featureModelsFromKey(body = {}) {
  return normalizeGatewayModels([
    body?.web_search_model,
    body?.image_model,
    body?.vision_model,
    body?.speech_model,
  ]);
}

/**
 * What the chat picker offers: the key service's chat list (`models`, in the
 * order its operator chose — the default leads) as far as LiteLLM serves it
 * right now, never a feature model. LiteLLM's `/models` lists the key's whole
 * allowlist, feature models included, so it decides only what is live, not
 * what is a chat model. With no usable chat list (an older service, or one
 * whose answer lists nothing LiteLLM still serves) every live model but the
 * feature models is offered.
 */
export function chatModelsFromGrant(catalog, serviceModels = [], featureModels = []) {
  const reachable = normalizeGatewayModels(catalog);
  const features = new Set(normalizeGatewayModels(featureModels));
  const live = new Set(reachable);
  const granted = normalizeGatewayModels(serviceModels)
    .filter((id) => !features.has(id) && live.has(id));
  if (granted.length) return granted;
  return reachable.filter((id) => !features.has(id));
}

/**
 * The Settings vision picker: the key service's vision model first (the
 * default), then the chat models that read images themselves.
 */
export function visionModelsForGrant(chatModels, visionFromInfo = [], visionModel = '', catalog = []) {
  const reachable = new Set(normalizeGatewayModels(catalog));
  const preferred = String(visionModel || '').trim();
  const lead = preferred && (!reachable.size || reachable.has(preferred)) ? [preferred] : [];
  return normalizeGatewayModels([...lead, ...visionModelsFromGateway(chatModels, visionFromInfo)]);
}

export function pickGatewayModel(preferred, models, fallback = '') {
  const list = normalizeGatewayModels(models);
  const wanted = String(preferred || '').trim();
  if (wanted && list.includes(wanted)) return wanted;
  const backup = String(fallback || '').trim();
  if (backup && list.includes(backup)) return backup;
  return list[0] || '';
}

export function pickGatewayVisionModel(preferred, visionModels) {
  const list = normalizeGatewayModels(visionModels);
  const wanted = String(preferred || '').trim();
  if (!wanted) return '';
  return list.includes(wanted) ? wanted : '';
}

export function pickGatewayTranscriptionModel(preferred, transcriptionModels) {
  const list = normalizeGatewayModels(transcriptionModels);
  const wanted = String(preferred || '').trim();
  if (!wanted) return '';
  return list.includes(wanted) ? wanted : '';
}

export function resolveCloudVisionSidecar(cloudConfig = {}) {
  if (cloudConfig?.agentxCloudManaged !== true) return null;
  const apiKey = String(cloudConfig.apiKey || '').trim();
  const baseUrl = String(cloudConfig.baseUrl || '').trim();
  if (!apiKey || !baseUrl) return null;
  const models = normalizeGatewayModels(cloudConfig.models);
  // The vision model is a feature model: reachable with the key but not in the
  // chat list, so it is checked against everything the key reaches.
  const reachable = normalizeGatewayModels([...models, ...normalizeGatewayModels(cloudConfig.agentxCloudReachableModels)]);
  const visionModels = normalizeGatewayModels(cloudConfig.agentxCloudVisionModels)
    .filter((model) => reachable.includes(model));
  const allowlist = visionModels.length ? visionModels : models;
  const model = pickGatewayVisionModel(cloudConfig.agentxCloudVisionModel, allowlist);
  if (!model) return null;
  return {
    type: 'openai',
    category: 'cloud',
    label: 'AgentX Cloud Vision',
    providerName: 'agentx-cloud',
    baseUrl,
    model,
    apiKey,
    enabled: true,
    supportsVision: true,
    agentxCloudManaged: true,
    models: allowlist,
  };
}

/**
 * Transcription counterpart of resolveCloudVisionSidecar.
 *
 * Returns the raw endpoint triple rather than a provider instance: transcription
 * posts multipart form data to /audio/transcriptions, so it never goes through
 * OpenAICompatibleProvider. `models` travels with it as the allowlist that
 * transcribeAudio enforces before dispatching.
 */
export function resolveCloudTranscriptionSidecar(cloudConfig = {}) {
  if (cloudConfig?.agentxCloudManaged !== true) return null;
  const apiKey = String(cloudConfig.apiKey || '').trim();
  const baseUrl = String(cloudConfig.baseUrl || '').trim();
  if (!apiKey || !baseUrl) return null;
  const models = normalizeGatewayModels(cloudConfig.models);
  const transcriptionModels = normalizeGatewayModels(cloudConfig.agentxCloudTranscriptionModels)
    .filter((model) => models.includes(model));
  const allowlist = transcriptionModels.length ? transcriptionModels : models;
  const model = pickGatewayTranscriptionModel(cloudConfig.agentxCloudTranscriptionModel, allowlist);
  if (!model) return null;
  return { baseUrl, model, apiKey, models: allowlist };
}
