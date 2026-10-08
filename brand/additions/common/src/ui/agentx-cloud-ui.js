import { isLicenseReadOnly, isLicenseRefusalCode } from '../agentx/license.js';
import {
  formatLicenseDay,
  licenseNoticeSentence,
  licenseReadOnlySentence,
  licenseReinstateSentence,
  licenseStateLabel,
} from './agentx-license-copy.js';

const COPY = {
  en: {
    eyebrow: 'ACCOUNT CONNECTION',
    titleSignedOut: 'Sign in to use WebMate Cloud',
    bodySignedOut: 'Your browser opens the organization’s Keycloak sign-in page. AgentX WebMate never receives your password.',
    signIn: 'Sign in to WebMate',
    signingIn: 'Opening secure sign-in…',
    restoring: 'Restoring your secure session…',
    provisioning: 'Creating your Cloud connection…',
    signedInNotConnected: 'Your identity is verified. Finish connecting the model gateway.',
    retry: 'Connect gateway',
    retrying: 'Connecting gateway…',
    connected: 'Connected',
    sessionOffline: 'Identity refresh is temporarily unavailable. Your existing model key is still active and has not been replaced.',
    persistenceWarning: 'This browser could not persist the refreshed session. Cloud works until the extension restarts.',
    gateway: 'Gateway',
    model: 'Active model',
    chooseModel: 'Choose active model',
    switchingModel: 'Switching model…',
    switchingVisionModel: 'Switching vision model…',
    device: 'This device',
    account: 'Account',
    modelsAvailable: '{count} models available',
    test: 'Test connection',
    testing: 'Testing connection…',
    testPassed: 'Connection verified with {model}.',
    signOut: 'Sign out',
    signingOut: 'Signing out…',
    keyProtected: 'The model key is stored locally and is never displayed in Settings.',
    visionTitle: 'Cloud vision model',
    visionBodySignedOut: 'Sign in on the Providers tab to choose a Cloud vision model. The same model key is used; it is never shown here.',
    visionBodyDisconnected: 'Finish connecting the Cloud gateway on the Providers tab before choosing a vision model.',
    visionModel: 'Vision model',
    chooseVisionModel: 'Choose vision model',
    visionNone: 'Not selected — the model chosen in the chat bar reads images itself',
    visionModelsAvailable: '{count} vision models available',
    visionTest: 'Test vision connection',
    visionTesting: 'Testing vision connection…',
    visionTestPassed: 'Vision connection verified with {model}.',
    visionClear: 'Clear vision model',
    visionClearing: 'Clearing vision model…',
    visionHint: 'Screenshots are sent to this Cloud model with the same locally stored model key.',
    vision_model_required: 'Choose a Cloud vision model before testing the connection.',
    invalid_vision_model_selection: 'The selected vision model is not available through this gateway key.',
    gateway_vision_test_failed: 'The Cloud vision connection test failed.',
    switchingTranscriptionModel: 'Switching transcription model…',
    transcriptionTitle: 'Cloud transcription model',
    transcriptionBodySignedOut: 'Sign in on the Providers tab to choose a Cloud transcription model. The same model key is used; it is never shown here.',
    transcriptionBodyDisconnected: 'Finish connecting the Cloud gateway on the Providers tab before choosing a transcription model.',
    transcriptionModel: 'Transcription model',
    chooseTranscriptionModel: 'Choose transcription model',
    transcriptionNone: 'Not selected — Tab Recorder transcription stays off',
    transcriptionModelsAvailable: '{count} transcription models available',
    transcriptionTest: 'Test transcription connection',
    transcriptionTesting: 'Testing transcription connection…',
    transcriptionTestPassed: 'Transcription connection verified with {model}.',
    transcriptionClear: 'Clear transcription model',
    transcriptionClearing: 'Clearing transcription model…',
    transcriptionHint: 'Tab Recorder audio is sent to this Cloud model with the same locally stored model key.',
    transcription_model_required: 'Choose a Cloud transcription model before testing the connection.',
    invalid_transcription_model_selection: 'The selected transcription model is not available through this gateway key.',
    gateway_transcription_test_failed: 'The Cloud transcription connection test failed.',
    needs_login: 'Your session is no longer valid. Sign in again; AgentX WebMate will fetch the account’s current key without rotating it.',
    invalid_token: 'Second Brain rejected the identity token. Sign in again.',
    missing_bearer: 'The identity request did not include a valid bearer token. Sign in again.',
    device_revoked: 'This device has been revoked. The saved model key was kept, but Cloud is disconnected until you sign in again.',
    identity_unavailable: 'Keycloak verification is temporarily unavailable. The current model key was kept.',
    store_unavailable: 'Second Brain storage is temporarily unavailable. The current model key was kept.',
    litellm_unavailable: 'LiteLLM is temporarily unavailable. The current model key was kept.',
    litellm_unconfigured: 'Second Brain has no LiteLLM admin key. Ask the operator to finish the server configuration.',
    key_unreadable: 'Second Brain could not decrypt the saved key. The current local key was kept.',
    sign_in_cancelled: 'Sign-in was cancelled before it completed.',
    sign_in_timeout: 'Sign-in exceeded five minutes. Start the flow again.',
    genericError: 'Cloud connection failed. {detail}',
    license: 'AgentX license',
    licenseStartsOn: 'Starts',
    licenseLastDay: 'Last day',
    licenseContact: 'Contact',
    licenseRecheck: 'Check again',
    checkingLicense: 'Checking your license…',
  },
  vi: {
    eyebrow: 'KẾT NỐI TÀI KHOẢN',
    titleSignedOut: 'Đăng nhập để dùng WebMate Cloud',
    bodySignedOut: 'Trình duyệt sẽ mở trang đăng nhập Keycloak của tổ chức. AgentX WebMate không nhận mật khẩu của bạn.',
    signIn: 'Đăng nhập WebMate',
    signingIn: 'Đang mở trang đăng nhập bảo mật…',
    restoring: 'Đang khôi phục phiên đăng nhập…',
    provisioning: 'Đang tạo kết nối Cloud…',
    signedInNotConnected: 'Đã xác minh tài khoản. Còn một bước nữa: kết nối tới cổng mô hình.',
    retry: 'Kết nối cổng',
    retrying: 'Đang kết nối cổng…',
    connected: 'Đã kết nối',
    sessionOffline: 'Tạm thời chưa làm mới được phiên đăng nhập. Khóa mô hình hiện tại vẫn dùng được, chưa bị thay.',
    persistenceWarning: 'Trình duyệt không lưu được phiên vừa làm mới. Cloud vẫn chạy đến khi tiện ích khởi động lại.',
    gateway: 'Cổng',
    model: 'Mô hình đang dùng',
    chooseModel: 'Chọn mô hình đang dùng',
    switchingModel: 'Đang đổi mô hình…',
    switchingVisionModel: 'Đang đổi mô hình đọc ảnh…',
    device: 'Thiết bị này',
    account: 'Tài khoản',
    modelsAvailable: 'Có {count} mô hình',
    test: 'Kiểm tra kết nối',
    testing: 'Đang kiểm tra kết nối…',
    testPassed: 'Đã kiểm tra xong kết nối với {model}.',
    signOut: 'Đăng xuất',
    signingOut: 'Đang đăng xuất…',
    keyProtected: 'Khóa mô hình được lưu trên máy và không hiện trong Cài đặt.',
    visionTitle: 'Mô hình đọc ảnh trên Cloud',
    visionBodySignedOut: 'Hãy đăng nhập ở tab Nhà cung cấp để chọn mô hình đọc ảnh trên Cloud. Nó dùng chung khóa mô hình, và khóa không hiện ở đây.',
    visionBodyDisconnected: 'Hãy hoàn tất kết nối cổng Cloud ở tab Nhà cung cấp trước khi chọn mô hình đọc ảnh.',
    visionModel: 'Mô hình đọc ảnh',
    chooseVisionModel: 'Chọn mô hình đọc ảnh',
    visionNone: 'Chưa chọn — mô hình đang chọn ở khung chat sẽ tự đọc ảnh',
    visionModelsAvailable: 'Có {count} mô hình đọc ảnh',
    visionTest: 'Kiểm tra kết nối đọc ảnh',
    visionTesting: 'Đang kiểm tra kết nối đọc ảnh…',
    visionTestPassed: 'Đã kiểm tra xong kết nối đọc ảnh với {model}.',
    visionClear: 'Bỏ chọn mô hình đọc ảnh',
    visionClearing: 'Đang bỏ chọn mô hình đọc ảnh…',
    visionHint: 'Ảnh chụp màn hình được gửi tới mô hình Cloud này bằng chính khóa mô hình đã lưu trên máy.',
    vision_model_required: 'Hãy chọn mô hình đọc ảnh trên Cloud trước khi kiểm tra kết nối.',
    invalid_vision_model_selection: 'Mô hình đọc ảnh bạn chọn không có trong danh sách mà cổng này cấp.',
    gateway_vision_test_failed: 'Không kiểm tra được kết nối đọc ảnh trên Cloud.',
    switchingTranscriptionModel: 'Đang đổi mô hình chép lời…',
    transcriptionTitle: 'Mô hình chép lời trên Cloud',
    transcriptionBodySignedOut: 'Hãy đăng nhập ở tab Nhà cung cấp để chọn mô hình chép lời trên Cloud. Nó dùng chung khóa mô hình, và khóa không hiện ở đây.',
    transcriptionBodyDisconnected: 'Hãy hoàn tất kết nối cổng Cloud ở tab Nhà cung cấp trước khi chọn mô hình chép lời.',
    transcriptionModel: 'Mô hình chép lời',
    chooseTranscriptionModel: 'Chọn mô hình chép lời',
    transcriptionNone: 'Chưa chọn — bộ Ghi màn hình tab sẽ không chép lời',
    transcriptionModelsAvailable: 'Có {count} mô hình chép lời',
    transcriptionTest: 'Kiểm tra kết nối chép lời',
    transcriptionTesting: 'Đang kiểm tra kết nối chép lời…',
    transcriptionTestPassed: 'Đã kiểm tra xong kết nối chép lời với {model}.',
    transcriptionClear: 'Bỏ chọn mô hình chép lời',
    transcriptionClearing: 'Đang bỏ chọn mô hình chép lời…',
    transcriptionHint: 'Âm thanh từ bộ Ghi màn hình tab được gửi tới mô hình Cloud này bằng chính khóa mô hình đã lưu trên máy.',
    transcription_model_required: 'Hãy chọn mô hình chép lời trên Cloud trước khi kiểm tra kết nối.',
    invalid_transcription_model_selection: 'Mô hình chép lời bạn chọn không có trong danh sách mà cổng này cấp.',
    gateway_transcription_test_failed: 'Không kiểm tra được kết nối chép lời trên Cloud.',
    needs_login: 'Phiên đăng nhập không còn hợp lệ. Hãy đăng nhập lại; AgentX WebMate sẽ lấy khóa hiện tại của tài khoản và không tự đổi khóa.',
    invalid_token: 'Second Brain từ chối token đăng nhập. Hãy đăng nhập lại.',
    missing_bearer: 'Yêu cầu xác minh tài khoản thiếu bearer token hợp lệ. Hãy đăng nhập lại.',
    device_revoked: 'Thiết bị này đã bị thu hồi. Khóa mô hình đã lưu vẫn còn, nhưng Cloud sẽ ngắt cho tới khi bạn đăng nhập lại.',
    identity_unavailable: 'Keycloak tạm thời không xác minh được tài khoản. Khóa mô hình hiện tại vẫn được giữ.',
    store_unavailable: 'Kho dữ liệu Second Brain tạm thời chưa sẵn sàng. Khóa mô hình hiện tại vẫn được giữ.',
    litellm_unavailable: 'LiteLLM tạm thời chưa sẵn sàng. Khóa mô hình hiện tại vẫn được giữ.',
    litellm_unconfigured: 'Second Brain chưa có khóa quản trị LiteLLM. Hãy nhờ quản trị viên hoàn tất phần cấu hình máy chủ.',
    key_unreadable: 'Second Brain không giải mã được khóa đã lưu. Khóa mô hình trên máy vẫn được giữ nguyên.',
    sign_in_cancelled: 'Đăng nhập bị hủy giữa chừng.',
    sign_in_timeout: 'Quá 5 phút chưa đăng nhập xong. Hãy làm lại từ đầu.',
    genericError: 'Không kết nối được Cloud. {detail}',
    license: 'Giấy phép AgentX',
    licenseStartsOn: 'Bắt đầu',
    licenseLastDay: 'Ngày cuối',
    licenseContact: 'Liên hệ',
    licenseRecheck: 'Kiểm tra lại',
    checkingLicense: 'Đang kiểm tra giấy phép…',
  },
};

