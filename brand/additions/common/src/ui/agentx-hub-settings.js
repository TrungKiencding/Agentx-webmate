// Settings → Skills → "AgentX AgentHub" (plan Phase 4, item 5).
//
// The card searches the hub's browser-skill catalog, installs and removes
// skills, shows which enabled skills came from the hub (and which of those
// the person edited by hand before hub records became read-only), and the
// sync status. Installs, removals, forks and restores go through the
// background (`agentx_hub_install` / `agentx_hub_uninstall` / `agentx_hub_fork`)
// so the background stays the only writer of hub-managed `customSkills`;
// search and preview read the hub directly with the shared client. The
// enabled-skills list upstream draws on this module too: a hub record's row
// gets View · Fork to edit · Remove instead of Edit · Remove (plan §8
// decision 9).
import { AGENTX_RUNTIME_CONFIG } from '../agentx/runtime-config.js';
import {
  createAgentXHubClient,
  hubSkillPageUrl,
  publicHubError,
  readHubConfig,
  writeHubConfig,
} from '../agentx/hub-client.js';
import { AGENTX_HUB_SYNC_STATE_KEY } from '../agentx/hub-sync.js';
import { CUSTOM_SKILLS_STORAGE_KEY } from '../agent/skills.js';
import { escapeHtml } from './utils.js';

