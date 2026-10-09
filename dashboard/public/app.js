/* Offshore Fares – Ops Console (vanilla JS, no build step) */
'use strict';

const $view = document.getElementById('view');
const state = { config: null, timer: null, simulator: null, quoteTab: 'email', operator: localStorage.getItem('of_operator') || 'Aisha Khan' };

// ---------------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------------
const esc = (v) => String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (v) => (v ? new Date(v).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const fmtDay = (v) => (v ? new Date(`${String(v).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '—');
const fmtTime = (v) => (v ? new Date(v).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
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
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};
const cabinLabel = (c) => ({ BUSINESS: 'Business', FIRST: 'First', PREMIUM_ECONOMY: 'Prem. Economy', ECONOMY: 'Economy', UNKNOWN: '—' }[c] || c || '—');
const statusTag = (s, label) => `<span class="status ${esc(s)}" title="${esc(s)}">${esc(label || s)}</span>`;
const badge = (txt, cls) => `<span class="badge ${esc(cls || txt)}">${esc(txt)}</span>`;

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

function bars(rows, { max, labels } = {}) {
  if (!rows || !rows.length) return '<div class="empty small">No data yet</div>';
  const top = max || Math.max(...rows.map((r) => r.n), 1);
  return `<div class="bars">${rows.map((r) => `
    <div class="bar"><span class="k" title="${esc(r.k)}">${esc(labels ? labels(r.k) : r.k)}</span>
      <span class="track"><span class="fill" style="width:${Math.max(3, (r.n / top) * 100)}%"></span></span>
      <span class="n">${r.n}</span></div>`).join('')}</div>`;
}

function setActiveTab(name) {
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
}

function autoRefresh(fn, ms) {
  clearInterval(state.timer);
  state.timer = setInterval(() => { if (!document.hidden && !document.activeElement.closest('form, textarea, input, select')) fn(); }, ms);
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
const KPI_STATUSES = [
  ['NEW', 'New'], ['NEEDS_INFORMATION', 'Needs information'], ['READY_FOR_SEARCH', 'Ready for search'], ['SEARCHING', 'Searching'],
  ['PENDING_APPROVAL', 'Pending approval'], ['QUOTED', 'Quoted'], ['AWAITING_CLIENT', 'Awaiting client'], ['BOOKING_REQUESTED', 'Booking requested'], ['TICKETED', 'Ticketed'],
];

async function renderDashboard() {
  const s = await api('/api/summary');
  const cur = s.current_by_status;
  const conv = s.conversion || {};
  const sources = Object.fromEntries((s.extraction_sources || []).map((r) => [r.k, r.n]));
  $view.innerHTML = `
    <div class="section-title"><h1>Operations dashboard</h1><span class="muted small">Updated ${fmtTime(s.generated_at)} · auto-refresh</span></div>
    <div class="grid kpis">
      <div class="card kpi accent"><div class="label">Total requests today</div><div class="value">${s.today_total}</div><div class="sub">${s.automation.inbound_24h} messages in 24 h</div></div>
      ${KPI_STATUSES.map(([k, l]) => `<div class="card kpi"><div class="label">${l}</div><div class="value">${cur[k] || 0}</div><div class="sub">${s.today_by_status[k] || 0} created today</div></div>`).join('')}
      <div class="card kpi ${s.sla.open_breached ? 'crit' : ''}"><div class="label">SLA breached</div><div class="value">${s.sla.open_breached}</div><div class="sub">open requests</div></div>
    </div>
    <div class="grid kpis" style="margin-top:14px">
      <div class="card kpi"><div class="label">Avg first response</div><div class="value">${s.timing.avg_first_response_min ?? '—'}<small class="muted"> min</small></div><div class="sub">ack / clarification / quote · 30 days</div></div>
      <div class="card kpi"><div class="label">Avg time to quote</div><div class="value">${s.timing.avg_quote_min ?? '—'}<small class="muted"> min</small></div><div class="sub">request → quote sent</div></div>
      <div class="card kpi"><div class="label">Quote → booking</div><div class="value">${conv.rate ?? '—'}<small class="muted">%</small></div><div class="sub">${conv.booked || 0} of ${conv.quoted || 0} quotes</div></div>
      <div class="card kpi"><div class="label">Automated replies</div><div class="value">${s.automation.outbound_24h}</div><div class="sub">sent in 24 h</div></div>
      <div class="card kpi"><div class="label">AI extraction</div><div class="value">${sources.openai || 0}</div><div class="sub">${sources.rules || 0} via rules fallback</div></div>
      <div class="card kpi ${s.automation.dead_letters ? 'crit' : ''}"><div class="label">Dead letters</div><div class="value">${s.automation.dead_letters}</div><div class="sub">failed 3× – see Activity</div></div>
    </div>
    <div class="grid cols-3" style="margin-top:14px">
      <div class="card"><header><h2>Requests by channel</h2></header>${bars(s.by_channel, { labels: (k) => ({ email: 'Email', whatsapp: 'WhatsApp' }[k] || k) })}</div>
      <div class="card"><header><h2>Requests by cabin</h2></header>${bars(s.by_cabin, { labels: cabinLabel })}</div>
      <div class="card"><header><h2>Open requests by priority</h2></header>${bars(['CRITICAL', 'HIGH', 'NORMAL', 'LOW'].map((k) => ({ k, n: (s.by_priority.find((p) => p.k === k) || { n: 0 }).n })))}</div>
      <div class="card"><header><h2>Top routes</h2></header>${bars(s.by_route)}</div>
      <div class="card"><header><h2>Top agencies</h2></header>${bars(s.by_agency)}</div>
      <div class="card"><header><h2>How it works</h2></header>
        <ol class="small" style="margin:0;padding-left:18px;line-height:1.7">
          <li>Email / WhatsApp request arrives (n8n intake, idempotent)</li>
          <li>AI classifies &amp; extracts – every value verified by code</li>
          <li>Structured RFQ, deterministic priority &amp; desk routing</li>
          <li>Fare desk enters fares (AI never invents prices)</li>
          <li>AI formats the quote – numbers checked – human approves</li>
          <li>Sent on the agent's channel, follow-ups, booking handoff</li>
        </ol></div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------
async function renderQueue() {
  const rows = await api('/api/queue');
  $view.innerHTML = `
    <div class="section-title"><h1>Live RFQ queue</h1><span class="muted small">${rows.length} open requests · sorted by priority, then waiting time</span></div>
    <div class="card table-wrap" style="padding:0">
      <table>
        <thead><tr><th>RFQ</th><th>Agency</th><th>Agent</th><th>Route</th><th>Departure</th><th>Cabin</th><th class="num">Pax</th><th>Priority</th><th>Status</th><th>Assigned to</th><th>Waiting</th><th>SLA</th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr class="clickable" data-rfq="${esc(r.rfq_number)}">
            <td class="mono">${esc(r.rfq_number)}${r.requires_human ? ' <span title="Needs human review">⚑</span>' : ''}${r.source_channel === 'whatsapp' ? ' <span class="muted small">WA</span>' : ''}</td>
            <td>${esc(r.agency || '—')}</td><td>${esc(r.agent || '—')}</td>
            <td class="mono">${r.origin_iata ? `${esc(r.origin_iata)} → ${esc(r.destination_iata || '?')}` : '—'}</td>
            <td>${fmtDay(r.departure_date)}</td><td>${cabinLabel(r.cabin)}</td><td class="num">${r.pax || '—'}</td>
            <td>${badge(r.priority_level)}</td><td>${statusTag(r.status, r.status_label)}</td>
            <td>${esc(r.desk || '—')}${r.operator ? `<div class="muted small">${esc(r.operator)}</div>` : ''}</td>
            <td class="mono">${waiting(r.waiting_seconds)}</td><td>${r.sla === 'N/A' ? '<span class="muted small">client</span>' : badge(r.sla)}</td>
          </tr>`).join('') || '<tr><td colspan="12" class="empty">No open requests</td></tr>'}</tbody>
      </table>
    </div>`;
  $view.querySelectorAll('tr[data-rfq]').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/rfq/${tr.dataset.rfq}`; }));
}

