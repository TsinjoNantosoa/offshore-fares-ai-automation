'use strict';
/**
 * Airport / city reference used to normalise locations and to double-check
 * AI output. A city resolves to its primary international airport (documented
 * assumption: London -> LHR, New York -> JFK). Operators can change the
 * airport on the RFQ; production should load the full IATA dataset.
 *
 * Format: IATA|City|Airport|Country(ISO2)|extra aliases (;-separated)
 */
const RAW = [
  'BOM|Mumbai|Chhatrapati Shivaji Maharaj Intl|IN|bombay',
  'DEL|Delhi|Indira Gandhi Intl|IN|new delhi',
  'BLR|Bengaluru|Kempegowda Intl|IN|bangalore',
  'MAA|Chennai|Chennai Intl|IN|madras',
  'HYD|Hyderabad|Rajiv Gandhi Intl|IN|',
  'CCU|Kolkata|Netaji Subhas Chandra Bose Intl|IN|calcutta',
  'COK|Kochi|Cochin Intl|IN|cochin',
  'AMD|Ahmedabad|Sardar Vallabhbhai Patel Intl|IN|',
  'GOI|Goa|Dabolim|IN|',
  'PNQ|Pune|Pune Airport|IN|',
  'LHR|London Heathrow|Heathrow|GB|london;heathrow',
  'LGW|London Gatwick|Gatwick|GB|gatwick',
  'MAN|Manchester|Manchester Airport|GB|',
  'EDI|Edinburgh|Edinburgh Airport|GB|',
  'BHX|Birmingham|Birmingham Airport|GB|',
  'DXB|Dubai|Dubai Intl|AE|',
  'AUH|Abu Dhabi|Zayed Intl|AE|',
  'DOH|Doha|Hamad Intl|QA|',
  'BAH|Bahrain|Bahrain Intl|BH|manama',
  'MCT|Muscat|Muscat Intl|OM|',
  'RUH|Riyadh|King Khalid Intl|SA|',
  'JED|Jeddah|King Abdulaziz Intl|SA|',
  'KWI|Kuwait|Kuwait Intl|KW|kuwait city',
  'IST|Istanbul|Istanbul Airport|TR|',
  'CDG|Paris|Charles de Gaulle|FR|paris cdg',
  'FRA|Frankfurt|Frankfurt Airport|DE|',
  'MUC|Munich|Munich Airport|DE|muenchen',
  'AMS|Amsterdam|Schiphol|NL|',
  'ZRH|Zurich|Zurich Airport|CH|',
  'GVA|Geneva|Geneva Airport|CH|',
  'MAD|Madrid|Barajas|ES|',
  'BCN|Barcelona|El Prat|ES|',
  'FCO|Rome|Fiumicino|IT|',
  'MXP|Milan|Malpensa|IT|',
  'VIE|Vienna|Vienna Intl|AT|',
  'CPH|Copenhagen|Kastrup|DK|',
  'HEL|Helsinki|Helsinki-Vantaa|FI|',
  'DUB|Dublin|Dublin Airport|IE|',
  'LIS|Lisbon|Humberto Delgado|PT|',
  'ATH|Athens|Athens Intl|GR|',
  'JFK|New York|John F. Kennedy Intl|US|nyc;new york city;jfk',
  'EWR|Newark|Newark Liberty Intl|US|',
  'BOS|Boston|Logan Intl|US|',
  'IAD|Washington|Dulles Intl|US|washington dc',
  'ORD|Chicago|O\'Hare Intl|US|',
  'ATL|Atlanta|Hartsfield-Jackson|US|',
  'DFW|Dallas|Dallas/Fort Worth Intl|US|',
  'IAH|Houston|George Bush Intercontinental|US|',
  'MIA|Miami|Miami Intl|US|',
  'LAX|Los Angeles|Los Angeles Intl|US|la',
  'SFO|San Francisco|San Francisco Intl|US|',
  'SEA|Seattle|Seattle-Tacoma Intl|US|',
  'YYZ|Toronto|Pearson Intl|CA|',
  'YVR|Vancouver|Vancouver Intl|CA|',
  'YUL|Montreal|Trudeau Intl|CA|',
  'SIN|Singapore|Changi|SG|',
  'HKG|Hong Kong|Hong Kong Intl|HK|',
  'BKK|Bangkok|Suvarnabhumi|TH|',
  'KUL|Kuala Lumpur|Kuala Lumpur Intl|MY|',
  'NRT|Tokyo|Narita|JP|tokyo narita',
  'HND|Tokyo Haneda|Haneda|JP|haneda',
  'ICN|Seoul|Incheon|KR|',
  'PEK|Beijing|Capital Intl|CN|',
  'PVG|Shanghai|Pudong|CN|',
  'SYD|Sydney|Kingsford Smith|AU|',
  'MEL|Melbourne|Tullamarine|AU|',
  'AKL|Auckland|Auckland Airport|NZ|',
  'JNB|Johannesburg|O.R. Tambo Intl|ZA|',
  'CPT|Cape Town|Cape Town Intl|ZA|',
  'NBO|Nairobi|Jomo Kenyatta Intl|KE|',
  'ADD|Addis Ababa|Bole Intl|ET|',
  'CAI|Cairo|Cairo Intl|EG|',
  'LOS|Lagos|Murtala Muhammed Intl|NG|',
  'MRU|Mauritius|Sir Seewoosagur Ramgoolam Intl|MU|',
  'TNR|Antananarivo|Ivato Intl|MG|tana',
  'MLE|Male|Velana Intl|MV|maldives',
  'CMB|Colombo|Bandaranaike Intl|LK|',
  'KTM|Kathmandu|Tribhuvan Intl|NP|',
  'DAC|Dhaka|Hazrat Shahjalal Intl|BD|',
  'GRU|Sao Paulo|Guarulhos|BR|são paulo',
  'EZE|Buenos Aires|Ezeiza|AR|',
  'MEX|Mexico City|Benito Juarez Intl|MX|',
];

