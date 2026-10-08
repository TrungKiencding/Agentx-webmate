/**
 * What WebMate says about an AgentX license, in Vietnamese and English.
 *
 * The side-panel gate, its notice banner and the Settings account card all
 * describe the same license, so the sentences live here once. Dates come from
 * the contract's display fields (`starts_on`, `last_day`, `read_only_from`,
 * already in Asia/Ho_Chi_Minh) and are only re-spelled — never through Date,
 * which would shift a calendar day in a timezone west of UTC.
 */

import { isLicenseReadOnly } from '../agentx/license.js';

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const COPY = {
  vi: {
    title: 'Giấy phép AgentX',
    planFallback: 'AgentX',
    state_active: 'Đang hiệu lực',
    state_grace: 'Đang ân hạn',
    state_expired: 'Đã hết hạn',
    state_revoked: 'Đã thu hồi',
    state_scheduled: 'Chưa bắt đầu',
    state_none: 'Chưa được cấp',
    state_unknown: 'Không xác định',
    readOnly_none: 'Tài khoản chưa được cấp giấy phép AgentX.',
    readOnly_scheduled: 'Gói {plan} bắt đầu từ ngày {starts_on}.',
    readOnly_scheduledNoDate: 'Gói {plan} chưa bắt đầu.',
    readOnly_expired: 'Gói {plan} đã hết hạn ngày {last_day}.',
    readOnly_expiredNoDate: 'Gói {plan} đã hết hạn.',
    readOnly_revoked: 'Giấy phép AgentX của bạn đã bị thu hồi.',
    readOnly_unknown: 'Giấy phép AgentX hiện không cho phép dùng WebMate.',
    reinstateContact: 'Liên hệ {contact} để được cấp lại hoặc gia hạn.',
    reinstateAdmin: 'Liên hệ quản trị viên để được cấp lại hoặc gia hạn.',
    renewContact: 'Liên hệ {contact} để gia hạn.',
    grace: 'Gói {plan} đã hết hạn ngày {last_day}.',
    graceNoDate: 'Gói {plan} đã hết hạn.',
    graceReadOnlyFrom: 'Từ ngày {read_only_from}, WebMate sẽ ngừng hoạt động cho đến khi được gia hạn.',
    graceReadOnlySoon: 'WebMate sẽ sớm ngừng hoạt động cho đến khi được gia hạn.',
    expiring: 'Gói {plan} hết hạn ngày {last_day}{left}.',
    expiringNoDate: 'Gói {plan} sắp hết hạn{left}.',
    daysLeft: ' (còn {count} ngày)',
    dayLeft: ' (còn {count} ngày)',
  },
  en: {
    title: 'AgentX license',
    planFallback: 'AgentX',
    state_active: 'Active',
    state_grace: 'Grace period',
    state_expired: 'Expired',
    state_revoked: 'Revoked',
    state_scheduled: 'Not started',
    state_none: 'Not assigned',
    state_unknown: 'Unknown',
    readOnly_none: 'This account has not been given an AgentX license.',
    readOnly_scheduled: 'The {plan} plan starts on {starts_on}.',
    readOnly_scheduledNoDate: 'The {plan} plan has not started yet.',
    readOnly_expired: 'The {plan} plan expired on {last_day}.',
    readOnly_expiredNoDate: 'The {plan} plan has expired.',
    readOnly_revoked: 'Your AgentX license has been revoked.',
    readOnly_unknown: 'Your AgentX license does not allow WebMate right now.',
    reinstateContact: 'Contact {contact} to have it reissued or renewed.',
    reinstateAdmin: 'Contact your administrator to have it reissued or renewed.',
    renewContact: 'Contact {contact} to renew.',
    grace: 'The {plan} plan expired on {last_day}.',
    graceNoDate: 'The {plan} plan has expired.',
    graceReadOnlyFrom: 'From {read_only_from}, WebMate will stop working until it is renewed.',
    graceReadOnlySoon: 'WebMate will soon stop working until it is renewed.',
    expiring: 'The {plan} plan expires on {last_day}{left}.',
    expiringNoDate: 'The {plan} plan expires soon{left}.',
    daysLeft: ' ({count} days left)',
    dayLeft: ' ({count} day left)',
  },
};