function language(locale) {
  return String(locale || '').toLowerCase().startsWith('vi') ? 'vi' : 'en';
}

function copy(locale, key, params = {}) {
  let value = COPY[language(locale)][key] || COPY.en[key] || key;
  for (const [name, replacement] of Object.entries(params)) {
    value = value.replaceAll(`{${name}}`, String(replacement));
  }
  return value;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function displayHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return String(value || '—');
  }
}

function actionLabel(status, locale) {
  if (['sign-in', 'signing-in'].includes(status.action)) return copy(locale, 'signingIn');
  if (status.action === 'restoring') return copy(locale, 'restoring');
  if (status.action === 'provisioning') return copy(locale, 'provisioning');
  if (['retry', 'retrying'].includes(status.action)) return copy(locale, 'retrying');
  if (['test', 'testing'].includes(status.action)) return copy(locale, 'testing');
  if (status.action === 'selecting-model') return copy(locale, 'switchingModel');
  if (status.action === 'selecting-vision-model') return copy(locale, 'switchingVisionModel');
  if (['test-vision', 'testing-vision'].includes(status.action)) return copy(locale, 'visionTesting');
  if (['clear-vision', 'clearing-vision'].includes(status.action)) return copy(locale, 'visionClearing');
  if (status.action === 'selecting-transcription-model') return copy(locale, 'switchingTranscriptionModel');
  if (['test-transcription', 'testing-transcription'].includes(status.action)) return copy(locale, 'transcriptionTesting');
  if (['clear-transcription', 'clearing-transcription'].includes(status.action)) return copy(locale, 'transcriptionClearing');
  if (['sign-out', 'signing-out'].includes(status.action)) return copy(locale, 'signingOut');
  if (status.action === 'checking-license') return copy(locale, 'checkingLicense');
  return '';
}

