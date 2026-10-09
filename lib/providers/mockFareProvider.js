'use strict';
/**
 * MockFareProvider – DEMO ONLY.
 *
 * Produces plausible, deterministic sample options so the Mock Fare Desk form
 * can be pre-filled during a demo. The operator still reviews and submits them
 * (source = MOCK). These are NOT real fares, schedules or availability.
 */
const { FareProvider } = require('./fareProvider');

const HUBS = [
  { airline: 'Qatar Airways', code: 'QR', hub: 'DOH', base: 2450, bag: '40 kg', change: 'USD 150', refund: 'USD 250', out: ['02:40', '04:20', '07:55', '13:05'], ret: ['15:20', '19:45', '01:30', '08:10'] },
  { airline: 'Emirates', code: 'EK', hub: 'DXB', base: 2610, bag: '40 kg', change: 'USD 200', refund: 'USD 300', out: ['04:05', '05:55', '08:30', '13:15'], ret: ['14:30', '18:55', '21:45', '07:35'] },
  { airline: 'British Airways', code: 'BA', hub: null, base: 2890, bag: '2 x 32 kg', change: 'USD 0 (fare difference applies)', refund: 'USD 400', out: ['02:15', '07:25'], ret: ['20:50', '10:35'] },
];

function hash(str) {
  let h = 0;
  for (const ch of String(str)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

function addDaysIso(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function buildOption(h, req, idx, now) {
  const origin = req.origin.iata;
  const dest = req.destination.iata;
  const variance = (hash(`${origin}${dest}${h.code}`) % 9) * 10;
  const cabinFactor = { FIRST: 2.1, BUSINESS: 1, PREMIUM_ECONOMY: 0.45, ECONOMY: 0.22 }[req.cabin] || 1;
  const amount = Math.round(((origin === 'BOM' && dest === 'LHR' ? h.base : h.base + variance) * cabinFactor) / 10) * 10;
  const dep = req.departure_date;
  const segments = [];
  if (h.hub && h.hub !== origin && h.hub !== dest) {
    segments.push({ direction: 'OUTBOUND', flight_no: `${h.code} ${500 + (hash(origin) % 400)}`, from: origin, to: h.hub, depart_at: `${dep}T${h.out[0]}`, arrive_at: `${dep}T${h.out[1]}` });
    segments.push({ direction: 'OUTBOUND', flight_no: `${h.code} ${1 + (hash(dest) % 60)}`, from: h.hub, to: dest, depart_at: `${dep}T${h.out[2]}`, arrive_at: `${dep}T${h.out[3]}` });
  } else {
    segments.push({ direction: 'OUTBOUND', flight_no: `${h.code} ${100 + (hash(origin + dest) % 100)}`, from: origin, to: dest, depart_at: `${dep}T${h.out[0]}`, arrive_at: `${dep}T${h.out[1]}` });
  }
  if (req.return_date) {
    const ret = req.return_date;
    if (h.hub && h.hub !== origin && h.hub !== dest) {
      segments.push({ direction: 'INBOUND', flight_no: `${h.code} ${2 + (hash(dest) % 60)}`, from: dest, to: h.hub, depart_at: `${ret}T${h.ret[0]}`, arrive_at: `${ret}T${h.ret[1]}` });
      segments.push({ direction: 'INBOUND', flight_no: `${h.code} ${501 + (hash(origin) % 400)}`, from: h.hub, to: origin, depart_at: `${addDaysIso(ret, 1)}T${h.ret[2]}`, arrive_at: `${addDaysIso(ret, 1)}T${h.ret[3]}` });
    } else {
      segments.push({ direction: 'INBOUND', flight_no: `${h.code} ${101 + (hash(origin + dest) % 100)}`, from: dest, to: origin, depart_at: `${ret}T${h.ret[0]}`, arrive_at: `${addDaysIso(ret, 1)}T${h.ret[1]}` });
    }
  }
  const validUntil = new Date((now ? new Date(now).getTime() : Date.now()) + 2 * 3600 * 1000).toISOString();
  return {
    airline: h.airline,
    flight_segments: segments,
    departure_at: segments[0].depart_at,
    arrival_at: segments.filter((s) => s.direction === 'OUTBOUND').slice(-1)[0].arrive_at,
    return_departure_at: req.return_date ? segments.find((s) => s.direction === 'INBOUND').depart_at : null,
    total_duration_minutes: h.hub ? 690 + idx * 35 : 590,
    stops: h.hub && h.hub !== origin && h.hub !== dest ? 1 : 0,
    cabin: req.cabin,
    fare: { amount, currency: 'USD' },
    fare_basis: 'PER_PASSENGER',
    baggage: h.bag,
    change_penalty: h.change,
    refund_penalty: h.refund,
    fare_valid_until: validUntil,
    source: 'MOCK',
    verified: true,
  };
}

class MockFareProvider extends FareProvider {
  constructor(now) {
    super('MockFareProvider');
    this.now = now;
  }

  async searchFlights(request) {
    return MockFareProvider.sampleOptions(request, this.now);
  }

  static sampleOptions(request, now) {
    const req = request || {};
    if (!req.origin || !req.origin.iata || !req.destination || !req.destination.iata || !req.departure_date) return [];
    const r = Object.assign({ cabin: 'BUSINESS' }, req, { cabin: req.cabin && req.cabin !== 'UNKNOWN' ? req.cabin : 'BUSINESS' });
    return HUBS.map((h, i) => buildOption(h, r, i, now));
  }
}

module.exports = { MockFareProvider };