const COPY = {
  en: {
    title: 'AgentX AgentHub',
    intro: 'Browser skills scanned and signed by AgentX AgentHub. Install here or from the AgentHub website; installs, updates and removals follow your account across devices. Skills from AgentHub are read-only — fork one to edit it.',
    signedInAs: 'Signed in as {who}',
    signedOut: 'Sign in on the Providers tab to install from AgentHub. The public catalog is still searchable.',
    hub: 'AgentHub',
    lastSync: 'Last sync: {when}',
    never: 'never',
    syncNow: 'Sync now',
    syncing: 'Syncing…',
    status_synced: 'up to date',
    status_offline: 'AgentHub unreachable — installed skills keep working',
    status_reauth: 'session rejected — sign in again',
    status_not_signed_in: 'not signed in',
    status_error: 'error',
    status_never: 'not synced yet',
    searchLabel: 'Search the catalog',
    searchPlaceholder: 'Name, description, tag…',
    search: 'Search',
    searching: 'Searching…',
    noResults: 'No browser skill matches.',
    install: 'Install',
    installing: 'Installing…',
    installed: 'Installed v{version}',
    update: 'Update to v{version}',
    reinstall: 'Restore AgentHub version (replaces your edits)',
    reinstallConfirm: 'You edited this skill by hand. Restoring replaces your copy with the AgentHub version. Continue?',
    remove: 'Remove',
    removing: 'Removing…',
    open: 'Open on AgentHub',
    catalogHeading: 'Skill catalogue',
    catalogLoading: 'Loading the catalogue…',
    installedHeading: 'Installed from AgentHub on this browser',
    installedEmpty: 'Nothing installed from AgentHub on this browser yet — press Install in the catalogue above.',
    fromHub: 'AgentX AgentHub',
    editedFromHub: 'Edited from AgentX AgentHub',
    editedNote: 'edited by hand — not updated automatically',
    repairedNote: 'changed outside WebMate — restored from AgentHub',
    repairPendingNote: 'changed outside WebMate — switched off until AgentHub answers',
    updateAvailable: 'v{version} available',
    disabledNote: 'switched off by AgentHub{reason}',
    parkedHeading: 'Switched off (kept, not loaded)',
    failedNote: 'last install failed: {code}',
    workspacesHeading: 'Shared in your workspaces',
    verdict_safe: 'safe',
    verdict_caution: 'caution',
    verdict_dangerous: 'dangerous',
    visibility_public: 'public',
    visibility_workspace: 'workspace',
    visibility_private: 'private',
    installedMessage: 'Installed {name} v{version}. It is ready for the next run.',
    removedMessage: 'Removed {name}.',
    restoredMessage: 'Restored {name} v{version} from AgentHub.',
    view: 'View',
    openOnHub: 'Open on AgentHub',
    fork: 'Fork to edit',
    forkSuffix: 'copy',
    forkedMessage: 'Made an editable copy "{name}". The AgentHub version was withdrawn from this device; install it again from AgentHub any time.',
    restore: 'Restore AgentHub version',
    restoreConfirm: 'Replace your edited copy of {slug} with the version on AgentHub?',
    locked: 'Skills from AgentX AgentHub are read-only. Its author edits it on AgentHub ("Open on AgentHub", then Edit) and every device that installed it gets the new version; for a copy of your own, use "Fork to edit".',
    forkedFromHub: 'Copy of AgentX AgentHub',
    advanced: 'Advanced',
    hubUrlLabel: 'AgentHub address',
    hubUrlHint: 'HTTPS only (HTTP allowed for 127.0.0.1 / localhost). Leave empty to use the default.',
    hubUrlSave: 'Save',
    hubUrlReset: 'Use default',
    hubUrlSaved: 'AgentHub address saved. Syncing…',
    externalChannel: 'One-click install from the AgentHub website: available',
    externalChannelMissing: 'One-click install from the AgentHub website is not available in this browser — use "Import from URL" with the link AgentHub shows.',
    error_not_signed_in: 'Sign in to AgentX (Providers tab) first.',
    error_network_unavailable: 'Could not reach AgentHub. Check your connection and try again.',
    error_request_timeout: 'AgentHub took too long to answer. Try again.',
    error_invalid_token: 'AgentHub rejected your session. Sign in again on the Providers tab.',
    error_identity_unavailable: 'The identity provider is temporarily unavailable. Try again in a moment.',
    error_hub_unavailable: 'AgentHub is temporarily unavailable.',
    error_skill_not_found: 'That skill is not on AgentHub (or not visible to you).',
    error_not_published: 'That skill has no published version yet.',
    error_skill_limit_reached: 'WebMate keeps at most {max} skills. Remove one first.',
    error_kind_mismatch: 'That is not a browser skill.',
    error_background_unavailable: 'The extension background did not respond. Try again.',
    error_render_hash_mismatch: 'AgentHub sent content that does not match the hash it states. Nothing was installed; try again.',
    error_generic: 'The AgentHub request failed ({code}).',
  },
  vi: {
    title: 'AgentX AgentHub',
    intro: 'Kỹ năng trình duyệt đã được AgentX AgentHub quét và ký. Cài ở đây hoặc từ trang AgentHub; việc cài, cập nhật, gỡ theo tài khoản của bạn trên mọi thiết bị. Kỹ năng từ AgentHub chỉ đọc — muốn sửa thì tách bản sao.',
    signedInAs: 'Đang đăng nhập: {who}',
    signedOut: 'Đăng nhập ở tab Nhà cung cấp để cài từ AgentHub. Danh mục công khai vẫn tìm được.',
    hub: 'AgentHub',
    lastSync: 'Đồng bộ lần cuối: {when}',
    never: 'chưa bao giờ',
    syncNow: 'Đồng bộ ngay',
    syncing: 'Đang đồng bộ…',
    status_synced: 'đã cập nhật',
    status_offline: 'không tới được AgentHub — kỹ năng đã cài vẫn dùng bình thường',
    status_reauth: 'phiên bị từ chối — hãy đăng nhập lại',
    status_not_signed_in: 'chưa đăng nhập',
    status_error: 'lỗi',
    status_never: 'chưa đồng bộ',
    searchLabel: 'Tìm trong danh mục',
    searchPlaceholder: 'Tên, mô tả, tag…',
    search: 'Tìm',
    searching: 'Đang tìm…',
    noResults: 'Không có kỹ năng trình duyệt nào khớp.',
    install: 'Cài',
    installing: 'Đang cài…',
    installed: 'Đã cài v{version}',
    update: 'Cập nhật lên v{version}',
    reinstall: 'Khôi phục bản AgentHub (ghi đè bản đã sửa)',
    reinstallConfirm: 'Bạn đã sửa tay kỹ năng này. Khôi phục sẽ thay bản của bạn bằng bản trên AgentHub. Tiếp tục?',
    remove: 'Gỡ',
    removing: 'Đang gỡ…',
    open: 'Mở trên AgentHub',
    catalogHeading: 'Danh mục kỹ năng',
    catalogLoading: 'Đang tải danh mục…',
    installedHeading: 'Đã cài từ AgentHub trên trình duyệt này',
    installedEmpty: 'Chưa cài kỹ năng nào từ AgentHub trên trình duyệt này — bấm Cài ở danh mục bên trên.',
    fromHub: 'Từ AgentX AgentHub',
    editedFromHub: 'Đã sửa từ AgentX AgentHub',
    editedNote: 'đã sửa tay — không tự cập nhật',
    repairedNote: 'bị sửa ngoài WebMate — đã khôi phục bản AgentHub',
    repairPendingNote: 'bị sửa ngoài WebMate — tạm tắt đến khi AgentHub trả lời',
    updateAvailable: 'có bản v{version}',
    disabledNote: 'AgentHub đã tắt{reason}',
    parkedHeading: 'Đã tắt (giữ nội dung, không nạp)',
    failedNote: 'lần cài gần nhất lỗi: {code}',
    workspacesHeading: 'Dùng chung trong workspace của bạn',
    verdict_safe: 'an toàn',
    verdict_caution: 'cần chú ý',
    verdict_dangerous: 'nguy hiểm',
    visibility_public: 'công khai',
    visibility_workspace: 'workspace',
    visibility_private: 'riêng tư',
    installedMessage: 'Đã cài {name} v{version}. Dùng được ngay ở lượt chạy kế tiếp.',
    removedMessage: 'Đã gỡ {name}.',
    restoredMessage: 'Đã khôi phục {name} v{version} từ AgentHub.',
    view: 'Xem',
    openOnHub: 'Mở trên AgentHub',
    fork: 'Tách bản sao để sửa',
    forkSuffix: 'bản sao',
    forkedMessage: 'Đã tạo bản sao "{name}" để bạn sửa. Bản của AgentHub đã được gỡ khỏi thiết bị này; có thể cài lại từ AgentHub bất cứ lúc nào.',
    restore: 'Khôi phục bản AgentHub',
    restoreConfirm: 'Thay bản đã sửa của {slug} bằng bản trên AgentHub?',
    locked: 'Kỹ năng từ AgentX AgentHub chỉ đọc. Tác giả sửa trên AgentHub ("Mở trên AgentHub" rồi "Sửa") và mọi thiết bị đã cài tự nhận bản mới; muốn có bản của riêng bạn thì dùng "Tách bản sao để sửa".',
    forkedFromHub: 'Bản sao từ AgentX AgentHub',
    advanced: 'Nâng cao',
    hubUrlLabel: 'Địa chỉ AgentHub',
    hubUrlHint: 'Chỉ HTTPS (cho phép HTTP với 127.0.0.1 / localhost). Để trống để dùng mặc định.',
    hubUrlSave: 'Lưu',
    hubUrlReset: 'Dùng mặc định',
    hubUrlSaved: 'Đã lưu địa chỉ AgentHub. Đang đồng bộ…',
    externalChannel: 'Cài một chạm từ trang AgentHub: sẵn sàng',
    externalChannelMissing: 'Trình duyệt này không có kênh cài một chạm từ trang AgentHub — dùng "Nhập từ URL" với liên kết AgentHub hiển thị.',
    error_not_signed_in: 'Hãy đăng nhập AgentX (tab Nhà cung cấp) trước.',
    error_network_unavailable: 'Không kết nối được AgentHub. Kiểm tra mạng rồi thử lại.',
    error_request_timeout: 'AgentHub trả lời quá lâu. Hãy thử lại.',
    error_invalid_token: 'AgentHub từ chối phiên đăng nhập. Hãy đăng nhập lại ở tab Nhà cung cấp.',
    error_identity_unavailable: 'Máy chủ định danh tạm thời không tới được. Thử lại sau ít phút.',
    error_hub_unavailable: 'AgentHub tạm thời chưa sẵn sàng.',
    error_skill_not_found: 'Kỹ năng này không có trên AgentHub (hoặc bạn không được xem).',
    error_not_published: 'Kỹ năng này chưa có phiên bản xuất bản.',
    error_skill_limit_reached: 'WebMate chỉ giữ tối đa {max} kỹ năng. Hãy gỡ bớt trước.',
    error_kind_mismatch: 'Đây không phải kỹ năng trình duyệt.',
    error_background_unavailable: 'Nền tiện ích không phản hồi. Hãy thử lại.',
    error_render_hash_mismatch: 'Nội dung AgentHub gửi không khớp hash AgentHub công bố. Chưa cài gì; hãy thử lại.',
    error_generic: 'Yêu cầu tới AgentHub thất bại ({code}).',
  },
};

