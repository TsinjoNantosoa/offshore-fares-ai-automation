'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const UI = require('../../dashboard/public/ui-policy');

const ROOT = path.join(__dirname, '..', '..');

test('RFQ presentation policy focuses every required operational state', () => {
  const expected = {
    NEEDS_INFORMATION: ['requirements', 'conversation'],
    ASSIGNED: ['fare'],
    PENDING_APPROVAL: ['quote'],
    AWAITING_CLIENT: ['quote', 'conversation'],
    BOOKING_REQUESTED: ['booking'],
    TICKETED: ['booking'],
    CHANGE_REQUESTED: ['afterSales'],
  };
  for (const [status, focus] of Object.entries(expected)) {
    assert.deepEqual(UI.presentationFor(status).focus, focus, status);
  }
});

test('every key RFQ state exposes exactly one context-aware primary action', () => {
  for (const status of Object.keys(UI.BY_STATUS)) {
    const action = UI.presentationFor(status).primary;
    assert.ok(action && action.label, `${status}: primary action`);
    assert.ok(['jump', 'operation'].includes(action.kind), `${status}: supported primary action`);
    assert.equal(Boolean(action.target), action.kind === 'jump', `${status}: jump target`);
    assert.equal(Boolean(action.action), action.kind === 'operation', `${status}: operation code`);
  }
});

test('fare desk and quote expansion follow the operational phase', () => {
  for (const status of ['READY_FOR_SEARCH', 'ASSIGNED', 'SEARCHING', 'FARES_FOUND']) assert.equal(UI.fareDeskExpanded(status), true, status);
  for (const status of ['BOOKING_REQUESTED', 'TICKETING', 'TICKETED', 'CHANGE_REQUESTED', 'REFUND_REQUESTED']) assert.equal(UI.fareDeskExpanded(status), false, status);
  assert.equal(UI.quoteExpanded('PENDING_APPROVAL', 'PENDING_APPROVAL'), true);
  assert.equal(UI.quoteExpanded('AWAITING_CLIENT', 'SENT'), false);
});

test('RFQ source keeps progressive disclosure and separates demo tools', () => {
  const app = fs.readFileSync(path.join(ROOT, 'dashboard', 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'dashboard', 'public', 'index.html'), 'utf8');
  assert.match(app, /Request journey/);
  assert.match(app, /Activity &amp; audit/);
  assert.match(app, /Developer \/ Demo tools/);
  assert.match(app, /if \(!state\.config \|\| !state\.config\.demo_mode\) return '';/);
  assert.ok(html.indexOf('/ui-policy.js') < html.indexOf('/app.js'), 'policy loads before the dashboard');
});