const AIRPORTS = RAW.map((line) => {
  const [iata, city, name, country, extra] = line.split('|');
  const aliases = [city.toLowerCase()].concat((extra || '').split(';').map((s) => s.trim()).filter(Boolean));
  return { iata, city, name, country, aliases };
});

const BY_IATA = Object.fromEntries(AIRPORTS.map((a) => [a.iata, a]));

/** All alias strings sorted longest first so "london gatwick" wins over "london". */
const ALIAS_INDEX = AIRPORTS.flatMap((a) => a.aliases.map((alias) => ({ alias, iata: a.iata })))
  .sort((x, y) => y.alias.length - x.alias.length);

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lookupIata(code) {
  if (!code) return null;
  return BY_IATA[String(code).trim().toUpperCase()] || null;
}

/**
 * Resolve free text ("Mumbai", "BOM", "London Heathrow") to an airport.
 * Returns { raw, iata, city, known } or null when nothing usable was given.
 */
function resolveLocation(raw, aiIata) {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    if (aiIata && /^[A-Z]{3}$/.test(aiIata)) {
      const known = lookupIata(aiIata);
      return { raw: null, iata: aiIata, city: known ? known.city : null, known: Boolean(known) };
    }
    return null;
  }
  const text = String(raw).trim();
  const upper = text.toUpperCase();
  if (/^[A-Z]{3}$/.test(upper) && lookupIata(upper)) {
    return { raw: text, iata: upper, city: BY_IATA[upper].city, known: true };
  }
  const lower = text.toLowerCase();
  for (const { alias, iata } of ALIAS_INDEX) {
    if (lower === alias || new RegExp(`\\b${escapeRegex(alias)}\\b`).test(lower)) {
      return { raw: text, iata, city: BY_IATA[iata].city, known: true };
    }
  }
  if (aiIata && /^[A-Z]{3}$/.test(String(aiIata).toUpperCase())) {
    const code = String(aiIata).toUpperCase();
    const known = lookupIata(code);
    return { raw: text, iata: code, city: known ? known.city : null, known: Boolean(known) };
  }
  if (/^[A-Za-z]{3}$/.test(text)) {
    // Looks like an IATA code we do not have in the reference list.
    return { raw: text, iata: upper, city: null, known: false };
  }
  return { raw: text, iata: null, city: null, known: false };
}

/**
 * Find every location mention in a text, in order of appearance.
 * Recognises city names/aliases and upper-case IATA codes from the reference list.
 */
function findLocations(text) {
  const found = [];
  const lower = String(text || '').toLowerCase();
  const taken = [];
  const overlaps = (start, end) => taken.some(([s, e]) => start < e && end > s);
  for (const { alias, iata } of ALIAS_INDEX) {
    const re = new RegExp(`\\b${escapeRegex(alias)}\\b`, 'g');
    let m;
    while ((m = re.exec(lower)) !== null) {
      const start = m.index;
      const end = start + alias.length;
      if (overlaps(start, end)) continue;
      // "la" and similar short aliases only count when written as a stand-alone word in caps.
      if (alias.length <= 2 && String(text).slice(start, end) !== alias.toUpperCase()) continue;
      taken.push([start, end]);
      found.push({ index: start, end, raw: String(text).slice(start, end), iata });
    }
  }
  const codeRe = /\b([A-Z]{3})\b/g;
  let m;
  while ((m = codeRe.exec(String(text || ''))) !== null) {
    if (!BY_IATA[m[1]]) continue;
    const start = m.index;
    const end = start + 3;
    if (overlaps(start, end)) continue;
    taken.push([start, end]);
    found.push({ index: start, end, raw: m[1], iata: m[1] });
  }
  return found.sort((a, b) => a.index - b.index);
}

function describe(iata) {
  const a = lookupIata(iata);
  return a ? `${a.city} (${a.iata})` : iata || '';
}

function cityName(iata) {
  const a = lookupIata(iata);
  return a ? a.city : iata || '';
}

module.exports = { AIRPORTS, lookupIata, resolveLocation, findLocations, describe, cityName };
