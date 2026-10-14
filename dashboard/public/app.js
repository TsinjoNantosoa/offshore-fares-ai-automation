/* Offshore Fares – Ops Console (vanilla JS, no build step, no external assets) */
'use strict';

const $view = document.getElementById('view');
const state = {
  config: null, timer: null, nav: 0, simulator: null, quoteTab: 'email', activityTab: 'audit',
  queueFilter: 'all', queueSearch: '', alertFilter: 'all',
  disclosures: Object.create(null),
  operator: localStorage.getItem('of_operator') || 'Aisha Khan',
};
const UI = globalThis.OffshoreFaresUiPolicy;
if (!UI) throw new Error('RFQ UI presentation policy is unavailable');

// ---------------------------------------------------------------------------
// icons (inline SVG, stroke-based)
// ---------------------------------------------------------------------------
const ICONS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  play: '<circle cx="12" cy="12" r="10"/><path d="m10 8 6 4-6 4z"/>',
  plane: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  check: '<path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="m22 4-10 10-3-3"/>',
  ticket: '<path d="M2 9a3 3 0 0 0 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 0 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"/><path d="M13 5v2M13 17v2M13 11v2"/>',
  skull: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.8-.9L3 21l1.9-5.2A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  back: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  sparkle: '<path d="m12 3 1.9 5.8L20 10.7l-6.1 1.9L12 18.5l-1.9-5.9L4 10.7l6.1-1.9z"/>',
};
const icon = (name, cls) => `<svg class="i ${cls || ''}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

// ---------------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------------
const esc = (v) => String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDay = (v) => (v ? new Date(`${String(v).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '—');
const fmtTime = (v) => (v ? new Date(v).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const fmtClock = (v) => (v ? new Date(v).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—');
const ago = (v) => {
  if (!v) return '—';
  const s = Math.max(0, Math.round((Date.now() - new Date(v)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
const waiting = (sec) => {
  if (sec === null || sec === undefined) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(sec % 60).padStart(2, '0')}s`;
};
/** minutes -> { value, unit } readable duration */
const duration = (min) => {
  if (min === null || min === undefined || Number.isNaN(Number(min))) return { value: '—', unit: '' };
  const m = Number(min);
  if (m < 90) return { value: m.toFixed(m < 10 ? 1 : 0), unit: 'min' };
  if (m < 60 * 48) return { value: (m / 60).toFixed(1), unit: 'h' };
  return { value: (m / 1440).toFixed(1), unit: 'days' };
};
const cabinLabel = (c) => ({ BUSINESS: 'Business', FIRST: 'First', PREMIUM_ECONOMY: 'Premium Economy', ECONOMY: 'Economy', UNKNOWN: '—' }[c] || c || '—');
const ACRONYMS = { rfq: 'RFQ', ai: 'AI', sla: 'SLA', pnr: 'PNR', kb: 'KB', whatsapp: 'WhatsApp', openai: 'OpenAI' };
const human = (s) => String(s || '').toLowerCase().replace(/_/g, ' ').replace(/\b[a-z]+\b/g, (w) => ACRONYMS[w] || w).replace(/^\w/, (c) => c.toUpperCase());
const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';
const statusTag = (s, label) => `<span class="status ${esc(s)}" title="${esc(s)}">${esc(label || human(s))}</span>`;
const badge = (txt, cls) => `<span class="badge ${esc(cls || txt)}">${esc(txt)}</span>`;
const prioBadge = (p) => badge(human(p), p);
const channelIcon = (ch) => `<span class="ch" title="${esc(ch)}">${icon(ch === 'whatsapp' ? 'chat' : 'mail')}</span>`;
const emptyState = (ico, title, text) => `<div class="empty"><div class="empty-ico">${icon(ico)}</div><strong>${esc(title)}</strong><div class="small">${text}</div></div>`;
const pageHead = (eyebrow, title, sub, right) => `
  <div class="page-head"><div><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${right || ''}</div>`;
const liveChip = (at) => `<span class="live"><span class="pulse"></span>Live · updated ${esc(fmtClock(at || new Date()))}</span>`;
const disclosureKey = (rfqNumber, id) => `${rfqNumber}:${id}`;
const disclosureOpen = (rfqNumber, id, defaultOpen = false) => {
  const key = disclosureKey(rfqNumber, id);
  return Object.prototype.hasOwnProperty.call(state.disclosures, key) ? state.disclosures[key] : defaultOpen;
};

async function api(path, opts) {
  const r = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(body.error || body.message || (body.response && body.response.error) || `HTTP ${r.status}`);
    err.body = body;
    throw err;
  }
  return body;
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });

function toast(msg, ms = 3500) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

/** Only paint if the user is still on the page that started the request (prevents stale overwrites). */
function paint(nav, html) {
  if (nav !== state.nav) return false;
  $view.innerHTML = html;
  return true;
}

/** Horizontal bars: zero is a true zero (no sliver), value labels on the right, hover title. */
function bars(rows, { labels, tone } = {}) {
  if (!rows || !rows.length) return emptyState('layers', 'No data yet', 'Values appear as requests arrive.');
  const top = Math.max(...rows.map((r) => r.n), 1);
  return `<div class="bars">${rows.map((r) => {
    const label = labels ? labels(r.k) : r.k;
    const w = r.n ? Math.max(2, (r.n / top) * 100) : 0;
    return `<div class="bar" title="${esc(label)}: ${r.n}"><span class="k">${esc(label)}</span>
      <span class="track"><span class="fill ${tone ? tone(r.k) : ''}" style="width:${w}%"></span></span><span class="n">${r.n}</span></div>`;
  }).join('')}</div>`;
}

function setActiveTab(name) {
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
}

function autoRefresh(fn, ms) {
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    if (!document.hidden && !document.activeElement.closest('form, textarea, input, select')) fn().catch(() => {});
  }, ms);
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
const STAGES = [
  ['Intake', ['NEW', 'NEEDS_INFORMATION']],
  ['Fare desk', ['READY_FOR_SEARCH', 'ASSIGNED', 'SEARCHING']],
  ['Quote', ['FARES_FOUND', 'PENDING_APPROVAL', 'APPROVED']],
  ['With client', ['QUOTED', 'AWAITING_CLIENT', 'CLIENT_INTERESTED']],
  ['Booking', ['BOOKING_REQUESTED', 'TICKETING', 'TICKETED']],
];
const TERMINAL = ['CLOSED', 'CANCELLED', 'LOST'];
const PRIORITY_TONE = { CRITICAL: 'crit', HIGH: 'serious', NORMAL: 'info', LOW: '' };

async function renderDashboard() {
  const nav = state.nav;
  const s = await api('/api/summary');
  const cur = s.current_by_status || {};
  const conv = s.conversion || {};
  const sources = Object.fromEntries((s.extraction_sources || []).map((r) => [r.k, r.n]));
  const open = Object.entries(cur).filter(([k]) => !TERMINAL.includes(k)).reduce((a, [, n]) => a + n, 0);
  const totals = s.totals || { week: 0, total: 0 };
  const fr = duration(s.timing.avg_first_response_min);
  const tq = duration(s.timing.avg_quote_min);
  const stageMax = Math.max(1, ...STAGES.map(([, sts]) => sts.reduce((a, k) => a + (cur[k] || 0), 0)));
  const channels = s.by_channel || [];
  const chTotal = channels.reduce((a, r) => a + r.n, 0) || 1;
  const chColor = { email: 'var(--brand)', whatsapp: 'var(--ok)' };
  const attention = [
    ['crit', 'alert', s.sla.open_breached, 'SLA breached', '#/queue'],
    ['warn', 'shield', cur.PENDING_APPROVAL || 0, 'Quotes waiting for approval', '#/queue'],
    ['ok', 'ticket', cur.BOOKING_REQUESTED || 0, 'Bookings to hand off', '#/queue'],
    ['info', 'skull', s.automation.dead_letters, 'Dead-letter messages', '#/activity'],
  ];
  paint(nav, `
    ${pageHead('Operations overview', 'Good to see you, fare desk', 'Every fare request from email and WhatsApp – understood by AI, verified by code, approved by humans.', liveChip(s.generated_at))}
    <div class="grid cols-4">
      <div class="card kpi hero"><div class="kpi-top">Open requests <span class="kpi-icon">${icon('layers')}</span></div>
        <div class="value">${open}</div><div class="sub">${totals.week} received in the last 7 days · ${s.today_total} today</div></div>
      <div class="card kpi hero"><div class="kpi-top">Avg first response <span class="kpi-icon ok">${icon('zap')}</span></div>
        <div class="value">${fr.value}<small>${fr.unit}</small></div><div class="sub">acknowledgement, clarification or quote</div></div>
      <div class="card kpi hero"><div class="kpi-top">Avg time to quote <span class="kpi-icon violet">${icon('clock')}</span></div>
        <div class="value">${tq.value}<small>${tq.unit}</small></div><div class="sub">request received → quote sent</div></div>
      <div class="card kpi hero"><div class="kpi-top">Quote → booking <span class="kpi-icon warn">${icon('target')}</span></div>
        <div class="value">${conv.rate ?? '—'}<small>%</small></div><div class="sub">${conv.booked || 0} bookings from ${conv.quoted || 0} quotes · 30 days</div></div>
    </div>

    <div class="section"><div class="section-head"><h2>Needs attention</h2><span>click to open</span></div>
      <div class="attention">${attention.map(([tone, ico, n, label, href]) => `
        <a class="att ${tone} ${n ? '' : 'zero'}" href="${href}"><span class="ico">${icon(ico)}</span><span><div class="n">${n}</div><div class="t">${esc(label)}</div></span></a>`).join('')}
      </div></div>

    <div class="section"><div class="section-head"><h2>Request pipeline</h2><span>open requests by stage</span></div>
      <div class="pipeline">${STAGES.map(([name, sts]) => {
        const n = sts.reduce((a, k) => a + (cur[k] || 0), 0);
        return `<div class="stage"><div class="stage-name"><i></i>${esc(name)}</div><div class="stage-n">${n}</div>
          <div class="chips">${sts.map((k) => `<span class="chip">${esc(human(k))} <b>${cur[k] || 0}</b></span>`).join('')}</div>
          <div class="stage-bar"><span style="width:${(n / stageMax) * 100}%"></span></div></div>`;
      }).join('')}</div></div>

    <div class="section grid cols-3">
      <div class="card"><header><h2>Requests by channel</h2><span class="sub">${totals.total} RFQs</span></header>
        <div class="split-bar">${channels.map((r) => `<span title="${esc(r.k)}: ${r.n}" style="width:${(r.n / chTotal) * 100}%;background:${chColor[r.k] || 'var(--muted)'}"></span>`).join('')}</div>
        <div class="split-legend">${channels.map((r) => `<div><span><span class="legend-dot" style="background:${chColor[r.k] || 'var(--muted)'}"></span>${r.k === 'whatsapp' ? 'WhatsApp' : r.k === 'email' ? 'Email' : esc(r.k)}</span><b>${r.n} · ${Math.round((r.n / chTotal) * 100)}%</b></div>`).join('')}</div>
        <div class="split-legend" style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border)">
          <div><span>Automated replies (24 h)</span><b>${s.automation.outbound_24h}</b></div>
          <div><span>AI extractions · rules fallback</span><b>${sources.openai || 0} · ${sources.rules || 0}</b></div>
        </div></div>
      <div class="card"><header><h2>Open requests by priority</h2><span class="sub">deterministic scoring</span></header>
        ${bars(['CRITICAL', 'HIGH', 'NORMAL', 'LOW'].map((k) => ({ k, n: (s.by_priority.find((p) => p.k === k) || { n: 0 }).n })), { labels: human, tone: (k) => PRIORITY_TONE[k] })}</div>
      <div class="card"><header><h2>Requests by cabin</h2><span class="sub">premium focus</span></header>${bars(s.by_cabin, { labels: cabinLabel })}</div>
      <div class="card"><header><h2>Top routes</h2></header>${bars(s.by_route)}</div>
      <div class="card"><header><h2>Top agencies</h2></header>${bars(s.by_agency)}</div>
      <div class="card"><header><h2>How it works</h2>${badge('human-in-the-loop', 'ai')}</header>
        <ol class="steps">
          <li><span><strong>Intake</strong> – email &amp; WhatsApp, de-duplicated</span></li>
          <li><span><strong>AI understanding</strong> – every value verified by code</span></li>
          <li><span><strong>Structured RFQ</strong> – priority &amp; desk routing</span></li>
          <li><span><strong>Fare desk</strong> – the AI never invents a price</span></li>
          <li><span><strong>Quote</strong> – numbers checked, human approves</span></li>
          <li><span><strong>Delivery</strong> – follow-ups &amp; booking handoff</span></li>
        </ol></div>
    </div>`);
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------
const QUEUE_FILTERS = [
  ['all', 'All', () => true],
  ['critical', 'Critical & high', (r) => ['CRITICAL', 'HIGH'].includes(r.priority_level)],
  ['sla', 'SLA at risk', (r) => ['BREACHED', 'AT_RISK'].includes(r.sla)],
  ['approval', 'Pending approval', (r) => r.status === 'PENDING_APPROVAL'],
  ['client', 'With client', (r) => ['QUOTED', 'AWAITING_CLIENT', 'CLIENT_INTERESTED'].includes(r.status)],
  ['booking', 'Booking', (r) => ['BOOKING_REQUESTED', 'TICKETING', 'TICKETED'].includes(r.status)],
  ['after-sales', 'After-sales', (r) => ['CHANGE_REQUESTED', 'REFUND_REQUESTED'].includes(r.status)],
  ['review', 'Needs review', (r) => r.requires_human],
];

async function renderQueue() {
  const nav = state.nav;
  const rows = await api('/api/queue');
  const counts = Object.fromEntries(QUEUE_FILTERS.map(([id, , fn]) => [id, rows.filter(fn).length]));
  const html = `
    ${pageHead('Fare desk', 'Live RFQ queue', `${rows.length} open requests · sorted by priority, then waiting time`, liveChip())}
    <div class="toolbar">
      <div class="search">${icon('search')}<input id="qSearch" placeholder="Search RFQ, agency, agent, route…" value="${esc(state.queueSearch)}"></div>
      <div class="filters">${QUEUE_FILTERS.map(([id, label]) => `<button class="filter ${state.queueFilter === id ? 'active' : ''}" data-filter="${id}">${label}<span class="cnt">${counts[id]}</span></button>`).join('')}</div>
    </div>
    <div class="card table-card"><div class="table-wrap"><table class="queue-table">
      <thead><tr><th>RFQ</th><th>Client</th><th>Route</th><th>Travel</th><th>Priority</th><th>Current status</th><th>Assigned to</th><th>SLA</th></tr></thead>
      <tbody id="qBody"></tbody></table></div></div>`;
  if (!paint(nav, html)) return;
  const body = document.getElementById('qBody');
  const draw = () => {
    const filter = (QUEUE_FILTERS.find(([id]) => id === state.queueFilter) || QUEUE_FILTERS[0])[2];
    const term = state.queueSearch.trim().toLowerCase();
    const list = rows.filter(filter).filter((r) => !term || [r.rfq_number, r.agency, r.agent, r.origin_iata, r.destination_iata, r.status].join(' ').toLowerCase().includes(term));
    body.innerHTML = list.map((r) => `
      <tr class="clickable queue-row ${r.sla === 'BREACHED' ? 'sla-breached' : ''}" data-rfq="${esc(r.rfq_number)}">
        <td><div class="id-cell">${channelIcon(r.source_channel)}<span class="rfq-id">${esc(r.rfq_number)}</span>${r.requires_human ? `<span class="flag" title="Needs human review">${icon('flag')}</span>` : ''}</div></td>
        <td><div class="person"><span class="avatar">${esc(initials(r.agent || r.agency))}</span><span class="who"><div>${esc(r.agent || 'Unknown contact')}</div><div class="muted">${esc(r.agency || 'Unknown agency')}</div></span></div></td>
        <td>${r.origin_iata ? `<span class="route">${esc(r.origin_iata)} ${icon('arrow')} ${esc(r.destination_iata || '?')}</span>` : '<span class="muted">—</span>'}</td>
        <td class="nowrap">${fmtDay(r.departure_date)}${r.return_date ? ` → ${fmtDay(r.return_date)}` : ''}<div class="muted small">${esc(cabinLabel(r.cabin))} · ${r.pax || '—'} pax</div></td>
        <td>${prioBadge(r.priority_level)}</td><td>${statusTag(r.status, r.status_label)}</td>
        <td class="nowrap">${esc(r.desk || '—')}${r.operator ? `<div class="muted small">${esc(r.operator)}</div>` : ''}</td>
        <td class="nowrap">${r.sla === 'N/A' ? '<span class="muted small">With client</span>' : badge(r.sla === 'OK' ? 'On time' : r.sla === 'AT_RISK' ? 'At risk' : 'Breached', r.sla)}<div class="muted small">${waiting(r.waiting_seconds)}${r.open_alerts ? ` · ${r.open_alerts} alert${r.open_alerts === 1 ? '' : 's'}` : ''}</div></td>
      </tr>`).join('') || `<tr><td colspan="8">${emptyState('list', 'No request matches', 'Try another filter or search term.')}</td></tr>`;
    body.querySelectorAll('tr[data-rfq]').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/rfq/${tr.dataset.rfq}`; }));
  };
  draw();
  document.getElementById('qSearch').addEventListener('input', (e) => { state.queueSearch = e.target.value; draw(); });
  $view.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    state.queueFilter = b.dataset.filter;
    $view.querySelectorAll('[data-filter]').forEach((x) => x.classList.toggle('active', x === b));
    draw();
  }));
}

