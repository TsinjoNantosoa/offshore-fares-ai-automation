'use strict';
/**
 * WF07 – Priority engine. Deterministic, explainable rules (no AI).
 * Every rule that fires is returned in `breakdown` and stored on the RFQ.
 * Weights can be overridden with PRIORITY_RULES_JSON (e.g. {"BUSINESS":25}).
 */
const { hoursUntil } = require('./dates');
const { totalPassengers } = require('./requirements');

const DEFAULT_RULES = {
  TRAVEL_UNDER_24H: 40,
  TRAVEL_UNDER_72H: 25,
  FIRST: 25,
  BUSINESS: 20,
  GROUP: 20,
  VIP_AGENCY: 15,
  EXPLICIT_URGENT: 10,
  MODIFICATION_UNDER_24H: 30,
  // Documented addition: 3+ passengers in a premium cabin is a high-value request.
  MULTI_PAX_PREMIUM: 10,
};

const LEVELS = [
  { min: 70, level: 'CRITICAL' },
  { min: 50, level: 'HIGH' },
  { min: 30, level: 'NORMAL' },
  { min: 0, level: 'LOW' },
];

const AFTER_SALES = ['CHANGE_REQUEST', 'CANCELLATION', 'REFUND_REQUEST'];

function rulesFromConfig(cfg) {
  const rules = Object.assign({}, DEFAULT_RULES);
  if (cfg && cfg.PRIORITY_RULES_JSON) {
    try {
      const override = JSON.parse(cfg.PRIORITY_RULES_JSON);
      for (const [k, v] of Object.entries(override)) if (k in rules && Number.isFinite(Number(v))) rules[k] = Number(v);
    } catch (_) { /* keep defaults on invalid JSON */ }
  }
  return rules;
}

function levelFor(score) {
  return LEVELS.find((l) => score >= l.min).level;
}

/**
 * @param {object} input { intent, requirements, travel_date, agency: { priority_level }, now }
 * @returns {{ score, level, breakdown: Array<{rule, points}> }}
 */
function scorePriority(input, cfg) {
  const rules = rulesFromConfig(cfg);
  const req = input.requirements || {};
  const intent = input.intent || req.intent;
  const breakdown = [];
  const add = (rule) => breakdown.push({ rule, points: rules[rule] });

  const travelDate = input.travel_date || req.departure_date || (req.segments && req.segments[0] && req.segments[0].date) || null;
  const hours = travelDate ? hoursUntil(travelDate, input.now, (cfg && cfg.BUSINESS_TIMEZONE) || 'UTC') : null;
  if (hours !== null && hours < 24) add('TRAVEL_UNDER_24H');
  else if (hours !== null && hours < 72) add('TRAVEL_UNDER_72H');

  if (req.cabin === 'FIRST') add('FIRST');
  else if (req.cabin === 'BUSINESS') add('BUSINESS');

  const groupMin = (cfg && cfg.GROUP_MIN_PASSENGERS) || 10;
  if (intent === 'GROUP_BOOKING' || totalPassengers(req) >= groupMin) add('GROUP');
  else if (['BUSINESS', 'FIRST'].includes(req.cabin) && totalPassengers(req) >= 3) add('MULTI_PAX_PREMIUM');

  if (input.agency && String(input.agency.priority_level || '').toUpperCase() === 'VIP') add('VIP_AGENCY');
  if (req.urgency === 'HIGH' || input.explicit_urgent) add('EXPLICIT_URGENT');
  if (AFTER_SALES.includes(intent) && hours !== null && hours < 24) add('MODIFICATION_UNDER_24H');

  const score = Math.min(100, breakdown.reduce((sum, b) => sum + b.points, 0));
  return { score, level: levelFor(score), breakdown, hours_to_departure: hours === null ? null : Math.round(hours * 10) / 10 };
}

module.exports = { DEFAULT_RULES, scorePriority, levelFor };