function copy(lang, key, params = {}) {
  const dict = COPY[lang] || COPY.en;
  let text = dict[key] ?? COPY.en[key] ?? key;
  for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value ?? ''));
  return text;
}

function pickLang(locale) {
  const code = String(typeof locale === 'function' ? locale() : locale || 'en').slice(0, 2).toLowerCase();
  return COPY[code] ? code : 'en';
}

/**
 * "AgentX AgentHub · slug@version" for hub records; "Edited from AgentX AgentHub
 * (slug@version)" for copies edited by hand before the lock; "Copy of AgentX
 * Hub (slug@version)" for a fork; '' otherwise.
 */
export function agentxHubSourceLabel(skill, locale = 'en') {
  if (!skill) return '';
  const lang = pickLang(locale);
  if (!skill.hubSlug) {
    const from = skill.forkedFrom;
    return from?.slug ? `${copy(lang, 'forkedFromHub')} (${from.slug}@${from.version || '?'})` : '';
  }
  const ref = `${skill.hubSlug}@${skill.hubVersion || '?'}`;
  if (skill.sourceType === 'hub') return `${copy(lang, 'fromHub')} · ${ref}`;
  return `${copy(lang, 'editedFromHub')} (${ref})`;
}

export function agentxHubEditLockedMessage(locale = 'en') {
  return copy(pickLang(locale), 'locked');
}