// ---------------------------------------------------------------------------
// RFQ detail
// ---------------------------------------------------------------------------
function requirementsCard(r) {
  const req = r.requirements || {};
  const pax = req.passengers || {};
  const missing = (r.missing_fields || []).length ? r.missing_fields.map((m) => badge(human(m), 'warn')).join(' ') : badge('Complete', 'ok');
  const passengerText = `${pax.adults ?? '—'} adult${pax.adults === 1 ? '' : 's'}${pax.children ? ` · ${pax.children} child${pax.children === 1 ? '' : 'ren'}` : ''}${pax.infants ? ` · ${pax.infants} infant${pax.infants === 1 ? '' : 's'}` : ''}`;
  return `<section class="card" id="travel-requirements"><header><div><div class="card-kicker">Request</div><h2>Travel requirements</h2></div>${missing}</header>
    <div class="trip-summary">
      <div class="trip-route"><span>${esc(r.origin_iata || '?')}</span>${icon('arrow')}<span>${esc(r.destination_iata || '?')}</span></div>
      <div class="trip-facts"><strong>${fmtDay(req.departure_date || r.departure_date)} → ${fmtDay(req.return_date || r.return_date)}</strong><span>${esc(passengerText)} · ${esc(cabinLabel(r.cabin))}</span><span>${(req.preferred_airlines || []).map(esc).join(', ') || 'No airline preference'}</span></div>
    </div>
    <details class="inline-disclosure"><summary>View details</summary><dl class="kv">
      <dt>Intent</dt><dd>${esc(human(r.intent))}${r.classification ? ` <span class="muted small">· confidence ${esc(r.classification.confidence)}</span>` : ''}</dd>
      <dt>Route</dt><dd><span class="route">${esc(r.origin_iata || '?')} ${icon('arrow')} ${esc(r.destination_iata || '?')}</span> <span class="muted small">${esc(human(r.trip_type || ''))}</span></dd>
      <dt>Departure</dt><dd>${fmtDay(req.departure_date || r.departure_date)}${req.date_flexibility_days ? ` <span class="muted">±${req.date_flexibility_days} d</span>` : ''}</dd>
      <dt>Return</dt><dd>${fmtDay(req.return_date || r.return_date)}</dd>
      <dt>Passengers</dt><dd>${pax.adults ?? '—'} adult(s)${pax.children ? `, ${pax.children} child(ren)` : ''}${pax.infants ? `, ${pax.infants} infant(s)` : ''}</dd>
      <dt>Cabin</dt><dd>${esc(cabinLabel(r.cabin))}</dd>
      <dt>Airlines</dt><dd>${(req.preferred_airlines || []).map(esc).join(', ') || '—'}${(req.excluded_airlines || []).length ? ` <span class="muted">· not ${req.excluded_airlines.map(esc).join(', ')}</span>` : ''}</dd>
      <dt>Urgency</dt><dd>${esc(human(req.urgency || '—'))}</dd>
      <dt>Missing</dt><dd>${missing}</dd>
      ${(req.ambiguities || []).length ? `<dt>Ambiguities</dt><dd class="small">${req.ambiguities.map(esc).join('<br>')}</dd>` : ''}
      ${r.booking_reference ? `<dt>Booking ref</dt><dd class="mono">${esc(r.booking_reference)}</dd>` : ''}
    </dl></details></section>`;
}