// ---------------------------------------------------------------------------
// RFQ detail
// ---------------------------------------------------------------------------
function requirementsCard(r) {
  const req = r.requirements || {};
  const pax = req.passengers || {};
  const missing = (r.missing_fields || []).length ? r.missing_fields.map((m) => badge(m, 'warn')).join(' ') : badge('complete', 'ok');
  return `<div class="card"><header><h2>Travel requirements</h2>${r.extraction_meta ? badge(r.extraction_meta.source === 'openai' ? `AI · ${r.extraction_meta.model || ''}` : 'rules fallback', 'ai') : ''}</header>
    <dl class="kv">
      <dt>Intent</dt><dd>${esc(r.intent)}${r.classification ? ` <span class="muted small">confidence ${esc(r.classification.confidence)}</span>` : ''}</dd>
      <dt>Route</dt><dd class="mono">${esc(r.origin_iata || '?')} → ${esc(r.destination_iata || '?')} <span class="muted">${esc(r.trip_type || '')}</span></dd>
      <dt>Departure</dt><dd>${fmtDay(req.departure_date || r.departure_date)}${req.date_flexibility_days ? ` <span class="muted">±${req.date_flexibility_days} d</span>` : ''}</dd>
      <dt>Return</dt><dd>${fmtDay(req.return_date || r.return_date)}</dd>
      <dt>Passengers</dt><dd>${pax.adults ?? '—'} adult(s)${pax.children ? `, ${pax.children} child(ren)` : ''}${pax.infants ? `, ${pax.infants} infant(s)` : ''}</dd>
      <dt>Cabin</dt><dd>${cabinLabel(r.cabin)}</dd>
      <dt>Airlines</dt><dd>${(req.preferred_airlines || []).map(esc).join(', ') || '—'}${(req.excluded_airlines || []).length ? ` <span class="muted">· not ${req.excluded_airlines.map(esc).join(', ')}</span>` : ''}</dd>
      <dt>Urgency</dt><dd>${esc(req.urgency || '—')}</dd>
      <dt>Missing</dt><dd>${missing}</dd>
      ${(req.ambiguities || []).length ? `<dt>Ambiguities</dt><dd class="small">${req.ambiguities.map(esc).join('<br>')}</dd>` : ''}
      ${r.booking_reference ? `<dt>Booking ref</dt><dd class="mono">${esc(r.booking_reference)}</dd>` : ''}
    </dl></div>`;
}

