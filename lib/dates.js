'use strict';
/**
 * Deterministic date handling.
 *
 * Used for two things:
 *  1. Verifying dates proposed by the AI against the exact text span it cites
 *     (an AI date is only accepted if the span really expresses that date).
 *  2. The rules-based fallback extractor (OpenAI unavailable / not configured).
 *
 * Policy: ambiguous expressions ("next week", "mid November", "next Friday")
 * are never turned into a date – they produce a clarification question.
 * Numeric dates are read day-first (DMY), the convention of the agencies served.
 */

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WEEKDAYS = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};
const WEEKDAY_RE = '(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|wed|thur?s?|fri|sat)';
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RETURN_HINT = /(return(?:ing)?|back|ret\.?|inbound|coming back|till|until|to)\s*(?:on\s+)?(?:the\s+)?$/i;

const pad = (n) => String(n).padStart(2, '0');
const toIso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

function isValidYmd(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function parseIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return isValidYmd(y, mo, d) ? { y, m: mo, d } : null;
}

function isIsoDate(iso) {
  return parseIso(iso) !== null;
}

function addDays(iso, days) {
  const p = parseIso(iso);
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return toIso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function diffDays(a, b) {
  const pa = parseIso(a);
  const pb = parseIso(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86400000);
}

function weekday(iso) {
  const p = parseIso(iso);
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
}

/** Current calendar date in the business timezone. */
function todayIn(timeZone, now) {
  const date = now ? new Date(now) : new Date();
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  } catch (_) {
    return date.toISOString().slice(0, 10);
  }
}

/** Offset (minutes) of a timezone at a given instant. */
function tzOffsetMinutes(timeZone, now) {
  const date = now ? new Date(now) : new Date();
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return Math.round((asUtc - date.getTime()) / 60000);
  } catch (_) {
    return 0;
  }
}

/** Hours from `now` until the start (00:00 business time) of an ISO date. */
function hoursUntil(iso, now, timeZone) {
  const p = parseIso(iso);
  if (!p) return null;
  const nowMs = now ? new Date(now).getTime() : Date.now();
  const startUtc = Date.UTC(p.y, p.m - 1, p.d) - tzOffsetMinutes(timeZone || 'UTC', nowMs) * 60000;
  return (startUtc - nowMs) / 3600000;
}

function resolveDayMonth(day, month, year, today) {
  if (year) {
    const y = year < 100 ? 2000 + year : year;
    return isValidYmd(y, month, day) ? toIso(y, month, day) : null;
  }
  const t = parseIso(today);
  for (const y of [t.y, t.y + 1]) {
    if (!isValidYmd(y, month, day)) continue;
    const iso = toIso(y, month, day);
    if (iso >= today) return iso;
  }
  return null;
}

/** "the 25th": same month as the anchor (or today) if not earlier, otherwise next month. */
function resolveDayOnly(day, anchor, today) {
  const base = parseIso(anchor || today);
  if (!base) return null;
  for (let i = 0; i < 3; i += 1) {
    const monthIndex = base.m - 1 + i;
    const y = base.y + Math.floor(monthIndex / 12);
    const m = (monthIndex % 12) + 1;
    if (!isValidYmd(y, m, day)) continue;
    const iso = toIso(y, m, day);
    if (iso >= (anchor || today)) return iso;
  }
  return null;
}

function upcomingWeekday(target, today) {
  const delta = (target - weekday(today) + 7) % 7 || 7;
  return addDays(today, delta);
}

/**
 * Find date expressions in text.
 * Returns [{ text, start, end, iso, ambiguous, kind, role, candidates }]
 * role is 'return' when the expression is introduced by a return keyword.
 */