function afterSalesCard(r) {
  const req = r.requirements || {};
  const original = req.original || {};
  if (!r.after_sales_type) return '';
  const requested = req.requested_changes || {};
  const option = original.selected_option || {};
  const adults = original.adults ?? (original.requirements && original.requirements.passengers && original.requirements.passengers.adults);
  const isRefund = r.status === 'REFUND_REQUESTED' || r.after_sales_type === 'REFUND';
  const parentNumber = req.parent_rfq_number || original.parent_rfq_number || '';
  return `<section class="card focus-card after-sales-card" id="after-sales"><header><div><div class="card-kicker">Action required</div><h2>${isRefund ? 'Refund context' : 'After-sales context'}</h2></div>${req.clarification_required ? badge('Clarification required', 'warn') : badge('Human review', 'ai')}</header>
    <div class="context-compare">
      <div class="context-panel"><span class="context-label">Original</span><strong class="route">${esc(original.origin_iata || '?')} ${icon('arrow')} ${esc(original.destination_iata || '?')}</strong><span>${fmtDay(original.departure_date)} → ${fmtDay(original.return_date)}</span><span>${option.code ? `${esc(option.code)} · ${esc(option.airline || 'Airline unavailable')}` : 'Selected option unavailable'}</span><span>${r.booking_reference || original.booking_reference ? `PNR ${esc(r.booking_reference || original.booking_reference)}` : 'PNR unavailable'}</span></div>
      <div class="context-panel requested"><span class="context-label">Requested</span><strong>${isRefund ? 'Refund / cancellation review' : 'Travel date change'}</strong><span>Departure → ${requested.departure_date ? fmtDay(requested.departure_date) : 'unchanged'}</span><span>Return → ${requested.return_date ? fmtDay(requested.return_date) : 'unchanged'}</span><span>${req.clarification_required ? 'Clarification is required before processing' : 'Ready for operator review'}</span></div>
    </div>
    <div class="client-message"><span>Client message</span><p>${esc(req.client_message || req.summary || '—')}</p></div>
    <div class="context-footer"><span>Desk <strong>${esc(r.desk_name || r.assigned_team || '—')}</strong></span>${parentNumber ? `<a href="#/rfq/${encodeURIComponent(parentNumber)}">Parent ${esc(parentNumber)}</a>` : '<span class="warn-text">Parent booking context unavailable</span>'}<button class="btn" data-op="RESOLVE_AFTER_SALES">Mark handled</button></div>
  </section>`;
}

function fareDeskCard(d) {
  const r = d.rfq;
  const active = d.options.filter((o) => o.is_active);
  const canEnter = ['ASSIGNED', 'SEARCHING', 'FARES_FOUND', 'PENDING_APPROVAL'].includes(r.status);
  const expanded = disclosureOpen(r.rfq_number, 'fare-desk', UI.fareDeskExpanded(r.status));
  const list = active.map((o) => {
    const expired = new Date(o.fare_valid_until) < new Date();
    return `
    <div class="option-card ${r.selected_option_code === o.option_code ? 'selected' : ''}">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><strong>${esc(o.option_code)} · ${esc(o.airline)}</strong>
        <span class="price">${esc(o.fare_currency)} ${Number(o.fare_amount).toLocaleString('en-US')}</span></div>
      <div class="small muted">${(o.flight_segments || []).map((s) => `${esc(s.flight_no)} ${esc(s.from)}→${esc(s.to)}`).join(' · ')}</div>
      <div class="small">Bag ${esc(o.baggage)} · Change ${esc(o.change_penalty)} · Refund ${esc(o.refund_penalty)}</div>
      <div class="small ${expired ? 'muted' : ''}">Valid until ${fmtTime(o.fare_valid_until)} ${expired ? badge('Expired', 'crit') : ''} · ${esc(o.source)}</div>
    </div>`;
  }).join('');
  return `<details class="card disclosure-card" id="fare-desk" data-disclosure="fare-desk" data-rfq="${esc(r.rfq_number)}" data-closed-label="View" ${expanded ? 'open' : ''}><summary><span><span class="card-kicker">Sourcing</span><strong>Fare desk</strong></span><span class="summary-meta">${active.length} option${active.length === 1 ? '' : 's'} <span class="toggle-label">${expanded ? 'Hide' : 'View'}</span></span></summary>
    <div class="disclosure-body">
    <div class="section-tools">${state.config && state.config.demo_mode && canEnter ? `${badge('Demo tool', 'warn')}<button class="btn sm" id="loadMock">Load sample fares</button>` : ''}</div>
    ${list ? `<div class="grid compact-grid">${list}</div>` : '<div class="muted small">No fare options yet.</div>'}
    ${canEnter ? `
      <form id="fareForm" class="grid fare-form">
        <div class="notice small">Fares only enter the system here (or from a future GDS adapter). The AI never creates or edits a price.</div>
        <label>Fare options (JSON array, validated server-side)<textarea id="fareJson" style="min-height:180px" placeholder='[{"airline":"Qatar Airways", ...}]'></textarea></label>
        <div class="form-grid"><label>Entered by<input id="fareBy" value="${esc(state.operator)}"></label></div>
        <div class="actions"><button class="btn primary" type="submit">Submit fares &amp; generate quote</button></div>
      </form>` : ''}
    </div></details>`;
}