function fareDeskCard(d) {
  const r = d.rfq;
  const active = d.options.filter((o) => o.is_active);
  const canEnter = ['ASSIGNED', 'SEARCHING', 'FARES_FOUND', 'PENDING_APPROVAL'].includes(r.status);
  const list = active.map((o) => `
    <div class="option-card ${r.selected_option_code === o.option_code ? 'selected' : ''}">
      <div style="display:flex;justify-content:space-between;gap:8px"><strong>${esc(o.option_code)} · ${esc(o.airline)}</strong>
        <span class="mono">${esc(o.fare_currency)} ${Number(o.fare_amount).toLocaleString('en-US')}</span></div>
      <div class="small muted">${(o.flight_segments || []).map((s) => `${esc(s.flight_no)} ${esc(s.from)}→${esc(s.to)}`).join(' · ')}</div>
      <div class="small">Bag ${esc(o.baggage)} · Change ${esc(o.change_penalty)} · Refund ${esc(o.refund_penalty)}</div>
      <div class="small ${new Date(o.fare_valid_until) < new Date() ? 'muted' : ''}">Valid until ${fmtTime(o.fare_valid_until)} ${new Date(o.fare_valid_until) < new Date() ? badge('expired', 'crit') : ''} · ${esc(o.source)}</div>
    </div>`).join('');
  return `<div class="card"><header><h2>Mock Fare Desk</h2>${canEnter ? '<button class="btn" id="loadMock">Load sample fares</button>' : ''}</header>
    ${list ? `<div class="grid" style="gap:8px">${list}</div>` : '<div class="muted small">No fare options yet.</div>'}
    ${canEnter ? `
      <form id="fareForm" style="margin-top:12px" class="grid">
        <div class="notice small">Fares only enter the system here (or from a future GDS adapter). The AI never creates or edits a price.</div>
        <label>Fare options (JSON array, validated server-side)<textarea id="fareJson" style="min-height:180px" placeholder='[{"airline":"Qatar Airways", ...}]'></textarea></label>
        <div class="form-grid"><label>Entered by<input id="fareBy" value="${esc(state.operator)}"></label></div>
        <div class="actions"><button class="btn primary" type="submit">Submit fares &amp; generate quote</button></div>
      </form>` : ''}
  </div>`;
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
  return `<div class="card"><header><h2>Quote v${q.version} ${badge(q.status, q.status === 'SENT' || q.status === 'APPROVED' ? 'ok' : q.status === 'REJECTED' ? 'crit' : 'warn')}</h2>
      <span>${badge(q.generated_by === 'AI' ? `AI · ${q.ai_model || ''}` : q.generated_by, q.generated_by === 'AI' ? 'ai' : '')}</span></header>
    ${notes.map((n) => `<div class="notice warn small" style="margin-bottom:8px">${esc(n)}</div>`).join('')}
    <div class="tabs-inline"><button data-qt="email" class="${state.quoteTab === 'email' ? 'active' : ''}">Email</button><button data-qt="whatsapp" class="${state.quoteTab === 'whatsapp' ? 'active' : ''}">WhatsApp</button></div>
    ${pending ? `
      <label>Subject<input id="qSubject" value="${esc(q.email_subject)}"></label>
      <textarea id="qEmail" style="min-height:300px;${state.quoteTab === 'email' ? '' : 'display:none'}">${esc(q.email_body)}</textarea>
      <textarea id="qWa" style="min-height:300px;${state.quoteTab === 'whatsapp' ? '' : 'display:none'}">${esc(q.whatsapp_body)}</textarea>
      <div class="form-grid" style="margin-top:8px"><label>Reviewer<input id="qReviewer" value="${esc(state.operator)}"></label><label>Note<input id="qNote" placeholder="optional"></label></div>
      <div class="actions" style="margin-top:10px">
        <button class="btn ok" data-decision="APPROVE">Approve &amp; send</button>
        <button class="btn" data-decision="EDIT">Save edit (new version)</button>
        <button class="btn danger" data-decision="REJECT">Reject</button>
      </div>
      <div class="muted small" style="margin-top:6px">Valid until ${fmtTime(q.valid_until)} · content hash <span class="mono">${esc(String(q.content_hash).slice(0, 12))}…</span></div>`
    : `<div class="small muted">Subject: ${esc(q.email_subject)}</div><pre class="quote">${esc(state.quoteTab === 'email' ? q.email_body : q.whatsapp_body)}</pre>
       <div class="muted small">${q.approved_by ? `Approved by ${esc(q.approved_by)} · ${fmtTime(q.approved_at)}` : ''}${q.sent_at ? ` · sent ${fmtTime(q.sent_at)} via ${esc(q.delivery_channel)}` : ''}</div>`}
  </div>`;
}