function errorMessage(status, locale) {
  const errorCode = status.errorCode || status.error?.code;
  if (!errorCode) return '';
  // The license block says why, with the plan, the date and whom to ask.
  if (isLicenseRefusalCode(errorCode) && status.license) return '';
  const translated = COPY[language(locale)][errorCode] || COPY.en[errorCode];
  if (translated) return translated;
  return copy(locale, 'genericError', {
    detail: status.errorMessage || status.error?.message || errorCode,
  });
}

function renderNotice(kind, message) {
  if (!message) return '';
  const icon = kind === 'error' ? '!' : kind === 'success' ? '✓' : 'i';
  const role = kind === 'error' ? 'alert' : 'status';
  return `
    <div class="agentx-cloud-notice agentx-cloud-notice-${kind}" role="${role}">
      <span class="agentx-cloud-notice-icon" aria-hidden="true">${icon}</span>
      <span>${escapeHtml(message)}</span>
    </div>`;
}

function renderBusy(status, locale) {
  if (!status.action) return '';
  return `
    <div class="agentx-cloud-progress" role="status" aria-live="polite">
      <span class="agentx-cloud-spinner" aria-hidden="true"></span>
      <span>${escapeHtml(actionLabel(status, locale))}</span>
    </div>`;
}

function renderSignedOut(status, locale) {
  return `
    <section class="agentx-cloud-auth" aria-labelledby="agentx-cloud-auth-title">
      <div class="agentx-cloud-copy">
        <div class="agentx-cloud-eyebrow">${escapeHtml(copy(locale, 'eyebrow'))}</div>
        <h3 id="agentx-cloud-auth-title">${escapeHtml(copy(locale, 'titleSignedOut'))}</h3>
        <p>${escapeHtml(copy(locale, 'bodySignedOut'))}</p>
      </div>
      ${renderNotice('error', errorMessage(status, locale))}
      ${renderBusy(status, locale)}
      <div class="agentx-cloud-actions">
        <button
          type="button"
          class="btn-primary agentx-cloud-button"
          data-agentx-cloud-action="sign-in"
          ${status.action ? 'disabled aria-disabled="true"' : ''}
        >${escapeHtml(copy(locale, 'signIn'))}</button>
      </div>
    </section>`;
}

