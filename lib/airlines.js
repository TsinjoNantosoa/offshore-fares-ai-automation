'use strict';
/**
 * Airline reference for normalising preferences ("Qatar", "QR", "Qatar Airways").
 * Format: IATA code|Official name|aliases (;-separated, lower case)
 */
const RAW = [
  'QR|Qatar Airways|qatar;qatar airways',
  'EK|Emirates|emirates;emirate',
  'EY|Etihad Airways|etihad',
  'BA|British Airways|british airways;british;ba',
  'VS|Virgin Atlantic|virgin atlantic;virgin',
  'AI|Air India|air india',
  'UK|Vistara|vistara',
  '6E|IndiGo|indigo',
  'LH|Lufthansa|lufthansa',
  'LX|SWISS|swiss;swiss air;swiss international',
  'AF|Air France|air france',
  'KL|KLM|klm',
  'TK|Turkish Airlines|turkish;turkish airlines;thy',
  'SQ|Singapore Airlines|singapore airlines;sia',
  'CX|Cathay Pacific|cathay;cathay pacific',
  'NH|ANA|ana;all nippon',
  'JL|Japan Airlines|japan airlines;jal',
  'QF|Qantas|qantas',
  'UA|United Airlines|united;united airlines',
  'AA|American Airlines|american airlines;american',
  'DL|Delta Air Lines|delta',
  'AC|Air Canada|air canada',
  'GF|Gulf Air|gulf air',
  'WY|Oman Air|oman air',
  'SV|Saudia|saudia;saudi airlines',
  'ET|Ethiopian Airlines|ethiopian',
  'KQ|Kenya Airways|kenya airways',
  'MK|Air Mauritius|air mauritius',
  'MS|EgyptAir|egyptair;egypt air',
  'TG|Thai Airways|thai;thai airways',
  'MH|Malaysia Airlines|malaysia airlines',
  'KE|Korean Air|korean air;korean',
  'AY|Finnair|finnair',
  'IB|Iberia|iberia',
  'AZ|ITA Airways|ita airways;alitalia',
];

const AIRLINES = RAW.map((line) => {
  const [code, name, aliases] = line.split('|');
  return { code, name, aliases: aliases.split(';') };
});

const ALIASES = AIRLINES.flatMap((a) => a.aliases.map((alias) => ({ alias, airline: a })))
  .sort((x, y) => y.alias.length - x.alias.length);

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Normalise one airline mention to its official name; unknown names are kept as written. */
function normalizeAirline(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  const upper = text.toUpperCase();
  const byCode = AIRLINES.find((a) => a.code === upper);
  if (byCode) return byCode.name;
  const lower = text.toLowerCase();
  const hit = ALIASES.find(({ alias }) => lower === alias || new RegExp(`\\b${escapeRegex(alias)}\\b`).test(lower));
  return hit ? hit.airline.name : text;
}

/**
 * Find airlines mentioned in free text. Two-letter codes only count when written in
 * capitals and isolated (avoids matching "ba" or "ana" inside other words).
 */
function findAirlines(text) {
  const src = String(text || '');
  const lower = src.toLowerCase();
  const hits = [];
  const taken = [];
  for (const { alias, airline } of ALIASES) {
    const re = new RegExp(`\\b${escapeRegex(alias)}\\b`, 'g');
    let m;
    while ((m = re.exec(lower)) !== null) {
      const start = m.index;
      const end = start + alias.length;
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      if (alias.length <= 3 && src.slice(start, end) !== alias.toUpperCase()) continue;
      taken.push([start, end]);
      hits.push({ index: start, name: airline.name, code: airline.code });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

/** True when `name` is mentioned in `text` under any known alias (or literally). */
function isMentioned(name, text) {
  const normalized = normalizeAirline(name);
  if (findAirlines(text).some((h) => h.name === normalized)) return true;
  return String(text || '').toLowerCase().includes(String(name || '').toLowerCase());
}

function airlineCode(name) {
  const n = normalizeAirline(name);
  const a = AIRLINES.find((x) => x.name === n);
  return a ? a.code : null;
}

module.exports = { AIRLINES, normalizeAirline, findAirlines, isMentioned, airlineCode };