function handoffCard(h) {
  const o = h.selected_option || {};
  const p = h.passengers || {};
  const segs = (o.segments || []).map((x) => `<div class="seg">${esc(x.direction === 'INBOUND' ? '↩' : '→')} ${esc(x.flight_no)} ${esc(x.from)}→${esc(x.to)} · ${esc(String(x.depart_at || '').replace('T', ' '))}</div>`).join('');
  return `<div class="card"><header><h2>Booking handoff → Ticketing Desk</h2>${badge('BOOKING REQUEST', 'ok')}</header>
    ${h.requires_fare_recheck ? '<div class="notice crit small" style="margin-bottom:8px">Fare validity passed – revalidate before ticketing.</div>' : ''}
    <dl class="kv">
      <dt>RFQ</dt><dd class="mono">${esc(h.rfq_number)}</dd>
      <dt>Agency / agent</dt><dd>${esc(h.agency || '—')} · ${esc(h.contact || '—')}</dd>
      <dt>Contact</dt><dd class="small">${esc(h.contact_email || '')} ${h.contact_whatsapp ? `· +${esc(h.contact_whatsapp)}` : ''}</dd>
      <dt>Passengers</dt><dd>${esc(p.adults ?? '—')} ADT${p.children ? ` · ${esc(p.children)} CHD` : ''}${p.infants ? ` · ${esc(p.infants)} INF` : ''}</dd>
      <dt>Selected option</dt><dd><strong>${esc(o.code)} · ${esc(o.airline)}</strong> ${o.fare_amount ? `· ${esc(o.fare_currency)} ${Number(o.fare_amount).toLocaleString('en-US')} ${o.fare_basis === 'TOTAL' ? 'total' : 'per pax'}` : ''}</dd>
      <dt>Flights</dt><dd>${segs || '—'}</dd>
      <dt>Travel dates</dt><dd>${fmtDay(h.travel_dates && h.travel_dates.departure)} → ${fmtDay(h.travel_dates && h.travel_dates.return)}</dd>
      <dt>Conditions</dt><dd class="small">Bag ${esc(o.baggage)} · Change ${esc(o.change_penalty)} · Refund ${esc(o.refund_penalty)}</dd>
      <dt>Agent note</dt><dd class="small">${esc(h.notes || '—')}</dd>
    </dl>
    <details><summary>Raw handoff payload (for a future PNR / ticketing API)</summary><pre class="quote">${esc(JSON.stringify(h, null, 2))}</pre></details></div>`;
}