function renderConnectionDetails(status, locale) {
  const provider = status.provider || {};
  const user = status.user || {};
  const account = provider.account || user.email || user.subject || '—';
  const models = Array.isArray(provider.models)
    ? [...new Set(provider.models.map(String).map((model) => model.trim()).filter(Boolean))]
    : [];
  const modelCount = models.length || Number(provider.modelCount) || (provider.model ? 1 : 0);
  const modelControl = models.length > 1
    ? `
      <select
        class="agentx-cloud-model-select"
        data-agentx-cloud-model
        aria-label="${escapeHtml(copy(locale, 'chooseModel'))}"
        ${status.action ? 'disabled aria-disabled="true"' : ''}
      >
        ${models.map((model) => `
          <option value="${escapeHtml(model)}" ${model === provider.model ? 'selected' : ''}>
            ${escapeHtml(model)}
          </option>`).join('')}
      </select>`
    : `<code>${escapeHtml(provider.model || models[0] || '—')}</code>`;
  return `
    <dl class="agentx-cloud-details">
      <div>
        <dt>${escapeHtml(copy(locale, 'account'))}</dt>
        <dd>${escapeHtml(account)}</dd>
      </div>
      <div>
        <dt>${escapeHtml(copy(locale, 'gateway'))}</dt>
        <dd><code>${escapeHtml(displayHost(provider.baseUrl || status.configuredLiteLlmBaseUrl))}</code></dd>
      </div>
      <div>
        <dt>${escapeHtml(copy(locale, 'model'))}</dt>
        <dd>
          ${modelControl}
          ${modelCount > 0
            ? `<small>${escapeHtml(copy(locale, 'modelsAvailable', { count: modelCount }))}</small>`
            : ''}
        </dd>
      </div>
      <div>
        <dt>${escapeHtml(copy(locale, 'device'))}</dt>
        <dd>${escapeHtml(status.device?.name || 'AgentX WebMate')}</dd>
      </div>
    </dl>`;
}

