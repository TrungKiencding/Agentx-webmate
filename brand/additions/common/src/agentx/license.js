/**
 * The AgentX license as the keys service reports it (`GET /v1/license`, and
 * beside the key in `POST /v1/model-key`), reduced to what WebMate may trust.
 *
 * One bundle license covers Workmate, WebMate and Chat. `access` is the only
 * blocking signal: `read_only` locks the side panel and refuses Workmate-driven
 * runs; everything else — including a license this build cannot parse, or none
 * at all — leaves WebMate exactly as it was before licensing existed. An
 * outage never locks anybody: callers keep the last license they knew.
 *
 * Pure: no storage, no clock, no network.
 */

export const LICENSE_STATES = Object.freeze(['none', 'scheduled', 'active', 'grace', 'expired', 'revoked']);

/** The keys service's 403 codes for a license that is not full (state none/scheduled, expired, revoked). */
export const LICENSE_REFUSAL_CODES = Object.freeze(['license_required', 'license_expired', 'license_revoked']);

/** The code a Workmate-driven run is refused with while the account is read-only. */
export const LICENSE_READ_ONLY_CODE = 'license_read_only';

const NOTICES = new Set(['expiring', 'grace', 'read_only']);
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const STATE_RE = /^[a-z][a-z0-9_]{0,31}$/;

function text(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

/** A calendar day `YYYY-MM-DD` that exists, or null. Never parsed into a Date: it is a display date. */
function day(value) {
  const match = DAY_RE.exec(text(value, 10));
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
    ? match[0]
    : null;
}

function instant(value) {
  const raw = text(value, 64);
  return raw && Number.isFinite(Date.parse(raw)) ? raw : null;
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function plan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const slug = text(value.slug, 80);
  const name = text(value.name, 200) || slug;
  return slug || name ? { slug, name } : null;
}

/**
 * The contract's LICENSE object, sanitized, or null when `raw` cannot be one.
 * Keys keep the wire spelling so the object can travel on to Workmate as is.
 * A state this build does not know is kept (access still decides), and a
 * notice is dropped while the license is not enforced — the contract says the
 * server never sends one then, and a stray one must not nag anybody.
 */
export function normalizeLicense(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const access = raw.access === 'full' || raw.access === 'read_only' ? raw.access : '';
  const state = text(raw.state, 32);
  if (!access || !STATE_RE.test(state)) return null;
  const enforced = raw.enforced === true;
  return {
    state,
    access,
    enforced,
    notice: enforced && NOTICES.has(raw.notice) ? raw.notice : null,
    plan: plan(raw.plan),
    products: Array.isArray(raw.products)
      ? [...new Set(raw.products.map((entry) => text(entry, 40)).filter(Boolean))].slice(0, 16)
      : [],
    starts_at: instant(raw.starts_at),
    ends_at: instant(raw.ends_at),
    grace_until: instant(raw.grace_until),
    starts_on: day(raw.starts_on),
    last_day: day(raw.last_day),
    read_only_from: day(raw.read_only_from),
    revoked_at: instant(raw.revoked_at),
    days_left: count(raw.days_left),
    reminder: count(raw.reminder),
    warn_days: Array.isArray(raw.warn_days)
      ? raw.warn_days.filter((entry) => Number.isSafeInteger(entry) && entry > 0).slice(0, 10)
      : [],
    contact: text(raw.contact, 200),
    server_time: instant(raw.server_time),
  };
}

export function isLicenseReadOnly(license) {
  return license?.access === 'read_only';
}

export function isLicenseRefusalCode(code) {
  return LICENSE_REFUSAL_CODES.includes(String(code || ''));
}

/**
 * What a 403 license refusal means when its body carries no usable license:
 * read-only, in the state the code stands for. `license_required` covers both
 * `none` and `scheduled`, so it says neither (`unknown`: the screens fall back
 * to their general wording). The next `GET /v1/license` replaces it with the
 * real object.
 */
export function licenseFromRefusal(code) {
  const state = {
    license_required: 'unknown',
    license_expired: 'expired',
    license_revoked: 'revoked',
  }[String(code || '')];
  if (!state) return null;
  return normalizeLicense({ state, access: 'read_only', enforced: true, notice: 'read_only' });
}

/**
 * The reminder before a plan ends is shown once per plan, last day and
 * reminder threshold (14, 7, 1 days…); this is that identity, or '' when the
 * license asks for no such reminder now.
 */
export function expiringNoticeKey(license) {
  if (license?.notice !== 'expiring' || isLicenseReadOnly(license)) return '';
  return [license.plan?.slug || license.plan?.name || '', license.last_day || '', license.reminder ?? ''].join('|');
}

/**
 * English sentence for the bridge error a Workmate-driven run is refused with.
 * It reaches the calling agent (and the person, through it), so it names the
 * reason, the date and whom to ask; Workmate renders its own copy from the
 * license object that travels beside it.
 */
export function licenseRefusalMessage(license) {
  const planName = license?.plan?.name ? `"${license.plan.name}" plan` : 'AgentX plan';
  let reason;
  switch (license?.state) {
    case 'none':
      reason = 'this account has no AgentX license.';
      break;
    case 'scheduled':
      reason = license.starts_on
        ? `the ${planName} only starts on ${license.starts_on}.`
        : `the ${planName} has not started yet.`;
      break;
    case 'expired':
      reason = license.last_day
        ? `the ${planName} ended on ${license.last_day}.`
        : `the ${planName} has ended.`;
      break;
    case 'revoked':
      reason = 'the AgentX license was revoked by an administrator.';
      break;
    default:
      reason = 'the AgentX license does not allow it right now.';
  }
  const contact = license?.contact
    ? `Contact ${license.contact} to renew or reinstate it.`
    : 'Ask an AgentX administrator to renew or reinstate it.';
  return `AgentX WebMate is read-only for this account, so it cannot run this task: ${reason} ${contact} `
    + 'Retrying will not help until the license changes.';
}
