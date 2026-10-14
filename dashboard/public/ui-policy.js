/* Context-aware presentation policy for the RFQ operations console. */
'use strict';

(function expose(factory) {
  const policy = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = policy;
  if (typeof globalThis !== 'undefined') globalThis.OffshoreFaresUiPolicy = policy;
})(() => {
  const DEFAULT = {
    focus: ['requirements'],
    primary: { kind: 'jump', target: 'travel-requirements', label: 'Review request' },
  };

  const BY_STATUS = {
    NEW: {
      focus: ['requirements', 'conversation'],
      primary: { kind: 'jump', target: 'travel-requirements', label: 'Review request' },
    },
    NEEDS_INFORMATION: {
      focus: ['requirements', 'conversation'],
      primary: { kind: 'jump', target: 'conversation', label: 'Review missing information' },
    },
    READY_FOR_SEARCH: {
      focus: ['fare'],
      primary: { kind: 'jump', target: 'fare-desk', label: 'Open fare desk' },
    },
    ASSIGNED: {
      focus: ['fare'],
      primary: { kind: 'operation', action: 'START_SEARCH', label: 'Start fare search' },
    },
    SEARCHING: {
      focus: ['fare'],
      primary: { kind: 'jump', target: 'fare-desk', label: 'Review fare search' },
    },
    FARES_FOUND: {
      focus: ['fare'],
      primary: { kind: 'jump', target: 'fare-desk', label: 'Review fare options' },
    },
    PENDING_APPROVAL: {
      focus: ['quote'],
      primary: { kind: 'jump', target: 'quote', label: 'Review quote' },
    },
    AWAITING_CLIENT: {
      focus: ['quote', 'conversation'],
      primary: { kind: 'jump', target: 'quote', label: 'View quote' },
    },
    BOOKING_REQUESTED: {
      focus: ['booking'],
      primary: { kind: 'operation', action: 'START_TICKETING', label: 'Start ticketing' },
    },
    TICKETING: {
      focus: ['booking'],
      primary: { kind: 'operation', action: 'MARK_TICKETED', label: 'Mark ticketed' },
    },
    TICKETED: {
      focus: ['booking'],
      primary: { kind: 'jump', target: 'booking-handoff', label: 'View booking' },
    },
    CHANGE_REQUESTED: {
      focus: ['afterSales'],
      primary: { kind: 'jump', target: 'after-sales', label: 'Review change' },
    },
    REFUND_REQUESTED: {
      focus: ['afterSales'],
      primary: { kind: 'jump', target: 'after-sales', label: 'Review refund' },
    },
  };

  const presentationFor = (status) => BY_STATUS[status] || DEFAULT;
  const isFocused = (status, section) => presentationFor(status).focus.includes(section);
  const fareDeskExpanded = (status) => ['READY_FOR_SEARCH', 'ASSIGNED', 'SEARCHING', 'FARES_FOUND'].includes(status);
  const quoteExpanded = (status, quoteStatus) => status === 'PENDING_APPROVAL' && quoteStatus === 'PENDING_APPROVAL';

  return { BY_STATUS, presentationFor, isFocused, fareDeskExpanded, quoteExpanded };
});