/**
 * The account's AgentX license: plan, state, last day, contact — shown
 * whenever the keys service reported one, enforced or not — plus the warning
 * that applies now (read-only, grace period, the reminder before the last
 * day; never while licensing is not enforced).
 */
function renderLicense(status, locale) {
  const license = status.license;
  if (!license) return '';
  const planName = license.plan?.name || license.plan?.slug || '';
  const rows = [
    `<div>
        <dt>${escapeHtml(copy(locale, 'license'))}</dt>
        <dd>
          ${planName ? `<span>${escapeHtml(planName)}</span>` : ''}
          <span class="agentx-cloud-license-state" data-state="${escapeHtml(license.state)}">${escapeHtml(licenseStateLabel(license, locale))}</span>
        </dd>
      </div>`,
  ];
  if (license.state === 'scheduled' && license.starts_on) {
    rows.push(`<div>
        <dt>${escapeHtml(copy(locale, 'licenseStartsOn'))}</dt>
        <dd>${escapeHtml(formatLicenseDay(license.starts_on, locale))}</dd>
      </div>`);
  }
  if (license.last_day) {
    rows.push(`<div>
        <dt>${escapeHtml(copy(locale, 'licenseLastDay'))}</dt>
        <dd>${escapeHtml(formatLicenseDay(license.last_day, locale))}</dd>
      </div>`);
  }
  if (license.contact) {
    rows.push(`<div>
        <dt>${escapeHtml(copy(locale, 'licenseContact'))}</dt>
        <dd>${escapeHtml(license.contact)}</dd>
      </div>`);
  }
  const warning = isLicenseReadOnly(license)
    ? `${licenseReadOnlySentence(license, locale)} ${licenseReinstateSentence(license, locale)}`
    : licenseNoticeSentence(license, locale);
  return `
    <div class="agentx-cloud-license" data-agentx-license>
      <dl class="agentx-cloud-details">${rows.join('')}</dl>
      ${renderNotice(isLicenseReadOnly(license) ? 'error' : 'warning', warning)}
    </div>`;
}