function findDates(text, opts) {
  const options = opts || {};
  const today = options.today;
  const src = String(text || '');
  const out = [];
  const taken = [];
  const free = (s, e) => !taken.some(([a, b]) => s < b && e > a);
  const push = (match, item) => {
    const start = match.index;
    const end = start + match[0].length;
    if (!free(start, end)) return false;
    taken.push([start, end]);
    const before = src.slice(Math.max(0, start - 18), start);
    out.push(Object.assign({ text: match[0].trim(), start, end, role: RETURN_HINT.test(before) ? 'return' : null }, item));
    return true;
  };
  const scan = (re, fn) => {
    const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m;
    while ((m = r.exec(src)) !== null) fn(m);
  };

  // Ranges: "17-25 Nov", "17 to 25 November 2026"
  scan(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:-|–|to|till|until)\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\.?(?:,?\\s*(\\d{4}))?\\b`, 'i'), (m) => {
    const month = MONTHS[m[3].toLowerCase()];
    const year = m[4] ? Number(m[4]) : null;
    const dep = resolveDayMonth(Number(m[1]), month, year, today);
    const ret = dep ? resolveDayOnly(Number(m[2]), dep, today) : null;
    if (push(m, { iso: dep, ambiguous: !dep, kind: 'range_start', range_end: ret })) {
      out.push({ text: m[0].trim(), start: m.index, end: m.index + m[0].length, iso: ret, ambiguous: !ret, kind: 'range_end', role: 'return' });
    }
  });
  // ISO 2026-11-17
  scan(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/, (m) => {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    push(m, { iso: isValidYmd(y, mo, d) ? toIso(y, mo, d) : null, ambiguous: !isValidYmd(y, mo, d), kind: 'explicit' });
  });
  // Day-first numeric: 17/11, 17/11/2026, 17.11.26, 17-11-2026 (dash needs a year)
  scan(/\b(\d{1,2})([/.])(\d{1,2})(?:\2(\d{2,4}))?\b|\b(\d{1,2})-(\d{1,2})-(\d{2,4})\b/, (m) => {
    const d = Number(m[1] || m[5]);
    const mo = Number(m[3] || m[6]);
    const yRaw = m[4] || m[7];
    const y = yRaw ? Number(yRaw) : null;
    const iso = isValidYmd(y ? (y < 100 ? 2000 + y : y) : 2000, mo, d) ? resolveDayMonth(d, mo, y, today) : null;
    push(m, { iso, ambiguous: !iso, kind: 'explicit' });
  });
  // 17 Nov, 17th November 2026, 17Nov
  scan(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?${MONTH_RE}\\.?(?:,?\\s*(\\d{4}))?\\b`, 'i'), (m) => {
    const iso = resolveDayMonth(Number(m[1]), MONTHS[m[2].toLowerCase()], m[3] ? Number(m[3]) : null, today);
    push(m, { iso, ambiguous: !iso, kind: 'explicit' });
  });
  // Nov 17, November 17th, 2026
  scan(new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?\\b`, 'i'), (m) => {
    const iso = resolveDayMonth(Number(m[2]), MONTHS[m[1].toLowerCase()], m[3] ? Number(m[3]) : null, today);
    push(m, { iso, ambiguous: !iso, kind: 'explicit' });
  });
  // Ambiguous periods – never resolved to a date.
  scan(new RegExp(`\\b(?:next|this|coming|following)\\s+(?:week|weekend|month|fortnight)\\b|\\b(?:early|mid|late|end of|beginning of|start of)[\\s-]+(?:${MONTH_RE}|next month|the month|this month)\\b|\\bweekend\\b|\\bsometime\\b|\\bsoon\\b`, 'i'), (m) => {
    push(m, { iso: null, ambiguous: true, kind: 'ambiguous_period' });
  });
  // Relative days
  scan(/\bday after tomorrow\b/i, (m) => push(m, { iso: addDays(today, 2), ambiguous: false, kind: 'relative' }));
  scan(/\b(?:tomorrow|tmrw|tmr)(?:'s)?\b/i, (m) => push(m, { iso: addDays(today, 1), ambiguous: false, kind: 'relative' }));
  scan(/\b(?:today|tonight)(?:'s)?\b/i, (m) => push(m, { iso: today, ambiguous: false, kind: 'relative' }));
  scan(/\bin\s+(\d{1,2})\s+days?\b/i, (m) => push(m, { iso: addDays(today, Number(m[1])), ambiguous: false, kind: 'relative' }));
  // "next Friday" is ambiguous (this coming Friday or the one after?) -> clarify with both candidates.
  scan(new RegExp(`\\bnext\\s+${WEEKDAY_RE}\\b`, 'i'), (m) => {
    const first = upcomingWeekday(WEEKDAYS[m[1].toLowerCase()], today);
    push(m, { iso: null, ambiguous: true, kind: 'ambiguous_weekday', candidates: [first, addDays(first, 7)] });
  });
  scan(new RegExp(`\\b(?:this|on|coming)\\s+${WEEKDAY_RE}\\b`, 'i'), (m) => {
    push(m, { iso: upcomingWeekday(WEEKDAYS[m[1].toLowerCase()], today), ambiguous: false, kind: 'relative' });
  });
  // Day only with ordinal: "the 25th", "return 25th"
  scan(/\b(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/i, (m) => {
    push(m, { iso: null, ambiguous: false, kind: 'day_only', day: Number(m[1]) });
  });
  // "return 25" without ordinal (only right after a return keyword)
  scan(/\b(?:return(?:ing)?|back|ret)\s+(?:on\s+)?(?:the\s+)?(\d{1,2})\b(?!\s*(?:pax|passengers?|adults?|kg|kgs|days?|%|seats?|people|persons|hrs?|hours?|mins?))/i, (m) => {
    const sub = /(\d{1,2})\s*$/.exec(m[0]);
    const index = m.index + m[0].length - sub[0].length;
    const fake = Object.assign([sub[0]], { index });
    if (push(fake, { iso: null, ambiguous: false, kind: 'day_only', day: Number(sub[1]) })) out[out.length - 1].role = 'return';
  });
  // Month only ("in November") – ambiguous. "may" is excluded (modal verb).
  scan(/\b(jan(?:uary)?|feb(?:ruary)?|march|apr(?:il)?|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i, (m) => {
    push(m, { iso: null, ambiguous: true, kind: 'month_only' });
  });

  out.sort((a, b) => a.start - b.start);
  // Resolve day-only mentions against the previous explicit date (anchor) or the provided anchor.
  let anchor = options.anchor || null;
  for (const item of out) {
    if (item.kind === 'day_only') {
      item.iso = resolveDayOnly(item.day, item.role === 'return' ? anchor : anchor || null, today);
      item.ambiguous = !item.iso;
    }
    if (item.iso && item.kind !== 'range_end') anchor = item.iso;
  }
  return out;
}

/**
 * Check a date proposed by the AI against the text span it quotes as evidence.
 * Returns { ok, iso, reason }.
 */
function verifyDateEvidence(aiIso, evidence, sourceText, opts) {
  const options = opts || {};
  if (!aiIso) return { ok: false, iso: null, reason: 'no_date' };
  if (!isIsoDate(aiIso)) return { ok: false, iso: null, reason: 'invalid_format' };
  if (!evidence || !String(sourceText || '').toLowerCase().includes(String(evidence).toLowerCase().trim())) {
    return { ok: false, iso: null, reason: 'evidence_not_in_message' };
  }
  const mentions = findDates(evidence, options);
  if (mentions.some((m) => m.ambiguous)) return { ok: false, iso: null, reason: 'ambiguous_expression' };
  const resolved = mentions.filter((m) => m.iso).map((m) => m.iso);
  if (resolved.length) {
    if (resolved.includes(aiIso)) return { ok: true, iso: aiIso, reason: 'verified' };
    if (resolved.length === 1) return { ok: true, iso: resolved[0], reason: 'corrected_by_rules' };
    return { ok: false, iso: null, reason: 'evidence_mismatch' };
  }
  // A format we do not parse: accept only if the span contains digits or a relative-day keyword.
  if (/\d/.test(evidence)) return { ok: true, iso: aiIso, reason: 'unparsed_but_numeric' };
  return { ok: false, iso: null, reason: 'unverifiable' };
}

function formatLong(iso) {
  const p = parseIso(iso);
  return p ? `${p.d} ${MONTH_NAMES[p.m - 1]} ${p.y}` : '';
}

function formatShort(iso) {
  const p = parseIso(iso);
  return p ? `${p.d} ${MONTH_NAMES[p.m - 1].slice(0, 3)} ${p.y}` : '';
}

function formatDayMonth(iso) {
  const p = parseIso(iso);
  return p ? `${p.d} ${MONTH_NAMES[p.m - 1].slice(0, 3)}` : '';
}

/** "2026-11-17T04:15" -> "17 Nov 2026, 04:15" */
function formatDateTime(value) {
  if (!value) return '';
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/.exec(String(value));
  if (!m) return formatShort(String(value).slice(0, 10));
  return `${formatShort(m[1])}, ${m[2]}:${m[3]}`;
}

module.exports = {
  MONTH_NAMES,
  isIsoDate,
  parseIso,
  addDays,
  diffDays,
  weekday,
  todayIn,
  tzOffsetMinutes,
  hoursUntil,
  findDates,
  verifyDateEvidence,
  formatLong,
  formatShort,
  formatDayMonth,
  formatDateTime,
};