function approvalCard(d) {
  const q = d.quotes[0];
  if (!q) return '';
  const pending = q.status === 'PENDING_APPROVAL' && d.rfq.status === 'PENDING_APPROVAL';
  const v = q.validation || {};
  const notes = [];
  if (q.generated_by === 'TEMPLATE' && v.ai_error) notes.push(`AI formatting unavailable (${v.ai_error}) – deterministic template used.`);
  if (v.fallback_to_template) notes.push(`AI text rejected by the number check: ${(v.errors || []).slice(0, 3).join('; ')} – template used.`);
  if ((v.warnings || []).length) notes.push(`Edited text differs from fare data: ${v.warnings.slice(0, 3).join('; ')}`);
  const optionCount = d.options.filter((o) => o.is_active).length;
  const expanded = disclosureOpen(d.rfq.rfq_number, 'quote', UI.quoteExpanded(d.rfq.status, q.status));
  return `<details class="card disclosure-card quote-card" id="quote" data-disclosure="quote" data-rfq="${esc(d.rfq.rfq_number)}" data-closed-label="View quote" ${expanded ? 'open' : ''}><summary><span><span class="card-kicker">Commercial</span><strong>Quote v${q.version}</strong></span><span class="summary-meta">${badge(human(q.status), q.status === 'SENT' || q.status === 'APPROVED' ? 'ok' : q.status === 'REJECTED' ? 'crit' : 'warn')}<span>${optionCount} fare option${optionCount === 1 ? '' : 's'}</span>${q.approved_by ? `<span>Approved by ${esc(q.approved_by)}</span>` : ''}${q.sent_at ? `<span>${fmtTime(q.sent_at)}</span>` : ''}<span class="toggle-label">${expanded ? 'Hide' : 'View quote'}</span></span></summary>
    <div class="disclosure-body">
    <div class="section-tools">${badge(q.generated_by === 'AI' ? `AI · ${q.ai_model || ''}` : human(q.generated_by), q.generated_by === 'AI' ? 'ai' : 'plain')}</div>
    ${notes.map((n) => `<div class="notice warn small" style="margin-bottom:8px">${esc(n)}</div>`).join('')}
    <div class="tabs-inline"><button data-qt="email" class="${state.quoteTab === 'email' ? 'active' : ''}">Email</button><button data-qt="whatsapp" class="${state.quoteTab === 'whatsapp' ? 'active' : ''}">WhatsApp</button></div>
    ${pending ? `
      <label>Subject<input id="qSubject" value="${esc(q.email_subject)}"></label>
      <textarea id="qEmail" style="min-height:300px;margin-top:10px;${state.quoteTab === 'email' ? '' : 'display:none'}">${esc(q.email_body)}</textarea>
      <textarea id="qWa" style="min-height:300px;margin-top:10px;${state.quoteTab === 'whatsapp' ? '' : 'display:none'}">${esc(q.whatsapp_body)}</textarea>
      <div class="form-grid" style="margin-top:10px"><label>Reviewer<input id="qReviewer" value="${esc(state.operator)}"></label><label>Note<input id="qNote" placeholder="optional"></label></div>
      <div class="actions" style="margin-top:12px">
        <button class="btn ok" data-decision="APPROVE">Approve &amp; send</button>
        <button class="btn" data-decision="EDIT">Save edit (new version)</button>
        <button class="btn danger" data-decision="REJECT">Reject</button>
      </div>
      <div class="muted small" style="margin-top:8px">Valid until ${fmtTime(q.valid_until)} · content hash <span class="mono">${esc(String(q.content_hash).slice(0, 12))}…</span></div>`
    : `<div class="small muted">Subject: ${esc(q.email_subject)}</div><pre class="quote">${esc(state.quoteTab === 'email' ? q.email_body : q.whatsapp_body)}</pre>
       <div class="muted small" style="margin-top:8px">${q.approved_by ? `Approved by ${esc(q.approved_by)} · ${fmtTime(q.approved_at)}` : ''}${q.sent_at ? ` · sent ${fmtTime(q.sent_at)} via ${esc(q.delivery_channel)}` : ''}</div>`}
    </div></details>`;
}

function handoffCard(h, r) {
  const o = typeof h.selected_option === 'string' ? { code: h.selected_option } : (h.selected_option || {});
  const p = h.passengers || {};
  const segs = (o.segments || []).map((x) => `<div class="seg">${esc(x.direction === 'INBOUND' ? '↩' : '→')} ${esc(x.flight_no)} ${esc(x.from)}→${esc(x.to)} · ${esc(String(x.depart_at || '').replace('T', ' '))}</div>`).join('');
  return `<section class="card handoff focus-card" id="booking-handoff"><header><div><div class="card-kicker">Ticketing</div><h2>${r.status === 'TICKETED' ? 'Booking summary' : 'Booking handoff'}</h2></div>${statusTag(r.status, r.status_label)}</header>
    ${h.requires_fare_recheck ? '<div class="notice crit small" style="margin-bottom:8px">Fare validity passed – revalidate before ticketing.</div>' : ''}
    <dl class="kv">${[
      ['RFQ', h.rfq_number ? `<span class="mono">${esc(h.rfq_number)}</span>` : ''],
      ['Agency / agent', h.agency || h.contact ? `${esc(h.agency || '—')} · ${esc(h.contact || '—')}` : ''],
      ['Contact', h.contact_email || h.contact_whatsapp ? `<span class="small">${esc(h.contact_email || '')} ${h.contact_whatsapp ? `· +${esc(h.contact_whatsapp)}` : ''}</span>` : ''],
      ['Passengers', p.adults ? `${esc(p.adults)} ADT${p.children ? ` · ${esc(p.children)} CHD` : ''}${p.infants ? ` · ${esc(p.infants)} INF` : ''}` : ''],
      ['Selected option', o.code ? `<strong>${esc(o.code)}${o.airline ? ` · ${esc(o.airline)}` : ''}</strong> ${o.fare_amount ? `· ${esc(o.fare_currency)} ${Number(o.fare_amount).toLocaleString('en-US')} ${o.fare_basis === 'TOTAL' ? 'total' : 'per pax'}` : ''}` : ''],
      ['Flights', segs],
      ['Travel dates', h.travel_dates ? `${fmtDay(h.travel_dates.departure)} → ${fmtDay(h.travel_dates.return)}` : ''],
      ['Conditions', o.baggage ? `<span class="small">Bag ${esc(o.baggage)} · Change ${esc(o.change_penalty)} · Refund ${esc(o.refund_penalty)}</span>` : ''],
      ['PNR', r.booking_reference ? `<strong class="mono">${esc(r.booking_reference)}</strong>` : (r.status === 'TICKETED' ? '<span class="warn-text">Not recorded</span>' : '<span class="muted">Pending ticketing</span>')],
      ['Agent note', h.notes ? `<span class="small">${esc(h.notes)}</span>` : ''],
    ].filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}
    </dl>
    <details class="inline-disclosure"><summary>Raw handoff payload</summary><pre class="quote">${esc(JSON.stringify(h, null, 2))}</pre></details></section>`;
}

function operatorActions(r) {
  const operational = {
    ASSIGNED: [['START_SEARCH', 'Start fare search']],
    BOOKING_REQUESTED: [['START_TICKETING', 'Start ticketing']],
    TICKETING: [['MARK_TICKETED', 'Mark ticketed (PNR)']],
    CHANGE_REQUESTED: [['RESOLVE_AFTER_SALES', 'Change handled']],
    REFUND_REQUESTED: [['RESOLVE_AFTER_SALES', 'Refund handled → close']],
    APPROVED: [['RESEND_QUOTE', 'Retry quote delivery']],
    LOST: [['REOPEN', 'Reopen']],
  }[r.status] || [];
  const common = ['CLOSED', 'CANCELLED', 'LOST', 'TICKETED'].includes(r.status) ? [] : [['MARK_LOST', 'Mark lost'], ['CANCEL', 'Cancel']];
  const flag = r.requires_human ? [['CLEAR_HUMAN_FLAG', 'Clear review flag']] : [];
  const primary = UI.presentationFor(r.status).primary;
  const primaryHtml = primary.kind === 'operation'
    ? `<button class="btn primary primary-action" data-op="${esc(primary.action)}">${esc(primary.label)}</button>`
    : `<button class="btn primary primary-action" data-jump="${esc(primary.target)}">${esc(primary.label)}</button>`;
  const secondary = operational.concat(flag, common).filter(([action]) => action !== primary.action && !(action === 'RESOLVE_AFTER_SALES' && ['CHANGE_REQUESTED', 'REFUND_REQUESTED'].includes(r.status)));
  const more = secondary.length ? `<details class="action-menu"><summary class="btn">More actions ···</summary><div class="action-popover">${secondary.map(([action, label]) => `<button class="btn ${['MARK_LOST', 'CANCEL'].includes(action) ? 'danger' : ''}" data-op="${action}">${label}</button>`).join('')}</div></details>` : '';
  return `${primaryHtml}${more}`;
}