function renderSignedIn(status, locale) {
  const connected = status.connected === true;
  const user = status.user || {};
  const title = user.displayName || user.email || copy(locale, 'connected');
  const offline = status.outcome === 'stale-offline';
  const readOnly = isLicenseReadOnly(status.license);
  const testMessage = status.testOk
    ? copy(locale, 'testPassed', { model: status.testModel || status.provider?.model || 'model' })
    : '';
  // A read-only account is not "one step from connected": the license block
  // says why, and the primary action re-checks the license.
  const pendingLabel = readOnly ? licenseStateLabel(status.license, locale) : copy(locale, 'retry');
  return `
    <section class="agentx-cloud-auth" aria-labelledby="agentx-cloud-account-title">
      <header class="agentx-cloud-account">
        <span class="agentx-cloud-status-mark" aria-hidden="true">${connected ? '✓' : '•'}</span>
        <span class="agentx-cloud-account-copy">
          <strong id="agentx-cloud-account-title">${escapeHtml(title)}</strong>
          ${user.email && user.email !== title ? `<span>${escapeHtml(user.email)}</span>` : ''}
        </span>
        <span class="agentx-cloud-connection-label" data-state="${connected ? 'connected' : 'pending'}">
          ${escapeHtml(connected ? copy(locale, 'connected') : pendingLabel)}
        </span>
      </header>
      ${connected ? renderConnectionDetails(status, locale) : (readOnly ? '' : `
        <p class="agentx-cloud-pending">${escapeHtml(copy(locale, 'signedInNotConnected'))}</p>
      `)}
      ${renderLicense(status, locale)}
      ${offline ? renderNotice('warning', copy(locale, 'sessionOffline')) : ''}
      ${status.persistenceWarning ? renderNotice('warning', copy(locale, 'persistenceWarning')) : ''}
      ${renderNotice('error', errorMessage(status, locale))}
      ${renderNotice('success', testMessage)}
      ${renderBusy(status, locale)}
      <p class="agentx-cloud-key-note">${escapeHtml(copy(locale, 'keyProtected'))}</p>
      <div class="agentx-cloud-actions">
        ${connected && !readOnly ? `
          <button
            type="button"
            class="btn-secondary agentx-cloud-button"
            data-agentx-cloud-action="test"
            ${status.action ? 'disabled aria-disabled="true"' : ''}
          >${escapeHtml(copy(locale, 'test'))}</button>
        ` : `
          <button
            type="button"
            class="btn-primary agentx-cloud-button"
            data-agentx-cloud-action="retry"
            ${status.action ? 'disabled aria-disabled="true"' : ''}
          >${escapeHtml(copy(locale, readOnly ? 'licenseRecheck' : 'retry'))}</button>
        `}
        <button
          type="button"
          class="btn-secondary agentx-cloud-button agentx-cloud-sign-out"
          data-agentx-cloud-action="sign-out"
          ${status.action ? 'disabled aria-disabled="true"' : ''}
        >${escapeHtml(copy(locale, 'signOut'))}</button>
      </div>
    </section>`;
}

export function renderAgentXCloudPanel(status = {}, locale = 'en') {
  return status.signedIn
    ? renderSignedIn(status, locale)
    : renderSignedOut(status, locale);
}

function renderVisionModelControl(status, locale) {
  const provider = status.provider || {};
  const visionModels = Array.isArray(provider.visionModels)
    ? [...new Set(provider.visionModels.map(String).map((model) => model.trim()).filter(Boolean))]
    : [];
  const selected = String(provider.visionModel || '').trim();
  const options = [
    `<option value="" ${selected ? '' : 'selected'}>${escapeHtml(copy(locale, 'visionNone'))}</option>`,
    ...visionModels.map((model) => `
      <option value="${escapeHtml(model)}" ${model === selected ? 'selected' : ''}>
        ${escapeHtml(model)}
      </option>`),
  ];
  return `
    <select
      class="agentx-cloud-model-select"
      data-agentx-cloud-vision-model
      aria-label="${escapeHtml(copy(locale, 'chooseVisionModel'))}"
      ${status.action ? 'disabled aria-disabled="true"' : ''}
    >
      ${options.join('')}
    </select>
    ${visionModels.length
      ? `<small>${escapeHtml(copy(locale, 'visionModelsAvailable', { count: visionModels.length }))}</small>`
      : ''}`;
}