export const AGENTX_HUB_ROW_ACTION_ATTR = 'data-agentx-hub-row-action';

/**
 * The action buttons for one row of the enabled-skills list when the record
 * carries a hub slug, or '' so the caller renders the upstream Edit · Remove
 * pair. A hub record is read-only: View · Open on AgentHub · Fork to edit ·
 * Remove — the removal goes through the hub so the next sync does not put it
 * back, and the skill's author edits it on the hub page (hub decision §8 #20).
 * A copy edited by hand before the lock keeps Edit and gains Open on AgentHub
 * and Restore hub version. The attributes are deliberately not the upstream
 * `data-skill-id` / `data-skill-edit-id`, so the upstream handlers never fire
 * on these.
 */
export function agentxHubSkillRowActions(skill, locale = 'en', labels = {}) {
  if (!skill?.hubSlug) return '';
  const lang = pickLang(locale);
  const button = (action, text, extra = '') => `<button class="btn-secondary" ${AGENTX_HUB_ROW_ACTION_ATTR}="${action}" data-agentx-skill-id="${escapeHtml(skill.id)}" data-hub-slug="${escapeHtml(skill.hubSlug)}" data-skill-name="${escapeHtml(skill.name || '')}"${extra}>${escapeHtml(text)}</button>`;
  const hubPage = hubPageUrl(skill.sourceUrl);
  const open = hubPage ? button('open', copy(lang, 'openOnHub'), ` data-hub-url="${escapeHtml(hubPage)}"`) : '';
  if (skill.sourceType === 'hub') {
    return button('view', copy(lang, 'view')) + open + button('fork', copy(lang, 'fork')) + button('remove', labels.remove || copy(lang, 'remove'));
  }
  return button('edit', labels.edit || 'Edit') + open + button('restore', copy(lang, 'restore')) + button('remove', labels.remove || copy(lang, 'remove'));
}