function replyCard(r) {
  if (!state.config || !state.config.demo_mode) return '';
  const expanded = disclosureOpen(r.rfq_number, 'demo-tools');
  return `<details class="card disclosure-card demo-tools" data-disclosure="demo-tools" data-rfq="${esc(r.rfq_number)}" data-closed-label="Open" ${expanded ? 'open' : ''}><summary><span><span class="card-kicker">Non-operational</span><strong>Developer / Demo tools</strong></span><span class="summary-meta">${badge('Demo only', 'warn')}<span class="toggle-label">${expanded ? 'Hide' : 'Open'}</span></span></summary><div class="disclosure-body"><div class="small muted demo-note">Simulate an agent reply · ${esc(r.conversation_channel || r.source_channel)} · same thread</div>
    <form id="replyForm" class="grid">
      <div class="actions">${['Option 2 works. Please proceed.', 'second one', 'go ahead', 'please hold', 'Too expensive. Anything cheaper?', 'can you check Emirates?', 'change dates to 18th', 'STOP'].map((t) => `<button type="button" class="btn sm" data-reply="${esc(t)}">${esc(t)}</button>`).join('')}</div>
      <label>Message<input id="replyText" placeholder="Type a reply from ${esc(r.first_name || 'the agent')}"></label>
      <div class="actions"><button class="btn primary" type="submit">Send as ${esc(r.first_name || 'agent')}</button></div>
    </form></div></details>`;
}

function messageHtml(m) {
  return `<div class="msg ${m.direction}"><div class="meta">${badge(m.direction === 'INBOUND' ? 'Agent' : human(m.kind || 'outbound'), m.direction === 'INBOUND' ? 'ai' : 'info')} ${badge(m.channel, 'plain')} ${m.delivery_status ? badge(human(m.delivery_status), m.delivery_status) : ''} ${(m.security_flags || []).length ? badge('Injection signals', 'crit') : ''}<span>${fmtTime(m.at)}</span>${m.classification ? `<span>→ ${esc(human(m.classification.intent))} (${esc(m.classification.confidence)})</span>` : ''}</div>
    ${m.subject ? `<div class="small msg-subject"><strong>${esc(m.subject)}</strong></div>` : ''}<pre>${esc(m.content)}</pre></div>`;
}

function conversationCard(messages, rfqNumber) {
  const all = messages || [];
  const preview = all.slice(-2);
  const content = (rows) => rows.map(messageHtml).join('') || '<div class="muted">No messages</div>';
  const expanded = disclosureOpen(rfqNumber, 'conversation-all');
  return `<section class="card" id="conversation"><header><div><div class="card-kicker">Client contact</div><h2>Conversation</h2></div><span class="sub">${all.length} message${all.length === 1 ? '' : 's'}</span></header>
    ${all.length > 2 ? `<details class="inline-disclosure conversation-toggle" data-disclosure="conversation-all" data-rfq="${esc(rfqNumber)}" ${expanded ? 'open' : ''}><summary>${expanded ? 'Hide full conversation' : `View all ${all.length} messages`}</summary><div class="conversation-all">${content(all)}</div></details>` : ''}
    <div class="conversation-preview">${content(preview)}</div>
  </section>`;
}

function tasksCard(alerts) {
  if (!alerts.length) return '';
  const open = alerts.filter((a) => a.status !== 'RESOLVED');
  const resolved = alerts.filter((a) => a.status === 'RESOLVED');
  const row = (a) => `<div class="task-row"><span class="task-icon ${esc(a.severity)}">${icon(a.alert_type === 'SLA_BREACH' ? 'clock' : 'alert')}</span><span><strong>${esc(a.title)}</strong><small>${esc(human(a.alert_type))} · ${ago(a.created_at)}</small></span></div>`;
  return `<section class="card tasks-card"><header><h2>Tasks &amp; alerts</h2>${badge(`${open.length} open`, open.length ? 'warn' : 'ok')}</header>
    ${open.map(row).join('') || '<div class="muted small">No open tasks.</div>'}
    ${resolved.length ? `<details class="inline-disclosure"><summary>View history · ${resolved.length} resolved</summary><div class="task-history">${resolved.map(row).join('')}</div></details>` : ''}
  </section>`;
}

function auditCard(audit, rfqNumber) {
  const expanded = disclosureOpen(rfqNumber, 'activity-audit');
  return `<details class="card disclosure-card audit-card" id="activity-audit" data-disclosure="activity-audit" data-rfq="${esc(rfqNumber)}" data-closed-label="Expand" ${expanded ? 'open' : ''}><summary><span><span class="card-kicker">History</span><strong>Activity &amp; audit</strong></span><span class="summary-meta">${audit.length} events <span class="toggle-label">${expanded ? 'Hide' : 'Expand'}</span></span></summary><div class="disclosure-body">
    <ul class="timeline">${audit.map((a) => `<li><span class="muted">${new Date(a.created_at).toLocaleTimeString('en-GB')}</span><span><strong>${esc(human(a.action))}</strong></span><span class="small muted">${esc(human(a.actor_type))}${a.actor_id ? ` · ${esc(a.actor_id)}` : ''}${a.metadata && a.metadata.to ? ` · ${esc(human(a.metadata.from))} → ${esc(human(a.metadata.to))}` : ''}${a.metadata && a.metadata.score !== undefined ? ` · score ${esc(a.metadata.score)} ${esc(a.metadata.level)}` : ''}</span></li>`).join('')}</ul>
  </div></details>`;
}

function journeyCard(journey, rfqNumber) {
  const done = journey.filter((j) => j.done).length;
  const current = [...journey].reverse().find((j) => j.done);
  const percent = journey.length ? Math.round((done / journey.length) * 100) : 0;
  const expanded = disclosureOpen(rfqNumber, 'request-journey');
  return `<details class="card disclosure-card journey-card" id="request-journey" data-disclosure="request-journey" data-rfq="${esc(rfqNumber)}" data-closed-label="View journey" ${expanded ? 'open' : ''}><summary><span><span class="card-kicker">Progress</span><strong>Request journey</strong></span><span class="journey-summary"><span>${done} / ${journey.length} steps · ${esc(current ? human(current.label) : 'Not started')}</span><span class="progress-track"><span style="width:${percent}%"></span></span><span class="toggle-label">${expanded ? 'Hide' : 'View journey'}</span></span></summary><div class="disclosure-body"><div class="journey">${journey.map((j) => `<span class="step ${j.done ? 'done' : ''}" title="${j.at ? fmtTime(j.at) : 'pending'}"><span class="dot"></span>${esc(j.label)}</span>`).join('')}</div></div></details>`;
}