export function renderAgentXCloudVisionPanel(status = {}, locale = 'en') {
  if (!status.signedIn) {
    return `
      <section class="agentx-cloud-auth agentx-cloud-vision" aria-labelledby="agentx-cloud-vision-title">
        <div class="agentx-cloud-copy">
          <div class="agentx-cloud-eyebrow">${escapeHtml(copy(locale, 'eyebrow'))}</div>
          <h3 id="agentx-cloud-vision-title">${escapeHtml(copy(locale, 'visionTitle'))}</h3>
          <p>${escapeHtml(copy(locale, 'visionBodySignedOut'))}</p>
        </div>
      </section>`;
  }
  if (!status.connected) {
    return `
      <section class="agentx-cloud-auth agentx-cloud-vision" aria-labelledby="agentx-cloud-vision-title">
        <div class="agentx-cloud-copy">
          <div class="agentx-cloud-eyebrow">${escapeHtml(copy(locale, 'eyebrow'))}</div>
          <h3 id="agentx-cloud-vision-title">${escapeHtml(copy(locale, 'visionTitle'))}</h3>
          <p>${escapeHtml(copy(locale, 'visionBodyDisconnected'))}</p>
        </div>
        ${renderNotice('error', errorMessage(status, locale))}
        ${renderBusy(status, locale)}
      </section>`;
  }
  const testMessage = status.visionTestOk
    ? copy(locale, 'visionTestPassed', { model: status.visionTestModel || status.provider?.visionModel || 'model' })
    : '';
  const hasVisionModel = !!String(status.provider?.visionModel || '').trim();
  return `
    <section class="agentx-cloud-auth agentx-cloud-vision" aria-labelledby="agentx-cloud-vision-title">
      <div class="agentx-cloud-copy">
        <div class="agentx-cloud-eyebrow">${escapeHtml(copy(locale, 'eyebrow'))}</div>
        <h3 id="agentx-cloud-vision-title">${escapeHtml(copy(locale, 'visionTitle'))}</h3>
        <p>${escapeHtml(copy(locale, 'visionHint'))}</p>
      </div>
      <dl class="agentx-cloud-details">
        <div>
          <dt>${escapeHtml(copy(locale, 'account'))}</dt>
          <dd>${escapeHtml(status.provider?.account || status.user?.email || status.user?.displayName || '—')}</dd>
        </div>
        <div>
          <dt>${escapeHtml(copy(locale, 'gateway'))}</dt>
          <dd><code>${escapeHtml(displayHost(status.provider?.baseUrl || status.configuredLiteLlmBaseUrl))}</code></dd>
        </div>
        <div>
          <dt>${escapeHtml(copy(locale, 'visionModel'))}</dt>
          <dd>${renderVisionModelControl(status, locale)}</dd>
        </div>
      </dl>
      ${renderNotice('error', errorMessage(status, locale))}
      ${renderNotice('success', testMessage)}
      ${renderBusy(status, locale)}
      <p class="agentx-cloud-key-note">${escapeHtml(copy(locale, 'keyProtected'))}</p>
      <div class="agentx-cloud-actions">
        <button
          type="button"
          class="btn-secondary agentx-cloud-button"
          data-agentx-cloud-action="test-vision"
          ${status.action || !hasVisionModel ? 'disabled aria-disabled="true"' : ''}
        >${escapeHtml(copy(locale, 'visionTest'))}</button>
        <button
          type="button"
          class="btn-secondary agentx-cloud-button"
          data-agentx-cloud-action="clear-vision"
          ${status.action || !hasVisionModel ? 'disabled aria-disabled="true"' : ''}
        >${escapeHtml(copy(locale, 'visionClear'))}</button>
      </div>
    </section>`;
}

function renderTranscriptionModelControl(status, locale) {
  const provider = status.provider || {};
  const transcriptionModels = Array.isArray(provider.transcriptionModels)
    ? [...new Set(provider.transcriptionModels.map(String).map((model) => model.trim()).filter(Boolean))]
    : [];
  const selected = String(provider.transcriptionModel || '').trim();
  const options = [
    `<option value="" ${selected ? '' : 'selected'}>${escapeHtml(copy(locale, 'transcriptionNone'))}</option>`,
    ...transcriptionModels.map((model) => `
      <option value="${escapeHtml(model)}" ${model === selected ? 'selected' : ''}>
        ${escapeHtml(model)}
      </option>`),
  ];
  return `
    <select
      class="agentx-cloud-model-select"
      data-agentx-cloud-transcription-model
      aria-label="${escapeHtml(copy(locale, 'chooseTranscriptionModel'))}"
      ${status.action ? 'disabled aria-disabled="true"' : ''}
    >
      ${options.join('')}
    </select>
    ${transcriptionModels.length
      ? `<small>${escapeHtml(copy(locale, 'transcriptionModelsAvailable', { count: transcriptionModels.length }))}</small>`
      : ''}`;
}