function licenseLanguage(locale) {
  return String(locale || '').toLowerCase().startsWith('vi') ? 'vi' : 'en';
}

function say(lang, key, params = {}) {
  let value = COPY[lang][key] ?? COPY.en[key] ?? key;
  for (const [name, replacement] of Object.entries(params)) {
    value = value.replaceAll(`{${name}}`, String(replacement));
  }
  return value;
}

/** `2026-12-31` → `31/12/2026` (vi) or `31 Dec 2026` (en); anything else comes back as given. */
export function formatLicenseDay(value, locale) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return String(value || '');
  const [, year, month, date] = match;
  return licenseLanguage(locale) === 'vi'
    ? `${date}/${month}/${year}`
    : `${Number(date)} ${MONTHS_EN[Number(month) - 1]} ${year}`;
}

function planName(license, lang) {
  return license?.plan?.name || license?.plan?.slug || say(lang, 'planFallback');
}

export function licenseTitle(locale) {
  return say(licenseLanguage(locale), 'title');
}

export function licenseStateLabel(license, locale) {
  const lang = licenseLanguage(locale);
  const key = `state_${license?.state}`;
  return COPY[lang][key] ? say(lang, key) : say(lang, 'state_unknown');
}

/** Why WebMate is locked: one sentence per read-only state. */
export function licenseReadOnlySentence(license, locale) {
  const lang = licenseLanguage(locale);
  const plan = planName(license, lang);
  const startsOn = formatLicenseDay(license?.starts_on, lang);
  const lastDay = formatLicenseDay(license?.last_day, lang);
  switch (license?.state) {
    case 'none':
      return say(lang, 'readOnly_none');
    case 'scheduled':
      return startsOn
        ? say(lang, 'readOnly_scheduled', { plan, starts_on: startsOn })
        : say(lang, 'readOnly_scheduledNoDate', { plan });
    case 'expired':
      return lastDay
        ? say(lang, 'readOnly_expired', { plan, last_day: lastDay })
        : say(lang, 'readOnly_expiredNoDate', { plan });
    case 'revoked':
      return say(lang, 'readOnly_revoked');
    default:
      return say(lang, 'readOnly_unknown');
  }
}

/** Whom to ask to get WebMate back, for the locked screens. */
export function licenseReinstateSentence(license, locale) {
  const lang = licenseLanguage(locale);
  return license?.contact
    ? say(lang, 'reinstateContact', { contact: license.contact })
    : say(lang, 'reinstateAdmin');
}

/**
 * The warning for a license that still works but is ending: `grace` (always
 * shown) or `expiring` (the reminder before the last day). '' for anything
 * else, including every license that is not enforced.
 */
export function licenseNoticeSentence(license, locale) {
  if (!license || isLicenseReadOnly(license)) return '';
  const lang = licenseLanguage(locale);
  const plan = planName(license, lang);
  const lastDay = formatLicenseDay(license.last_day, lang);
  let sentence;
  if (license.notice === 'grace') {
    const readOnlyFrom = formatLicenseDay(license.read_only_from, lang);
    sentence = [
      lastDay ? say(lang, 'grace', { plan, last_day: lastDay }) : say(lang, 'graceNoDate', { plan }),
      readOnlyFrom
        ? say(lang, 'graceReadOnlyFrom', { read_only_from: readOnlyFrom })
        : say(lang, 'graceReadOnlySoon'),
    ].join(' ');
  } else if (license.notice === 'expiring') {
    const days = license.days_left;
    const left = Number.isSafeInteger(days)
      ? say(lang, days === 1 ? 'dayLeft' : 'daysLeft', { count: days })
      : '';
    sentence = lastDay
      ? say(lang, 'expiring', { plan, last_day: lastDay, left })
      : say(lang, 'expiringNoDate', { plan, left });
  } else {
    return '';
  }
  return license.contact
    ? `${sentence} ${say(lang, 'renewContact', { contact: license.contact })}`
    : sentence;
}