async function renderRfq(number) {
  const nav = state.nav;
  const d = await api(`/api/rfq/${encodeURIComponent(number)}`);
  const r = d.rfq;
  const s = d.sla;
  const who = [r.first_name, r.last_name].filter(Boolean).join(' ') || r.contact_email || '';
  const req = r.requirements || {};
  const pax = req.passengers || {};
  const paxTotal = Number(r.adults ?? pax.adults ?? 0) + Number(r.children ?? pax.children ?? 0) + Number(r.infants ?? pax.infants ?? 0);
  const policy = UI.presentationFor(r.status);
  const cards = {
    requirements: requirementsCard(r),
    afterSales: afterSalesCard(r),
    booking: r.handoff ? handoffCard(r.handoff, r) : '',
    quote: approvalCard(d),
    fare: fareDeskCard(d),
    conversation: conversationCard(d.messages, r.rfq_number),
  };
  const primaryCards = policy.focus.map((key) => cards[key]).filter(Boolean);
  const secondaryCards = ['requirements', 'afterSales', 'booking', 'quote', 'fare', 'conversation'].filter((key) => !policy.focus.includes(key)).map((key) => cards[key]).filter(Boolean);
  const warningTarget = policy.focus[0] === 'afterSales' ? 'after-sales' : 'travel-requirements';
  const ok = paint(nav, `
    <a href="#/queue" class="back">${icon('back')} Back to queue</a>
    <section class="detail-head compact-head">
      <div class="head-main">
        <div class="head-status"><span class="mono rfq-title">${esc(r.rfq_number)}</span>${statusTag(r.status, r.status_label)}${prioBadge(r.priority_level)}${s.tracked ? badge(s.breached ? 'SLA breached' : 'On time', s.breached ? 'BREACHED' : 'OK') : ''}</div>
        <div class="client-line"><strong>${esc(who || 'Unknown contact')}</strong><span>${esc(r.agency_name || 'Unknown agency')} · ${esc(human(r.source_channel))}</span></div>
        <div class="trip-line"><span class="route">${esc(r.origin_iata || '?')} ${icon('arrow')} ${esc(r.destination_iata || '?')}</span><span>${fmtDay(req.departure_date || r.departure_date)} → ${fmtDay(req.return_date || r.return_date)}</span><span>${paxTotal || '—'} pax</span><span>${esc(cabinLabel(r.cabin))}</span></div>
        <div class="meta-line"><span>${esc(r.desk_name || 'Unassigned')}${r.operator_name ? ` · ${esc(r.operator_name)}` : ''}</span><span>Created ${fmtTime(r.created_at)}</span>${s.tracked ? `<span>${esc(`${duration(s.minutes_in_status).value} ${duration(s.minutes_in_status).unit}`)} in status · ${esc(s.threshold_minutes)} min SLA</span>` : '<span>SLA paused · with client</span>'}</div>
      </div>
      <div class="head-actions">${operatorActions(r)}</div>
    </section>
    <div class="warning-stack">
      ${r.verification_status === 'UNVERIFIED' ? `<div class="warning-compact">${icon('alert')}<span><strong>Unverified sender</strong><small>Verify the agency before quoting</small></span><button class="btn sm" data-jump="travel-requirements">Review</button></div>` : ''}
      ${r.human_review_reason ? `<div class="warning-compact">${icon('flag')}<span><strong>Human review required</strong><small>${esc(r.human_review_reason)}</small></span><button class="btn sm" data-jump="${warningTarget}">Review</button></div>` : ''}
      ${r.requires_fare_recheck ? `<div class="warning-compact critical">${icon('alert')}<span><strong>Fare recheck required</strong><small>Revalidate price and availability before ticketing.</small></span><button class="btn sm" data-jump="booking-handoff">Review</button></div>` : ''}
      ${(r.security_flags || []).length ? `<div class="warning-compact critical">${icon('shield')}<span><strong>Security flag</strong><small>Review the inbound message before continuing.</small></span><button class="btn sm" data-jump="conversation">Review</button></div>` : ''}
    </div>
    ${journeyCard(d.journey, r.rfq_number)}
    <div class="rfq-workspace">
      <div class="grid primary-column">
        ${primaryCards.join('') || requirementsCard(r)}
      </div>
      <div class="grid secondary-column">
        ${tasksCard(d.alerts)}
        ${secondaryCards.join('')}
        ${replyCard(r)}
        ${auditCard(d.audit, r.rfq_number)}
      </div>
    </div>`);
  if (ok) wireRfq(d);
}