function operatorActions(r) {
  const actions = {
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
  return actions.concat(flag, common).map(([a, l]) => `<button class="btn ${['MARK_LOST', 'CANCEL'].includes(a) ? 'danger' : ''}" data-op="${a}">${l}</button>`).join('');
}

function replyCard(r) {
  if (!state.config || !state.config.demo_mode) return '';
  return `<div class="card"><header><h2>Simulate an agent reply</h2><span class="muted small">${esc(r.conversation_channel || r.source_channel)} · same thread</span></header>
    <form id="replyForm" class="grid">
      <div class="actions small">${['Option 2 works. Please proceed.', 'second one', 'go ahead', 'please hold', 'Too expensive. Anything cheaper?', 'can you check Emirates?', 'change dates to 18th', 'STOP'].map((t) => `<button type="button" class="btn" data-reply="${esc(t)}">${esc(t)}</button>`).join('')}</div>
      <label>Message<input id="replyText" placeholder="Type a reply from ${esc(r.first_name || 'the agent')}"></label>
      <div class="actions"><button class="btn primary" type="submit">Send as ${esc(r.first_name || 'agent')}</button></div>
    </form></div>`;
}

async function renderRfq(number) {
  const d = await api(`/api/rfq/${encodeURIComponent(number)}`);
  const r = d.rfq;
  const s = d.sla;
  $view.innerHTML = `
    <div class="section-title">
      <div><a href="#/queue" class="small">← Queue</a><h1 style="margin-top:4px"><span class="mono">${esc(r.rfq_number)}</span> ${statusTag(r.status, r.status_label)} ${badge(r.priority_level)}
        ${r.requires_human ? badge('needs review', 'warn') : ''} ${(r.security_flags || []).length ? badge('security flag', 'crit') : ''}</h1>
        <div class="muted small">${esc(r.agency_name || 'Unknown agency')} · ${esc([r.first_name, r.last_name].filter(Boolean).join(' ') || r.contact_email || '')} ${r.verification_status === 'UNVERIFIED' ? badge('unverified sender', 'warn') : ''} · via ${esc(r.source_channel)} · created ${fmtTime(r.created_at)} · ${esc(r.desk_name || 'unassigned')}${r.operator_name ? ` (${esc(r.operator_name)})` : ''}
        · SLA ${s.tracked ? `${s.minutes_in_status}/${s.threshold_minutes} min ${badge(s.breached ? 'BREACHED' : 'OK')}` : 'n/a'}</div>
      </div>
      <div class="actions">${operatorActions(r)}</div>
    </div>
    ${r.human_review_reason ? `<div class="notice warn" style="margin-bottom:12px">${esc(r.human_review_reason)}</div>` : ''}
    ${r.requires_fare_recheck ? '<div class="notice crit" style="margin-bottom:12px">Selected fare has expired – the ticketing desk must revalidate price and availability before ticketing.</div>' : ''}
    <div class="card" style="margin-bottom:14px"><header><h2>Request journey</h2><span class="muted small">what the client sees, step by step</span></header>
      <div class="journey">${d.journey.map((j) => `<span class="step ${j.done ? 'done' : ''}" title="${j.at ? fmtTime(j.at) : 'pending'}"><span class="dot"></span>${esc(j.label)}</span>`).join('')}</div></div>
    <div class="split">
      <div class="grid" style="align-content:start">
        ${requirementsCard(r)}
        ${r.handoff ? handoffCard(r.handoff) : ''}
        ${approvalCard(d)}
        <div class="card"><header><h2>Conversation</h2><span class="muted small">${d.messages.length} messages</span></header>
          ${d.messages.map((m) => `<div class="msg ${m.direction}"><div class="meta">${badge(m.direction === 'INBOUND' ? 'agent' : (m.kind || 'outbound'), m.direction === 'INBOUND' ? 'ai' : 'info')} ${badge(m.channel)} ${m.delivery_status ? badge(m.delivery_status) : ''} ${(m.security_flags || []).length ? badge('injection signals', 'crit') : ''}<span>${fmtTime(m.at)}</span>${m.classification ? `<span>→ ${esc(m.classification.intent)} (${esc(m.classification.confidence)})</span>` : ''}</div>
            ${m.subject ? `<div class="small"><strong>${esc(m.subject)}</strong></div>` : ''}<pre>${esc(m.content)}</pre></div>`).join('') || '<div class="muted">No messages</div>'}
        </div>
      </div>
      <div class="grid" style="align-content:start">
        ${fareDeskCard(d)}
        ${replyCard(r)}
        ${d.alerts.length ? `<div class="card"><header><h2>Tasks &amp; alerts</h2></header>${d.alerts.map((a) => `<div class="msg"><div class="meta">${badge(a.severity)} ${badge(a.alert_type, 'info')} ${badge(a.status, a.status === 'RESOLVED' ? 'ok' : '')} <span>${ago(a.created_at)}</span></div><div class="small">${esc(a.title)}</div></div>`).join('')}</div>` : ''}
        <div class="card"><header><h2>Audit trail</h2><span class="muted small">${d.audit.length} events</span></header>
          <ul class="timeline">${d.audit.map((a) => `<li><span class="muted">${new Date(a.created_at).toLocaleTimeString('en-GB')}</span><span><strong>${esc(a.action)}</strong></span><span class="small">${esc(a.actor_type)}${a.actor_id ? ` · ${esc(a.actor_id)}` : ''}${a.metadata && a.metadata.to ? ` · ${esc(a.metadata.from)} → ${esc(a.metadata.to)}` : ''}${a.metadata && a.metadata.score !== undefined ? ` · score ${esc(a.metadata.score)} ${esc(a.metadata.level)}` : ''}</span></li>`).join('')}</ul></div>
      </div>
    </div>`;
  wireRfq(d);
}

function wireRfq(d) {
  const r = d.rfq;
  const reload = () => renderRfq(r.rfq_number).catch((e) => toast(e.message));
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
      let res = await post('/api/quote/decision', payload).catch(async (e) => {
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
// Alerts, outbox, activity
// ---------------------------------------------------------------------------
async function renderAlerts() {
  const rows = await api('/api/alerts');
  $view.innerHTML = `<div class="section-title"><h1>Desk inbox</h1><span class="muted small">notifications, human tasks, SLA breaches, security flags</span></div>
    <div class="card table-wrap" style="padding:0"><table><thead><tr><th>When</th><th>Severity</th><th>Type</th><th>Desk</th><th>RFQ</th><th>Title</th><th></th></tr></thead><tbody>
    ${rows.map((a) => `<tr><td class="small">${ago(a.created_at)}</td><td>${badge(a.severity)}</td><td>${badge(a.alert_type, 'info')}</td><td>${esc(a.desk || '—')}</td>
      <td class="mono">${a.rfq_number ? `<a href="#/rfq/${esc(a.rfq_number)}">${esc(a.rfq_number)}</a>` : '—'}</td>
      <td>${esc(a.title)}${a.details && a.details.kb_suggestions && a.details.kb_suggestions.length ? `<div class="muted small">KB: ${a.details.kb_suggestions.map((k) => esc(k.title)).join(', ')}</div>` : ''}</td>
      <td><button class="btn" data-resolve="${a.id}">Resolve</button></td></tr>`).join('') || '<tr><td colspan="7" class="empty">Inbox zero</td></tr>'}
    </tbody></table></div>`;
  $view.querySelectorAll('[data-resolve]').forEach((b) => b.onclick = async () => {
    await post('/api/ops/action', { action: 'RESOLVE_ALERT', alert_id: b.dataset.resolve, operator: state.operator }).catch((e) => toast(e.message));
    renderAlerts();
  });
}

async function renderOutbox() {
  const rows = await api('/api/outbox');
  $view.innerHTML = `<div class="section-title"><h1>Outbox</h1><span class="muted small">what the agents received${state.config.demo_mode ? ' · DEMO_MODE: deliveries are simulated' : ''}</span></div>
    <div class="grid cols-2">${rows.map((m) => `<div class="card"><div class="msg OUTBOUND" style="margin:0"><div class="meta">${badge(m.kind || 'message', 'info')} ${badge(m.channel)} ${badge(m.delivery_status || 'n/a')} <span>${fmtTime(m.sent_at)}</span>
      ${m.rfq_number ? `<a class="mono" href="#/rfq/${esc(m.rfq_number)}">${esc(m.rfq_number)}</a>` : ''}</div><div class="small muted">to ${esc(m.recipient || '—')}</div>${m.subject ? `<div class="small"><strong>${esc(m.subject)}</strong></div>` : ''}<pre>${esc(m.content)}</pre></div></div>`).join('') || '<div class="empty">Nothing sent yet</div>'}</div>`;
}

async function renderActivity() {
  const [events, dead] = await Promise.all([api('/api/events'), api('/api/dead-letters')]);
  $view.innerHTML = `<div class="section-title"><h1>Workflow activity</h1><span class="muted small">structured events from n8n (workflow_events)</span></div>
    ${dead.length ? `<div class="card" style="margin-bottom:14px"><header><h2>Failed / dead-letter messages</h2></header><table><thead><tr><th>When</th><th>Status</th><th>Sender</th><th>Message</th><th>Last error</th><th></th></tr></thead><tbody>
      ${dead.map((m) => `<tr><td class="small">${ago(m.created_at)}</td><td>${badge(m.processing_status)} <span class="muted small">×${m.retry_count}</span></td><td class="small">${esc(m.sender)}</td><td class="small">${esc(m.content)}</td><td class="small">${esc(m.processing_notes && m.processing_notes.last_error)}</td><td><button class="btn" data-retry="${m.id}">Retry</button></td></tr>`).join('')}</tbody></table></div>` : ''}
    <div class="card table-wrap" style="padding:0"><table><thead><tr><th>When</th><th>Workflow</th><th>Event</th><th>Status</th><th>RFQ</th><th class="num">Duration</th><th>Details</th></tr></thead><tbody>
    ${events.map((e) => `<tr><td class="small">${fmtTime(e.created_at)}</td><td class="mono">${esc(e.workflow)}</td><td>${esc(e.event)}</td><td>${badge(e.status, e.status === 'OK' ? 'ok' : e.status === 'ERROR' ? 'crit' : 'warn')}</td>
      <td class="mono">${e.rfq_number ? `<a href="#/rfq/${esc(e.rfq_number)}">${esc(e.rfq_number)}</a>` : ''}</td><td class="num">${e.duration_ms ?? ''}</td><td class="small mono">${esc(JSON.stringify(e.details)).slice(0, 140)}</td></tr>`).join('')}
    </tbody></table></div>`;
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
  if (!state.simulator) state.simulator = await api('/api/demo/scenarios');
  const { emails, whatsapp } = state.simulator;
  $view.innerHTML = `
    <div class="section-title"><h1>Demo simulator</h1><span class="muted small">sends realistic messages through the real n8n intake webhooks (Gmail / WhatsApp formats)</span></div>
    ${state.config.demo_mode ? '' : '<div class="notice crit">DEMO_MODE is off – the simulator is disabled.</div>'}
    <div class="grid cols-2">
      <div class="card"><header><h2>Email scenarios</h2></header><div class="grid" style="gap:10px">
        ${emails.map((e, i) => `<div class="scenario msg"><div><strong>${esc(e.scenario)}</strong></div><div class="small muted">${esc(e.from)}</div><pre>${esc(e.body)}</pre><div class="expected">Expected: ${esc(e.expected)}</div>
          <div class="actions"><button class="btn primary" data-email="${i}">Send email</button><span class="small" id="em-${i}"></span></div></div>`).join('')}
      </div></div>
      <div class="grid" style="align-content:start">
        <div class="card"><header><h2>${esc(whatsapp.multi_message.scenario)}</h2></header>
          <div class="small muted">${esc(whatsapp.multi_message.name)} · +${esc(whatsapp.multi_message.from)}</div>
          <ol class="small">${whatsapp.multi_message.messages.map((m) => `<li>${esc(m)}</li>`).join('')}</ol>
          <div class="expected small muted">Expected: ${esc(whatsapp.multi_message.expected)}</div>
          <div class="actions" style="margin-top:8px"><button class="btn primary" id="waBurst">Send the 5 messages</button><span class="small" id="waStatus"></span></div></div>
        <div class="card"><header><h2>Free message</h2></header>
          <form id="freeForm" class="grid">
            <div class="form-grid"><label>Channel<select id="fChannel"><option value="email">Email</option><option value="whatsapp">WhatsApp</option></select></label>
              <label>From (email or phone)<input id="fFrom" value="John Carter <john.carter@apex-travel.example>"></label></div>
            <label>Subject (email)<input id="fSubject" value="Fare request"></label>
            <label>Message<textarea id="fBody">Hi team, need 3 business seats BOM-LHR 17 Nov return 25 Nov, Qatar preferred, urgent.</textarea></label>
            <div class="actions"><button class="btn primary" type="submit">Send</button><span class="small" id="fStatus"></span></div>
          </form></div>
        <div class="card"><header><h2>Engines</h2></header>
          <div class="actions"><button class="btn" id="runFollow">Run follow-ups now</button><button class="btn" id="runFollow5">Follow-ups as if +5 h later</button><button class="btn" id="runSla">Run SLA monitor</button></div>
          <pre class="quote small" id="engineOut"></pre></div>
      </div>
    </div>`;
  const track = async (el, messageId, external) => {
    el.textContent = 'processing…';
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      const m = await api(external ? `/api/message?external_id=${encodeURIComponent(messageId)}` : `/api/message/${messageId}`).catch(() => null);
      if (m && ['PROCESSED', 'IGNORED'].includes(m.processing_status)) {
        el.innerHTML = m.rfq_number ? `→ <a class="mono" href="#/rfq/${esc(m.rfq_number)}">${esc(m.rfq_number)}</a> ${statusTag(m.rfq_status)} ${m.classification ? badge(m.classification.intent, 'ai') : ''}` : `→ ${badge(m.classification ? m.classification.intent : 'processed', 'ai')} (no RFQ – see Desk inbox)`;
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
  setActiveTab(page === 'rfq' ? 'queue' : page);
  clearInterval(state.timer);
  const pages = { dashboard: renderDashboard, queue: renderQueue, alerts: renderAlerts, outbox: renderOutbox, activity: renderActivity, simulator: renderSimulator };
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
    $view.innerHTML = `<div class="card notice crit">Could not load: ${esc(e.message)}</div>`;
  }
  refreshAlertCount();
}

async function refreshAlertCount() {
  const rows = await api('/api/alerts').catch(() => []);
  document.getElementById('alertCount').textContent = rows.length || '';
}

(async () => {
  state.config = await api('/api/config').catch(() => ({ demo_mode: false }));
  document.getElementById('modeBadges').innerHTML = [
    state.config.demo_mode ? badge('DEMO MODE', 'warn') : badge('PRODUCTION', 'ok'),
    badge(state.config.require_human_approval ? 'Human approval ON' : 'Auto-send quotes', state.config.require_human_approval ? 'ok' : 'crit'),
    badge(state.config.ai_provider === 'openai' ? `AI · ${state.config.model}` : 'AI · rules (offline)', 'ai'),
  ].join(' ');
  window.addEventListener('hashchange', route);
  route();
})();