export function renderAgentXCloudTranscriptionPanel(status = {}, locale = 'en') {
  if (!status.signedIn) {
    return `
      <section class="agentx-cloud-auth agentx-cloud-vision" aria-labelledby="agentx-cloud-transcription-title">
        <div class="agentx-cloud-copy">
          <div class="agentx-cloud-eyebrow">${escapeHtml(copy(locale, 'eyebrow'))}</div>
          <h3 id="agentx-cloud-transcription-title">${escapeHtml(copy(locale, 'transcriptionTitle'))}</h3>
          <p>${escapeHtml(copy(locale, 'transcriptionBodySignedOut'))}</p>
        </div>
      </section>`;
  }
  if (!status.connected) {
    return `
      <section class="agentx-cloud-auth agentx-cloud-vision" aria-labelledby="agentx-cloud-transcription-title">
        <div class="agentx-cloud-copy">
          <div class="agentx-cloud-eyebrow">${escapeHtml(copy(locale, 'eyebrow'))}</div>
          <h3 id="agentx-cloud-transcription-title">${escapeHtml(copy(locale, 'transcriptionTitle'))}</h3>
          <p>${escapeHtml(copy(locale, 'transcriptionBodyDisconnected'))}</p>
        </div>
        ${renderNotice('error', errorMessage(status, locale))}
        ${renderBusy(status, locale)}
      </section>`;
  }
  const testMessage = status.transcriptionTestOk
    ? copy(locale, 'transcriptionTestPassed', {
      model: status.transcriptionTestModel || status.provider?.transcriptionModel || 'model',
    })
    : '';
  const hasTranscriptionModel = !!String(status.provider?.transcriptionModel || '').trim();
  return `
    <section class="agentx-cloud-auth agentx-cloud-vision" aria-labelledby="agentx-cloud-transcription-title">
      <div class="agentx-cloud-copy">
        <div class="agentx-cloud-eyebrow">${escapeHtml(copy(locale, 'eyebrow'))}</div>
        <h3 id="agentx-cloud-transcription-title">${escapeHtml(copy(locale, 'transcriptionTitle'))}</h3>
        <p>${escapeHtml(copy(locale, 'transcriptionHint'))}</p>
      </div>
      <dl class="agentx-cloud-details">
        <div>
          <dt>${escapeHtml(copy(locale, 'account'))}</dt>
          <dd>${escapeHtml(status.provider?.account || status.user?.email || status.user?.displayName || '—')}</dd>
        </div>
        <div>
          <dt>${escapeHtml(copy(locale, 'gateway'))}</dt>
          <dd><code>${escapeHtml(displayHost(status.provider?.baseUrl || status.configuredLiteLlmBaseUrl))}</code></dd>
        </div>
        <div>
          <dt>${escapeHtml(copy(locale, 'transcriptionModel'))}</dt>
          <dd>${renderTranscriptionModelControl(status, locale)}</dd>
        </div>
      </dl>
      ${renderNotice('error', errorMessage(status, locale))}
      ${renderNotice('success', testMessage)}
      ${renderBusy(status, locale)}
      <p class="agentx-cloud-key-note">${escapeHtml(copy(locale, 'keyProtected'))}</p>
      <div class="agentx-cloud-actions">
        <button
          type="button"
          class="btn-secondary agentx-cloud-button"
          data-agentx-cloud-action="test-transcription"
          ${status.action || !hasTranscriptionModel ? 'disabled aria-disabled="true"' : ''}
        >${escapeHtml(copy(locale, 'transcriptionTest'))}</button>
        <button
          type="button"
          class="btn-secondary agentx-cloud-button"
          data-agentx-cloud-action="clear-transcription"
          ${status.action || !hasTranscriptionModel ? 'disabled aria-disabled="true"' : ''}
        >${escapeHtml(copy(locale, 'transcriptionClear'))}</button>
      </div>
    </section>`;
}

export function bindAgentXCloudPanel(root, onAction) {
  if (!root || typeof onAction !== 'function') return;
  root.querySelectorAll('[data-agentx-cloud-action]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.disabled) return;
      onAction(button.dataset.agentxCloudAction);
    });
  });
  const modelSelect = root.querySelector?.('[data-agentx-cloud-model]');
  modelSelect?.addEventListener('change', () => {
    if (modelSelect.disabled) return;
    onAction('select-model', { model: modelSelect.value });
  });
}

export function bindAgentXCloudVisionPanel(root, onAction) {
  if (!root || typeof onAction !== 'function') return;
  root.querySelectorAll('[data-agentx-cloud-action]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.disabled) return;
      onAction(button.dataset.agentxCloudAction);
    });
  });
  const modelSelect = root.querySelector?.('[data-agentx-cloud-vision-model]');
  modelSelect?.addEventListener('change', () => {
    if (modelSelect.disabled) return;
    onAction('select-vision-model', { model: modelSelect.value });
  });
}

export function bindAgentXCloudTranscriptionPanel(root, onAction) {
  if (!root || typeof onAction !== 'function') return;
  root.querySelectorAll('[data-agentx-cloud-action]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.disabled) return;
      onAction(button.dataset.agentxCloudAction);
    });
  });
  const modelSelect = root.querySelector?.('[data-agentx-cloud-transcription-model]');
  modelSelect?.addEventListener('change', () => {
    if (modelSelect.disabled) return;
    onAction('select-transcription-model', { model: modelSelect.value });
  });
}