function wireRfq(d) {
  const r = d.rfq;
  const reload = () => renderRfq(r.rfq_number).catch((e) => toast(e.message));
  document.querySelectorAll('[data-disclosure]').forEach((details) => {
    details.addEventListener('toggle', () => {
      state.disclosures[disclosureKey(details.dataset.rfq, details.dataset.disclosure)] = details.open;
      const label = details.querySelector(':scope > summary .toggle-label');
      if (label) label.textContent = details.open ? 'Hide' : (details.dataset.closedLabel || 'View');
      if (details.classList.contains('conversation-toggle')) {
        details.querySelector(':scope > summary').textContent = details.open ? 'Hide full conversation' : `View all ${d.messages.length} messages`;
      }
    });
  });
  document.querySelectorAll('[data-jump]').forEach((button) => {
    button.addEventListener('click', () => {
      const target = document.getElementById(button.dataset.jump);
      if (!target) return;
      if (target.tagName === 'DETAILS') target.open = true;
      const parentDisclosure = target.closest('details.disclosure-card');
      if (parentDisclosure) parentDisclosure.open = true;
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  const mock = document.getElementById('loadMock');
  if (mock) mock.onclick = async () => {
    const res = await post('/api/fare-desk/mock', { rfq_number: r.rfq_number });
    document.getElementById('fareJson').value = JSON.stringify(res.options, null, 2);
    toast('Sample fares loaded (MockFareProvider – demo data). Review, then submit.');
  };
  const form = document.getElementById('fareForm');
  if (form) form.onsubmit = async (ev) => {
    ev.preventDefault();
    let options;
    try { options = JSON.parse(document.getElementById('fareJson').value || '[]'); } catch (e) { return toast('Invalid JSON'); }
    state.operator = document.getElementById('fareBy').value;
    localStorage.setItem('of_operator', state.operator);
    try {
      const res = await post('/api/fare-desk/options', { rfq_number: r.rfq_number, entered_by: state.operator, options });
      toast(`Fares saved – quote v${res.quote.version} ${res.quote.generated_by === 'AI' ? 'formatted by AI' : 'generated'} → ${res.quote.rfq_status}`);
    } catch (e) {
      toast(`Rejected: ${(e.body && e.body.errors) ? e.body.errors.join('\n') : e.message}`, 8000);
    }
    reload();
  };
  document.querySelectorAll('[data-qt]').forEach((b) => b.onclick = () => {
    state.quoteTab = b.dataset.qt;
    const email = document.getElementById('qEmail');
    if (email) {
      email.style.display = state.quoteTab === 'email' ? '' : 'none';
      document.getElementById('qWa').style.display = state.quoteTab === 'whatsapp' ? '' : 'none';
      document.querySelectorAll('[data-qt]').forEach((x) => x.classList.toggle('active', x === b));
    } else reload();
  });
  document.querySelectorAll('[data-decision]').forEach((b) => b.onclick = async () => {
    const q = d.quotes[0];
    const action = b.dataset.decision;
    const reviewer = document.getElementById('qReviewer').value;
    state.operator = reviewer;
    localStorage.setItem('of_operator', reviewer);
    const payload = { quote_id: q.id, action, reviewer, note: document.getElementById('qNote').value || null };
    if (action === 'EDIT') payload.edited = { email_subject: document.getElementById('qSubject').value, email_body: document.getElementById('qEmail').value, whatsapp_body: document.getElementById('qWa').value };
    if (action === 'REJECT' && !confirm('Reject this quote? Nothing will be sent and the RFQ returns to the fare desk.')) return;
    b.disabled = true;
    try {
      const res = await post('/api/quote/decision', payload).catch(async (e) => {
        if (e.body && e.body.error === 'EDIT_WARNINGS_NOT_ACKNOWLEDGED' && confirm(`The edited text differs from the fare data:\n\n${e.body.warnings.join('\n')}\n\nApprove anyway?`)) {
          return post('/api/quote/decision', Object.assign(payload, { acknowledge_warnings: true }));
        }
        throw e;
      });
      toast(action === 'APPROVE' ? `Approved – ${res.delivery ? `${res.delivery.delivery_status} via ${res.delivery.channel}` : 'sent'}` : action === 'EDIT' ? `Saved as v${res.version}${res.warnings && res.warnings.length ? ' (with warnings)' : ''}` : 'Rejected – back to fare desk');
    } catch (e) { toast(`Refused: ${e.message}`, 6000); }
    reload();
  });
  document.querySelectorAll('[data-op]').forEach((b) => b.onclick = async () => {
    const action = b.dataset.op;
    const payload = { action, rfq_number: r.rfq_number, operator: state.operator };
    if (action === 'MARK_TICKETED') {
      payload.booking_reference = (prompt('Booking reference (6 characters, e.g. ABC123):') || '').toUpperCase();
      if (!payload.booking_reference) return;
    }
    if (['MARK_LOST', 'CANCEL'].includes(action) && !confirm(`${action.replace('_', ' ')} ${r.rfq_number}?`)) return;
    try { const res = await post('/api/ops/action', payload); toast(`${action} → ${res.status || 'done'}`); } catch (e) { toast(`Refused: ${e.message}`, 6000); }
    reload();
  });
  const replyForm = document.getElementById('replyForm');
  if (replyForm) {
    const sendReply = async (text) => {
      if (!text) return;
      const channel = r.conversation_channel || r.source_channel;
      try {
        if (channel === 'whatsapp') await post('/api/demo/whatsapp', { from: r.contact_whatsapp, name: r.first_name, text });
        else await post('/api/demo/email', { from: `${r.first_name || ''} ${r.last_name || ''} <${r.contact_email}>`, subject: `Re: ${r.rfq_number}`, body: text, thread_id: r.conversation_thread });
        toast(`Reply sent: "${text}" – processing…`);
        setTimeout(reload, 2500);
        setTimeout(reload, 6000);
      } catch (e) { toast(e.message); }
    };
    replyForm.onsubmit = (ev) => { ev.preventDefault(); sendReply(document.getElementById('replyText').value); };
    replyForm.querySelectorAll('[data-reply]').forEach((b) => b.onclick = () => sendReply(b.dataset.reply));
  }
}

// ---------------------------------------------------------------------------
// Desk inbox
// ---------------------------------------------------------------------------
const ALERT_ICON = { SLA_BREACH: 'clock', DESK_NOTIFICATION: 'inbox', HUMAN_REVIEW: 'flag', RECHECK_FARE: 'alert', SECURITY: 'shield', WORKFLOW_ERROR: 'skull', DELIVERY_FAILED: 'send' };

async function renderAlerts() {
  const nav = state.nav;
  const rows = await api('/api/alerts');
  const types = Array.from(new Set(rows.map((a) => a.alert_type)));
  const sev = (k) => rows.filter((a) => a.severity === k).length;
  const html = `
    ${pageHead('Desk inbox', 'What each desk must do now', 'Desk notifications, human tasks, SLA breaches and security flags – resolved by an operator, never by the AI.',
      `<div class="actions">${badge(`${sev('CRITICAL')} critical`, 'crit')}${badge(`${sev('WARNING')} warning`, 'warn')}${badge(`${sev('INFO')} info`, 'info')}</div>`)}
    <div class="toolbar"><div class="filters">
      ${[['all', 'All']].concat(types.map((t) => [t, human(t)])).map(([id, label]) => `<button class="filter ${state.alertFilter === id ? 'active' : ''}" data-afilter="${esc(id)}">${esc(label)}<span class="cnt">${id === 'all' ? rows.length : rows.filter((a) => a.alert_type === id).length}</span></button>`).join('')}
    </div></div>
    <div class="card table-card"><div class="table-wrap"><table>
      <thead><tr><th>Severity</th><th>Task</th><th>Desk</th><th>RFQ</th><th>When</th><th></th></tr></thead><tbody id="aBody"></tbody></table></div></div>`;
  if (!paint(nav, html)) return;
  const draw = () => {
    const list = rows.filter((a) => state.alertFilter === 'all' || a.alert_type === state.alertFilter);
    document.getElementById('aBody').innerHTML = list.map((a) => `<tr>
      <td>${badge(human(a.severity), a.severity)}</td>
      <td><div class="person"><span class="ch">${icon(ALERT_ICON[a.alert_type] || 'inbox')}</span><span class="who"><div>${esc(a.title)}</div><div class="muted">${esc(human(a.alert_type))}${a.details && a.details.kb_suggestions && a.details.kb_suggestions.length ? ` · KB: ${a.details.kb_suggestions.map((k) => esc(k.title)).join(', ')}` : ''}</div></span></div></td>
      <td>${esc(a.desk || '—')}</td>
      <td>${a.rfq_number ? `<a class="rfq-id" href="#/rfq/${esc(a.rfq_number)}">${esc(a.rfq_number)}</a>` : '<span class="muted">—</span>'}</td>
      <td class="small muted">${ago(a.created_at)}</td>
      <td style="text-align:right"><button class="btn sm" data-resolve="${a.id}">Resolve</button></td></tr>`).join('')
      || `<tr><td colspan="6">${emptyState('check', 'Inbox zero', 'Nothing needs an operator right now.')}</td></tr>`;
    $view.querySelectorAll('[data-resolve]').forEach((b) => b.onclick = async () => {
      await post('/api/ops/action', { action: 'RESOLVE_ALERT', alert_id: b.dataset.resolve, operator: state.operator }).catch((e) => toast(e.message));
      renderAlerts();
      refreshCounts();
    });
  };
  draw();
  $view.querySelectorAll('[data-afilter]').forEach((b) => b.onclick = () => {
    state.alertFilter = b.dataset.afilter;
    $view.querySelectorAll('[data-afilter]').forEach((x) => x.classList.toggle('active', x === b));
    draw();
  });
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------
async function renderOutbox() {
  const nav = state.nav;
  const rows = await api('/api/outbox');
  const html = `
    ${pageHead('Outbox', 'What the agents received', state.config.demo_mode ? 'Demo mode: deliveries are simulated and recorded – exactly what would be sent by email or WhatsApp.' : 'Messages delivered through Gmail and the WhatsApp Cloud API.')}
    ${rows.length ? `<div class="outbox">${rows.map((m, i) => `
      <div class="card mail">
        <div class="mail-head"><span class="ch">${icon(m.channel === 'whatsapp' ? 'chat' : 'mail')}</span>
          <div class="to"><div><strong>${esc(human(m.kind || 'message'))}</strong> · <span class="muted">to ${esc(m.recipient || '—')}</span></div>
            <div class="small muted">${fmtTime(m.sent_at)}${m.rfq_number ? ` · <a href="#/rfq/${esc(m.rfq_number)}">${esc(m.rfq_number)}</a>` : ''}</div></div>
          ${badge(human(m.delivery_status || 'n/a'), m.delivery_status)}</div>
        <div class="mail-body" id="mb-${i}">${m.subject ? `<div class="mail-subject">${esc(m.subject)}</div>` : ''}<pre class="quote">${esc(m.content)}</pre></div>
        ${String(m.content || '').length > 420 ? `<div class="mail-foot"><button class="btn sm" data-expand="${i}">Show full message</button></div>` : ''}
      </div>`).join('')}</div>` : `<div class="card">${emptyState('send', 'Nothing sent yet', 'Acknowledgements, clarifications and approved quotes will appear here.')}</div>`}`;
  if (!paint(nav, html)) return;
  $view.querySelectorAll('[data-expand]').forEach((b) => b.onclick = () => {
    const el = document.getElementById(`mb-${b.dataset.expand}`);
    el.classList.toggle('open');
    b.textContent = el.classList.contains('open') ? 'Collapse' : 'Show full message';
  });
}

// ---------------------------------------------------------------------------
// Activity & audit
// ---------------------------------------------------------------------------
const ACTOR_TONE = { AI: 'ai', HUMAN: 'ok', CLIENT: 'info', SYSTEM: 'plain' };

async function renderActivity() {
  const nav = state.nav;
  const [audit, events, dead] = await Promise.all([api('/api/audit'), api('/api/events'), api('/api/dead-letters')]);
  const auditRows = audit.map((a) => `<tr>
      <td class="small muted">${fmtTime(a.created_at)}</td>
      <td><strong>${esc(human(a.action))}</strong>${a.metadata && a.metadata.to ? `<div class="small muted">${esc(human(a.metadata.from))} → ${esc(human(a.metadata.to))}</div>` : ''}</td>
      <td>${badge(human(a.actor_type), ACTOR_TONE[a.actor_type] || 'plain')}${a.actor_id ? ` <span class="small muted">${esc(a.actor_id)}</span>` : ''}</td>
      <td>${a.rfq_number ? `<a class="rfq-id" href="#/rfq/${esc(a.rfq_number)}">${esc(a.rfq_number)}</a>` : '<span class="muted">—</span>'}</td></tr>`).join('');
  const eventRows = events.map((e) => `<tr><td class="small muted">${fmtTime(e.created_at)}</td><td class="mono">${esc(e.workflow)}</td><td>${esc(human(e.event))}</td>
      <td>${badge(e.status, e.status === 'OK' ? 'ok' : e.status === 'ERROR' ? 'crit' : 'warn')}</td>
      <td>${e.rfq_number ? `<a class="rfq-id" href="#/rfq/${esc(e.rfq_number)}">${esc(e.rfq_number)}</a>` : ''}</td><td class="num">${e.duration_ms ?? ''}</td></tr>`).join('');
  const html = `
    ${pageHead('Observability', 'Activity & audit trail', 'Every action is recorded: who (AI, system, human or client), what changed and when.')}
    ${dead.length ? `<div class="card" style="margin-bottom:16px"><header><h2>Failed / dead-letter messages</h2>${badge(`${dead.length}`, 'crit')}</header><div class="table-wrap"><table><thead><tr><th>When</th><th>Status</th><th>Sender</th><th>Message</th><th>Last error</th><th></th></tr></thead><tbody>
      ${dead.map((m) => `<tr><td class="small">${ago(m.created_at)}</td><td>${badge(m.processing_status)} <span class="muted small">×${m.retry_count}</span></td><td class="small">${esc(m.sender)}</td><td class="small">${esc(m.content)}</td><td class="small">${esc(m.processing_notes && m.processing_notes.last_error)}</td><td><button class="btn sm" data-retry="${m.id}">Retry</button></td></tr>`).join('')}</tbody></table></div></div>` : ''}
    <div class="toolbar"><div class="tabs-inline" style="margin:0">
      <button data-atab="audit" class="${state.activityTab === 'audit' ? 'active' : ''}">Business audit trail · ${audit.length}</button>
      <button data-atab="events" class="${state.activityTab === 'events' ? 'active' : ''}">Workflow events · ${events.length}</button>
    </div></div>
    <div class="card table-card"><div class="table-wrap">
      ${state.activityTab === 'audit'
        ? (audit.length ? `<table><thead><tr><th>When</th><th>Action</th><th>Actor</th><th>RFQ</th></tr></thead><tbody>${auditRows}</tbody></table>` : emptyState('activity', 'No audit entries yet', 'Actions appear here as soon as requests are processed.'))
        : (events.length ? `<table><thead><tr><th>When</th><th>Workflow</th><th>Event</th><th>Status</th><th>RFQ</th><th class="num">ms</th></tr></thead><tbody>${eventRows}</tbody></table>` : emptyState('activity', 'No workflow events yet', 'Structured events are written by the n8n workflows when they process messages – send a message from the Demo simulator.'))}
    </div></div>`;
  if (!paint(nav, html)) return;
  $view.querySelectorAll('[data-atab]').forEach((b) => b.onclick = () => { state.activityTab = b.dataset.atab; renderActivity(); });
  $view.querySelectorAll('[data-retry]').forEach((b) => b.onclick = async () => {
    await post('/api/ops/action', { action: 'RETRY_MESSAGE', message_id: b.dataset.retry, operator: state.operator }).catch((e) => toast(e.message));
    toast('Message re-queued');
    renderActivity();
  });
}

// ---------------------------------------------------------------------------
// Demo simulator
// ---------------------------------------------------------------------------
async function renderSimulator() {
  const nav = state.nav;
  if (!state.simulator) state.simulator = await api('/api/demo/scenarios');
  const { emails, whatsapp } = state.simulator;
  const ok = paint(nav, `
    ${pageHead('Demo', 'Demo simulator', 'Sends realistic messages through the real n8n intake webhooks (Gmail and WhatsApp Cloud API formats).')}
    ${state.config.demo_mode ? '' : '<div class="notice crit" style="margin-bottom:14px">DEMO_MODE is off – the simulator is disabled.</div>'}
    <div class="grid cols-2">
      <div class="card"><header><h2>Email scenarios</h2><span class="sub">${emails.length} scenarios</span></header><div class="grid" style="gap:12px">
        ${emails.map((e, i) => `<div class="scenario msg"><div><strong>${esc(e.scenario)}</strong></div><div class="small muted">${esc(e.from)}</div><pre>${esc(e.body)}</pre><div class="expected">Expected: ${esc(e.expected)}</div>
          <div class="actions"><button class="btn primary sm" data-email="${i}">${icon('send')} Send email</button><span class="small" id="em-${i}"></span></div></div>`).join('')}
      </div></div>
      <div class="grid" style="align-content:start">
        <div class="card"><header><h2>${esc(whatsapp.multi_message.scenario)}</h2></header>
          <div class="small muted">${esc(whatsapp.multi_message.name)} · +${esc(whatsapp.multi_message.from)}</div>
          <ol class="steps" style="margin:12px 0">${whatsapp.multi_message.messages.map((m) => `<li><span>${esc(m)}</span></li>`).join('')}</ol>
          <div class="expected small muted">Expected: ${esc(whatsapp.multi_message.expected)}</div>
          <div class="actions" style="margin-top:10px"><button class="btn primary" id="waBurst">${icon('chat')} Send the 5 messages</button><span class="small" id="waStatus"></span></div></div>
        <div class="card"><header><h2>Free message</h2></header>
          <form id="freeForm" class="grid">
            <div class="form-grid"><label>Channel<select id="fChannel"><option value="email">Email</option><option value="whatsapp">WhatsApp</option></select></label>
              <label>From (email or phone)<input id="fFrom" value="John Carter <john.carter@apex-travel.example>"></label></div>
            <label>Subject (email)<input id="fSubject" value="Fare request"></label>
            <label>Message<textarea id="fBody">Hi team, need 3 business seats BOM-LHR 17 Nov return 25 Nov, Qatar preferred, urgent.</textarea></label>
            <div class="actions"><button class="btn primary" type="submit">Send</button><span class="small" id="fStatus"></span></div>
          </form></div>
        <div class="card"><header><h2>Engines</h2><span class="sub">run on demand</span></header>
          <div class="actions"><button class="btn" id="runFollow">Run follow-ups now</button><button class="btn" id="runFollow5">Follow-ups as if +5 h later</button><button class="btn" id="runSla">Run SLA monitor</button></div>
          <pre class="quote small" id="engineOut"></pre></div>
      </div>
    </div>`);
  if (!ok) return;
  const track = async (el, messageId, external) => {
    el.textContent = 'processing…';
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      const m = await api(external ? `/api/message?external_id=${encodeURIComponent(messageId)}` : `/api/message/${messageId}`).catch(() => null);
      if (m && ['PROCESSED', 'IGNORED'].includes(m.processing_status)) {
        el.innerHTML = m.rfq_number ? `→ <a class="rfq-id" href="#/rfq/${esc(m.rfq_number)}">${esc(m.rfq_number)}</a> ${statusTag(m.rfq_status)} ${m.classification ? badge(human(m.classification.intent), 'ai') : ''}` : `→ ${badge(m.classification ? human(m.classification.intent) : 'Processed', 'ai')} (no RFQ – see Desk inbox)`;
        refreshCounts();
        return m;
      }
      if (m && ['FAILED', 'DEAD_LETTER'].includes(m.processing_status)) { el.innerHTML = badge(m.processing_status); return m; }
    }
    el.textContent = 'still processing – check the queue';
    return null;
  };
  $view.querySelectorAll('[data-email]').forEach((b) => b.onclick = async () => {
    const e = emails[Number(b.dataset.email)];
    const res = await post('/api/demo/email', { from: e.from, subject: e.subject, body: e.body }).catch((err) => toast(err.message));
    if (res) track(document.getElementById(`em-${b.dataset.email}`), res.results[0].message_id);
  });
  document.getElementById('waBurst').onclick = async () => {
    const st = document.getElementById('waStatus');
    let last;
    for (const text of whatsapp.multi_message.messages) {
      st.textContent = `sending "${text}"…`;
      last = await post('/api/demo/whatsapp', { from: whatsapp.multi_message.from, name: 'Neha Kapoor', text });
      await new Promise((r) => setTimeout(r, 700));
    }
    track(st, last.external_message_id, true);
  };
  document.getElementById('freeForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const channel = document.getElementById('fChannel').value;
    const from = document.getElementById('fFrom').value;
    const text = document.getElementById('fBody').value;
    const st = document.getElementById('fStatus');
    try {
      if (channel === 'email') {
        const res = await post('/api/demo/email', { from, subject: document.getElementById('fSubject').value, body: text });
        track(st, res.results[0].message_id);
      } else {
        const res = await post('/api/demo/whatsapp', { from, text });
        track(st, res.external_message_id, true);
      }
    } catch (e) { toast(e.message); }
  };
  const engine = async (path, body) => { document.getElementById('engineOut').textContent = JSON.stringify(await post(path, body).catch((e) => ({ error: e.message })), null, 2); };
  document.getElementById('runFollow').onclick = () => engine('/api/ops/run-followups', {});
  document.getElementById('runFollow5').onclick = () => engine('/api/ops/run-followups', { simulate_hours_ahead: 5 });
  document.getElementById('runSla').onclick = () => engine('/api/ops/run-sla', {});
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------
async function route() {
  const hash = location.hash || '#/dashboard';
  const [, page, arg] = hash.split('/');
  state.nav += 1; // invalidates any render still in flight for the previous page
  setActiveTab(page === 'rfq' ? 'queue' : page);
  clearInterval(state.timer);
  const pages = { dashboard: renderDashboard, queue: renderQueue, alerts: renderAlerts, outbox: renderOutbox, activity: renderActivity, simulator: renderSimulator };
  $view.innerHTML = '<div class="grid cols-4"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
  window.scrollTo(0, 0);
  try {
    if (page === 'rfq' && arg) {
      await renderRfq(decodeURIComponent(arg));
      autoRefresh(() => renderRfq(decodeURIComponent(arg)), 8000);
    } else {
      const fn = pages[page] || renderDashboard;
      await fn();
      if (page !== 'simulator') autoRefresh(fn, page === 'queue' ? 5000 : 10000);
    }
  } catch (e) {
    $view.innerHTML = `<div class="card">${emptyState('alert', 'Could not load this page', esc(e.message))}</div>`;
  }
  refreshCounts();
}

async function refreshCounts() {
  const [alerts, queue] = await Promise.all([api('/api/alerts').catch(() => []), api('/api/queue').catch(() => [])]);
  document.getElementById('alertCount').textContent = alerts.length || '';
  document.getElementById('queueCount').textContent = queue.length || '';
}

(async () => {
  document.querySelectorAll('#tabs a[data-icon]').forEach((a) => a.insertAdjacentHTML('afterbegin', icon(a.dataset.icon)));
  state.config = await api('/api/config').catch(() => ({ demo_mode: false }));
  document.getElementById('modeBadges').innerHTML = [
    state.config.demo_mode ? badge('Demo mode', 'warn') : badge('Production', 'ok'),
    badge(state.config.require_human_approval ? 'Human approval' : 'Auto-send', state.config.require_human_approval ? 'ok' : 'crit'),
    badge(state.config.ai_provider === 'openai' ? state.config.model : 'Rules (offline)', 'ai'),
  ].join(' ');
  window.addEventListener('hashchange', route);
  route();
})();