/** A record's hub page, or '' — only an http(s) address is ever opened. */
function hubPageUrl(value) {
  const text = String(value || '').trim();
  return /^https?:\/\/[^\s"'<>]+$/i.test(text) ? text : '';
}

/**
 * Wire the buttons above on the enabled-skills list (bound once; the list is
 * re-rendered on every change but its container is stable). `preview` and
 * `edit` are the page's own functions; "Open on AgentHub" opens the skill's
 * hub page in a tab (`openImpl`); fork, restore and remove go to the
 * background and the storage listener re-renders the list.
 */
export function bindAgentXHubSkillRowActions(container, {
  locale = () => 'en',
  sendToBackground,
  preview = () => {},
  edit = () => {},
  notify = () => {},
  confirmImpl = (message) => globalThis.confirm?.(message) ?? true,
  openImpl = (url) => globalThis.open?.(url, '_blank', 'noopener'),
} = {}) {
  if (!container || typeof sendToBackground !== 'function') return false;
  if (container.dataset?.agentxHubRowsBound) return false;
  if (container.dataset) container.dataset.agentxHubRowsBound = '1';
  container.addEventListener('click', async (event) => {
    const button = event.target?.closest?.(`[${AGENTX_HUB_ROW_ACTION_ATTR}]`);
    if (!button) return;
    event.preventDefault?.();
    const action = button.dataset?.agentxHubRowAction || '';
    const id = button.dataset?.agentxSkillId || '';
    const slug = button.dataset?.hubSlug || '';
    const name = button.dataset?.skillName || slug;
    const lang = pickLang(locale);
    if (action === 'view') return preview(id);
    if (action === 'edit') return edit(id);
    if (action === 'open') {
      const url = hubPageUrl(button.dataset?.hubUrl);
      if (url) openImpl(url);
      return undefined;
    }
    if (action === 'restore' && !confirmImpl(copy(lang, 'restoreConfirm', { slug }))) return undefined;
    button.disabled = true;
    try {
      let result;
      if (action === 'fork') result = await sendToBackground('agentx_hub_fork', { slug, name: `${name} (${copy(lang, 'forkSuffix')})` });
      else if (action === 'restore') result = await sendToBackground('agentx_hub_install', { slug });
      else if (action === 'remove') result = await sendToBackground('agentx_hub_uninstall', { slug });
      else return undefined;
      if (result?.error) throw Object.assign(new Error(result.error.message || String(result.error)), { code: result.error.code || 'unknown_error', detail: result.error.detail });
      const message = action === 'fork'
        ? copy(lang, 'forkedMessage', { name: result?.skill?.name || name })
        : action === 'restore'
          ? copy(lang, 'restoredMessage', { name: result?.skill?.name || name, version: result?.skill?.version || '?' })
          : copy(lang, 'removedMessage', { name });
      notify('ok', message);
    } catch (error) {
      button.disabled = false;
      notify('fail', describeHubError(error, lang));
    }
    return undefined;
  });
  return true;
}

export function describeHubError(error, locale = 'en', extra = {}) {
  const lang = pickLang(locale);
  const code = String(error?.code || 'unknown_error');
  const key = `error_${code}`;
  if ((COPY[lang] || COPY.en)[key] || COPY.en[key]) return copy(lang, key, { max: error?.detail?.max ?? 40, ...extra });
  return copy(lang, 'error_generic', { code });
}

function formatWhen(timestamp, lang) {
  if (!timestamp) return copy(lang, 'never');
  try {
    return new Date(timestamp).toLocaleString(lang === 'vi' ? 'vi-VN' : 'en-US');
  } catch {
    return String(timestamp);
  }
}

export function createAgentXHubSettingsController({
  api,
  root,
  locale = () => 'en',
  sendToBackground,
  config = AGENTX_RUNTIME_CONFIG,
  confirmImpl = (message) => globalThis.confirm?.(message) ?? true,
  clientOptions = {},
}) {
  if (typeof sendToBackground !== 'function') throw new TypeError('sendToBackground is required');
  const hub = createAgentXHubClient({ api, config, ...clientOptions });
  const state = {
    status: null,
    loading: true,
    query: '',
    results: null,
    searching: false,
    error: null,
    busySlug: '',
    busyAction: '',
    syncing: false,
    message: null,
    hubUrlDraft: null,
  };
  let refreshTimer = 0;

  const lang = () => pickLang(locale);

  async function refreshStatus() {
    try {
      state.status = await sendToBackground('agentx_hub_status');
    } catch (error) {
      state.status = { ok: false, signedIn: false, installed: [], error: publicHubError(error) };
    }
    state.loading = false;
  }

  function installedFor(slug) {
    return (state.status?.installed || []).find((item) => item.slug === slug) || null;
  }

  function badge(text, tone = '') {
    return `<span class="ax-hub-badge${tone ? ` ax-hub-badge--${tone}` : ''}">${escapeHtml(text)}</span>`;
  }

  function renderResult(skill) {
    const l = lang();
    const local = installedFor(skill.slug);
    const notice = state.status?.notices?.[skill.slug] || null;
    const latest = skill.latest_version || '';
    const busy = state.busySlug === skill.slug;
    let action = '';
    if (busy) {
      action = `<button class="btn-secondary" disabled>${escapeHtml(copy(l, state.busyAction === 'remove' ? 'removing' : 'installing'))}</button>`;
    } else if (!local) {
      action = `<button class="btn-primary" data-hub-action="install" data-hub-slug="${escapeHtml(skill.slug)}"${state.status?.signedIn ? '' : ' disabled'}>${escapeHtml(copy(l, 'install'))}</button>`;
    } else if (local.sourceType !== 'hub') {
      action = `<button class="btn-secondary" data-hub-action="reinstall" data-hub-slug="${escapeHtml(skill.slug)}">${escapeHtml(copy(l, 'reinstall'))}</button>`
        + `<button class="btn-secondary" data-hub-action="uninstall" data-hub-slug="${escapeHtml(skill.slug)}">${escapeHtml(copy(l, 'remove'))}</button>`;
    } else if (latest && local.version && latest !== local.version) {
      action = `<button class="btn-primary" data-hub-action="install" data-hub-slug="${escapeHtml(skill.slug)}">${escapeHtml(copy(l, 'update', { version: latest }))}</button>`
        + `<button class="btn-secondary" data-hub-action="uninstall" data-hub-slug="${escapeHtml(skill.slug)}">${escapeHtml(copy(l, 'remove'))}</button>`;
    } else {
      action = `<span class="ax-hub-installed">${escapeHtml(copy(l, 'installed', { version: local.version || latest || '?' }))}</span>`
        + `<button class="btn-secondary" data-hub-action="uninstall" data-hub-slug="${escapeHtml(skill.slug)}">${escapeHtml(copy(l, 'remove'))}</button>`;
    }
    const verdict = skill.scan?.verdict ? badge(copy(l, `verdict_${skill.scan.verdict}`), skill.scan.verdict) : '';
    const visibility = skill.visibility ? badge(copy(l, `visibility_${skill.visibility}`)) : '';
    const noticeText = notice?.kind === 'edited'
      ? badge(copy(l, 'editedNote'), 'warn')
      : notice?.kind === 'repaired' ? badge(copy(l, notice.pending ? 'repairPendingNote' : 'repairedNote'), 'warn') : '';
    return `
      <div class="ax-hub-row" data-hub-result="${escapeHtml(skill.slug)}">
        <div class="ax-hub-row-info">
          <div class="ax-hub-row-title">
            <a href="${escapeHtml(hubSkillPageUrl(state.status?.baseUrl || '', skill.slug))}" target="_blank" rel="noopener noreferrer" data-hub-action="open">${escapeHtml(skill.name || skill.slug)}</a>
            ${latest ? badge(`v${latest}`) : ''}${verdict}${visibility}${noticeText}
          </div>
          <div class="ax-hub-row-desc">${escapeHtml(skill.description || '')}</div>
          <div class="ax-hub-row-meta">${escapeHtml(skill.slug)}${skill.owner?.display_name || skill.owner?.slug ? ` · ${escapeHtml(skill.owner.display_name || skill.owner.slug)}` : ''}${Number.isFinite(Number(skill.downloads)) ? ` · ${escapeHtml(String(skill.downloads))}↓` : ''}</div>
        </div>
        <div class="ax-hub-row-actions">${action}</div>
      </div>`;
  }

  // One line per workspace that actually shares a skill of this kind: the hub
  // lists every workspace the person belongs to, and a name with nothing after
  // it says nothing.
  function renderWorkspace(workspace) {
    const skills = (workspace.skills || []).map((s) => escapeHtml(`${s.name || s.slug} v${s.version || '?'}`)).join(' · ');
    return `<div class="setting-desc" data-hub-workspace="${escapeHtml(workspace.slug || workspace.id || '')}">`
      + `<strong>${escapeHtml(workspace.name || workspace.slug || '')}</strong>: ${skills}</div>`;
  }

  function renderInstalled() {
    const l = lang();
    const items = state.status?.installed || [];
    const parked = state.status?.parked || [];
    const notices = state.status?.notices || {};
    const updates = new Map((state.status?.updates || []).map((u) => [u.slug, u]));
    if (!items.length && !parked.length) return `<div class="setting-desc">${escapeHtml(copy(l, 'installedEmpty'))}</div>`;
    const rows = items.map((item) => {
      const notice = notices[item.slug];
      const update = updates.get(item.slug);
      const flags = [];
      if (item.sourceType !== 'hub') flags.push(badge(copy(l, 'editedNote'), 'warn'));
      if ((notice?.kind === 'edited' && notice.updateAvailable) || update) flags.push(badge(copy(l, 'updateAvailable', { version: notice?.latestVersion || update?.version || '' }), 'accent'));
      if (notice?.kind === 'failed') flags.push(badge(copy(l, 'failedNote', { code: notice.code }), 'danger'));
      if (notice?.kind === 'repaired') flags.push(badge(copy(l, notice.pending ? 'repairPendingNote' : 'repairedNote'), 'warn'));
      const busy = state.busySlug === item.slug;
      const restore = item.sourceType !== 'hub'
        ? `<button class="btn-secondary" data-hub-action="reinstall" data-hub-slug="${escapeHtml(item.slug)}"${busy ? ' disabled' : ''}>${escapeHtml(copy(l, 'restore'))}</button>`
        : '';
      return `
        <div class="ax-hub-row" data-hub-installed="${escapeHtml(item.slug)}">
          <div class="ax-hub-row-info">
            <div class="ax-hub-row-title"><span>${escapeHtml(item.name || item.slug)}</span>${badge(`v${item.version || '?'}`)}${flags.join('')}</div>
            <div class="ax-hub-row-meta">${escapeHtml(item.sourceType === 'hub' ? copy(l, 'fromHub') : copy(l, 'editedFromHub'))} · ${escapeHtml(item.slug)}</div>
          </div>
          <div class="ax-hub-row-actions">
            <a class="btn-secondary" href="${escapeHtml(hubSkillPageUrl(state.status?.baseUrl || '', item.slug))}" target="_blank" rel="noopener noreferrer">${escapeHtml(copy(l, 'open'))}</a>
            ${restore}
            <button class="btn-secondary" data-hub-action="uninstall" data-hub-slug="${escapeHtml(item.slug)}"${busy ? ' disabled' : ''}>${escapeHtml(copy(l, busy ? 'removing' : 'remove'))}</button>
          </div>
        </div>`;
    });
    const parkedRows = parked.map((slug) => {
      const notice = notices[slug];
      const reason = notice?.reason ? ` — ${notice.reason}` : '';
      return `
        <div class="ax-hub-row ax-hub-row--parked" data-hub-parked="${escapeHtml(slug)}">
          <div class="ax-hub-row-info">
            <div class="ax-hub-row-title"><span>${escapeHtml(slug)}</span>${badge(copy(l, 'disabledNote', { reason }), 'warn')}</div>
          </div>
          <div class="ax-hub-row-actions">
            <a class="btn-secondary" href="${escapeHtml(hubSkillPageUrl(state.status?.baseUrl || '', slug))}" target="_blank" rel="noopener noreferrer">${escapeHtml(copy(l, 'open'))}</a>
            <button class="btn-secondary" data-hub-action="uninstall" data-hub-slug="${escapeHtml(slug)}">${escapeHtml(copy(l, 'remove'))}</button>
          </div>
        </div>`;
    });
    return `${rows.join('')}${parkedRows.length ? `<div class="setting-label ax-hub-subheading">${escapeHtml(copy(l, 'parkedHeading'))}</div>${parkedRows.join('')}` : ''}`;
  }

  function render() {
    if (!root) return;
    const l = lang();
    const status = state.status;
    const who = status?.subject ? status.subject : '';
    const statusKey = `status_${status?.lastStatus || 'never'}`;
    const workspaces = (status?.workspaces || []).filter((w) => (w.skills || []).length > 0);
    // `null` = the catalogue has not answered yet (first load or a failed one).
    const results = state.results === null
      ? (state.searching ? `<div class="setting-desc">${escapeHtml(copy(l, 'catalogLoading'))}</div>` : '')
      : state.results.length === 0
        ? `<div class="setting-desc">${escapeHtml(copy(l, 'noResults'))}</div>`
        : state.results.map(renderResult).join('');
    root.innerHTML = `
      <div class="ax-hub" data-agentx-hub>
        <div class="ax-hub-head">
          <div>
            <div class="setting-label">${escapeHtml(copy(l, 'title'))}</div>
            <div class="setting-desc">${escapeHtml(copy(l, 'intro'))}</div>
          </div>
          <button class="btn-secondary" data-hub-action="sync"${state.syncing || !status?.signedIn ? ' disabled' : ''}>${escapeHtml(copy(l, state.syncing ? 'syncing' : 'syncNow'))}</button>
        </div>
        <div class="ax-hub-status" data-hub-status="${escapeHtml(status?.lastStatus || 'never')}">
          <span>${escapeHtml(status?.signedIn ? copy(l, 'signedInAs', { who }) : copy(l, 'signedOut'))}</span>
          <span>· ${escapeHtml(copy(l, 'hub'))}: <a href="${escapeHtml(status?.baseUrl || '')}" target="_blank" rel="noopener noreferrer">${escapeHtml(status?.baseUrl || '')}</a></span>
          <span>· ${escapeHtml(copy(l, 'lastSync', { when: formatWhen(status?.lastSyncAt, l) }))} (${escapeHtml(copy(l, statusKey))})</span>
        </div>
        ${status?.lastError ? `<div class="ax-hub-error" role="alert">${escapeHtml(describeHubError(status.lastError, l))}</div>` : ''}
        ${state.error ? `<div class="ax-hub-error" role="alert" data-hub-error>${escapeHtml(describeHubError(state.error, l))}</div>` : ''}
        ${state.message ? `<div class="ax-hub-message" role="status" data-hub-message>${escapeHtml(state.message)}</div>` : ''}
        <form class="ax-hub-search" data-hub-search>
          <label class="setting-desc" for="agentx-hub-query">${escapeHtml(copy(l, 'searchLabel'))}</label>
          <div class="ax-hub-search-row">
            <input type="search" id="agentx-hub-query" name="q" value="${escapeHtml(state.query)}" placeholder="${escapeHtml(copy(l, 'searchPlaceholder'))}" autocomplete="off">
            <button class="btn-primary" type="submit"${state.searching ? ' disabled' : ''}>${escapeHtml(copy(l, state.searching ? 'searching' : 'search'))}</button>
          </div>
        </form>
        <div class="setting-label ax-hub-subheading">${escapeHtml(copy(l, 'catalogHeading'))}</div>
        <div class="ax-hub-results" data-hub-results>${results}</div>
        <div class="setting-label ax-hub-subheading">${escapeHtml(copy(l, 'installedHeading'))}</div>
        <div class="ax-hub-installed-list" data-hub-installed-list>${renderInstalled()}</div>
        ${workspaces.length ? `<div class="setting-label ax-hub-subheading">${escapeHtml(copy(l, 'workspacesHeading'))}</div>${workspaces.map(renderWorkspace).join('')}` : ''}
        <details class="ax-hub-advanced">
          <summary>${escapeHtml(copy(l, 'advanced'))}</summary>
          <div class="setting-desc">${escapeHtml(status?.externalChannel ? copy(l, 'externalChannel') : copy(l, 'externalChannelMissing'))}</div>
          <form class="ax-hub-url" data-hub-url-form>
            <label class="setting-desc" for="agentx-hub-url">${escapeHtml(copy(l, 'hubUrlLabel'))}</label>
            <div class="ax-hub-search-row">
              <input type="url" id="agentx-hub-url" name="baseUrl" value="${escapeHtml(state.hubUrlDraft ?? (status?.baseUrlSource === 'override' ? status.baseUrl : ''))}" placeholder="${escapeHtml(config.skillHubBaseUrl || '')}">
              <button class="btn-secondary" type="submit">${escapeHtml(copy(l, 'hubUrlSave'))}</button>
              <button class="btn-secondary" type="button" data-hub-action="reset-url">${escapeHtml(copy(l, 'hubUrlReset'))}</button>
            </div>
            <div class="setting-desc">${escapeHtml(copy(l, 'hubUrlHint'))}</div>
          </form>
        </details>
      </div>`;
  }

  async function search(query) {
    state.query = String(query || '').trim();
    state.searching = true;
    state.error = null;
    render();
    try {
      const page = await hub.listBrowserSkills(state.query, { limit: 30 });
      state.results = Array.isArray(page?.skills) ? page.skills : [];
    } catch (error) {
      state.error = publicHubError(error);
      state.results = state.results || [];
    } finally {
      state.searching = false;
      render();
    }
  }

  async function act(action, slug) {
    state.error = null;
    state.message = null;
    if (action === 'reinstall' && !confirmImpl(copy(lang(), 'reinstallConfirm'))) return;
    state.busySlug = slug;
    state.busyAction = action === 'uninstall' ? 'remove' : 'install';
    render();
    try {
      if (action === 'uninstall') {
        const result = await sendToBackground('agentx_hub_uninstall', { slug });
        if (result?.error) throw Object.assign(new Error(result.error.message || result.error), { code: result.error.code || 'unknown_error' });
        state.message = copy(lang(), 'removedMessage', { name: installedFor(slug)?.name || slug });
      } else {
        const result = await sendToBackground('agentx_hub_install', { slug });
        if (result?.error) throw Object.assign(new Error(result.error.message || result.error), { code: result.error.code || 'unknown_error', detail: result.error.detail });
        state.message = copy(lang(), action === 'reinstall' ? 'restoredMessage' : 'installedMessage', { name: result?.skill?.name || slug, version: result?.skill?.version || '?' });
      }
    } catch (error) {
      state.error = publicHubError(error);
    } finally {
      state.busySlug = '';
      state.busyAction = '';
      await refreshStatus();
      render();
    }
  }

  async function sync() {
    state.syncing = true;
    state.error = null;
    render();
    try {
      const result = await sendToBackground('agentx_hub_sync', { reason: 'settings' });
      if (result?.error && result.status !== 'offline') state.error = result.error;
    } catch (error) {
      state.error = publicHubError(error);
    } finally {
      state.syncing = false;
      await refreshStatus();
      render();
    }
  }

  async function saveHubUrl(value) {
    state.error = null;
    try {
      await writeHubConfig(api, { baseUrl: value });
      state.hubUrlDraft = null;
      state.message = copy(lang(), 'hubUrlSaved');
      await refreshStatus();
      render();
      await sync();
    } catch (error) {
      state.error = publicHubError(error);
      render();
    }
  }

  function bind() {
    if (!root || root.dataset.agentxHubBound) return;
    root.dataset.agentxHubBound = '1';
    root.addEventListener('submit', (event) => {
      const form = event.target;
      if (form?.matches?.('[data-hub-search]')) {
        event.preventDefault();
        void search(new FormData(form).get('q'));
      } else if (form?.matches?.('[data-hub-url-form]')) {
        event.preventDefault();
        void saveHubUrl(new FormData(form).get('baseUrl'));
      }
    });
    root.addEventListener('input', (event) => {
      if (event.target?.id === 'agentx-hub-query') state.query = event.target.value;
      if (event.target?.id === 'agentx-hub-url') state.hubUrlDraft = event.target.value;
    });
    root.addEventListener('click', (event) => {
      const button = event.target?.closest?.('[data-hub-action]');
      if (!button || button.tagName === 'A') return;
      const action = button.dataset.hubAction;
      if (action === 'sync') void sync();
      else if (action === 'reset-url') void saveHubUrl('');
      else if (action === 'install' || action === 'reinstall' || action === 'uninstall') void act(action, button.dataset.hubSlug);
    });
    api?.storage?.onChanged?.addListener?.((changes, area) => {
      if (area && area !== 'local') return;
      if (!changes[CUSTOM_SKILLS_STORAGE_KEY] && !changes[AGENTX_HUB_SYNC_STATE_KEY]) return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void refreshStatus().then(render);
      }, 150);
    });
  }

  return {
    async initialize() {
      bind();
      await refreshStatus();
      render();
      // The catalogue is what the card is for: load it on open rather than
      // making the person press Tìm to see that anything is there at all.
      // `search()` renders on its own and keeps its own error, so a hub that
      // cannot answer leaves the rest of the card working.
      await search('');
      return state.status;
    },
    render,
    search,
    sync,
    status() {
      return { ...state };
    },
    readHubConfig: () => readHubConfig(api, config),
  };
}
