-- =============================================================================
-- SQL API tests (run against a database with schema + functions + seed).
-- Everything runs inside a transaction that is rolled back.
--   psql -v ON_ERROR_STOP=1 -f database/tests/api_flow_test.sql
-- Any failed ASSERT aborts with a non-zero exit code.
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;

DO $$
DECLARE
  r jsonb; v_msg uuid; v_conv uuid; v_rfq uuid; v_quote uuid; v_new_quote uuid; v_status text; v_ok boolean; v_count int;
  v_john uuid;   -- test agent created below (independent of the demo data)
  v_agency uuid;
BEGIN
  INSERT INTO agencies (name, code, email_domain, priority_level) VALUES ('QA Test Agency', 'QATEST', 'qa-agency.example', 'VIP') RETURNING id INTO v_agency;
  INSERT INTO contacts (agency_id, first_name, last_name, email) VALUES (v_agency, 'Quinn', 'Tester', 'qa.agent@qa-agency.example') RETURNING id INTO v_john;
  INSERT INTO operators (desk_code, full_name) VALUES ('PREMIUM_DESK', 'QA Operator');

  RAISE NOTICE '1. idempotent intake';
  r := of_register_inbound_message('{"workflow":"test","channel":"email","external_message_id":"t-1","conversation_key":"t-thread-1",
        "sender":{"name":"Quinn Tester","email":"QA.Agent@qa-agency.example"},
        "message":{"subject":"BOM LHR","text":"need 3 business seats BOM-LHR 17 Nov return 25 Nov","received_at":"2026-10-05T10:00:00Z"},
        "security":{"signals":[]}}');
  ASSERT r->>'status' = 'REGISTERED', 'first delivery registered';
  ASSERT (r->>'contact_id')::uuid = v_john, 'contact matched case-insensitively';
  ASSERT (r->>'contact_verified')::boolean, 'known contact is verified';
  v_msg := (r->>'message_id')::uuid; v_conv := (r->>'conversation_id')::uuid;
  r := of_register_inbound_message('{"workflow":"test","channel":"email","external_message_id":"t-1","conversation_key":"t-thread-1",
        "sender":{"email":"qa.agent@qa-agency.example"},"message":{"text":"dup"}}');
  ASSERT r->>'status' = 'DUPLICATE', 'second delivery is a duplicate';
  ASSERT (SELECT count(*) FROM messages WHERE external_message_id = 't-1') = 1, 'stored once';
  r := of_register_inbound_message('{"channel":"email","external_message_id":"","conversation_key":"x","sender":{}}');
  ASSERT r->>'error' = 'MALFORMED_MESSAGE', 'malformed rejected';

  RAISE NOTICE '2. unknown sender -> unverified contact matched to agency by domain';
  r := of_register_inbound_message('{"channel":"email","external_message_id":"t-unknown","conversation_key":"t-u","sender":{"name":"New Person","email":"new.person@qa-agency.example"},"message":{"text":"hello"}}');
  ASSERT NOT (r->>'contact_verified')::boolean, 'unverified';
  ASSERT (r->>'agency_id')::uuid = v_agency, 'agency by domain';

  RAISE NOTICE '3. claim + per-conversation lock';
  r := of_claim_next_message(jsonb_build_object('conversation_id', v_conv, 'execution_id', 'exec-A'));
  ASSERT (r->>'claimed')::boolean, 'claimed';
  ASSERT r->'active_rfq' = 'null'::jsonb, 'no active rfq for a new thread';
  r := of_claim_next_message(jsonb_build_object('conversation_id', v_conv, 'execution_id', 'exec-B'));
  ASSERT NOT (r->>'claimed')::boolean AND r->>'reason' = 'LOCKED_OR_UNKNOWN', 'second worker blocked by lock';

  RAISE NOTICE '4. create RFQ (ready) and number format';
  r := of_upsert_rfq_from_message(jsonb_build_object('workflow', 'test', 'message_id', v_msg, 'conversation_id', v_conv, 'contact_id', v_john,
        'agency_id', (SELECT agency_id FROM contacts WHERE id = v_john), 'channel', 'email', 'ready', true,
        'classification', '{"intent":"NEW_QUOTE","confidence":0.96,"source":"openai"}'::jsonb,
        'requirements', '{"intent":"NEW_QUOTE","trip_type":"ROUND_TRIP","origin":{"iata":"BOM"},"destination":{"iata":"LHR"},"departure_date":"2026-11-17","return_date":"2026-11-25","passengers":{"adults":3,"children":0,"infants":0},"cabin":"BUSINESS","preferred_airlines":["Qatar Airways"],"missing_fields":[]}'::jsonb));
  ASSERT (r->>'created')::boolean AND r->>'status' = 'READY_FOR_SEARCH', 'created ready';
  ASSERT r->>'rfq_number' ~ '^OFF-RFQ-[0-9]{4}-[0-9]{6}$', 'RFQ number format: ' || (r->>'rfq_number');
  v_rfq := (r->>'rfq_id')::uuid;
  ASSERT (SELECT count(*) FROM rfq_status_history WHERE rfq_id = v_rfq) = 2, 'NEW + READY_FOR_SEARCH history';
  ASSERT (SELECT count(*) FROM rfq_segments WHERE rfq_id = v_rfq) = 2, 'outbound + return segments';
  r := of_complete_message(jsonb_build_object('message_id', v_msg, 'rfq_id', v_rfq));
  ASSERT NOT (r->>'has_more')::boolean, 'no more pending';

  RAISE NOTICE '5. invalid transition is refused by the database';
  BEGIN
    PERFORM of_transition_rfq(v_rfq, 'TICKETED', 'HUMAN', 'test');
    ASSERT false, 'should have raised';
  EXCEPTION WHEN raise_exception THEN
    ASSERT SQLERRM LIKE 'INVALID_TRANSITION: READY_FOR_SEARCH -> TICKETED%', SQLERRM;
  END;

  RAISE NOTICE '6. priority + assignment';
  r := of_save_priority(jsonb_build_object('rfq_id', v_rfq, 'score', 55, 'level', 'HIGH', 'breakdown', '[]'::jsonb));
  r := of_assign_rfq(jsonb_build_object('rfq_id', v_rfq, 'desk_code', 'PREMIUM_DESK', 'rule', 'PREMIUM_CABIN'));
  ASSERT r->>'status' = 'ASSIGNED' AND r->>'operator_name' IS NOT NULL, 'assigned to an operator';
  ASSERT (SELECT count(*) FROM alerts WHERE rfq_id = v_rfq AND alert_type = 'DESK_NOTIFICATION') = 1, 'desk notified';
  r := of_assign_rfq(jsonb_build_object('rfq_id', v_rfq, 'desk_code', 'PREMIUM_DESK'));
  ASSERT (SELECT count(*) FROM assignments WHERE rfq_id = v_rfq) = 1, 're-assigning to same desk is idempotent';

  RAISE NOTICE '7. fare options (ASSIGNED -> SEARCHING -> FARES_FOUND)';
  r := of_save_fare_options(jsonb_build_object('rfq_id', v_rfq, 'entered_by', 'Aisha Khan', 'options', jsonb_build_array(
        jsonb_build_object('option_no', 1, 'option_code', 'OPT-001', 'airline', 'Qatar Airways', 'departure_at', '2026-11-17T02:40', 'return_departure_at', '2026-11-25T15:20',
                           'cabin', 'BUSINESS', 'fare', jsonb_build_object('amount', 2450, 'currency', 'USD'), 'baggage', '40 kg', 'change_penalty', 'USD 150',
                           'refund_penalty', 'USD 250', 'fare_valid_until', (now() + interval '2 hours')::text, 'source', 'MOCK'),
        jsonb_build_object('option_no', 2, 'option_code', 'OPT-002', 'airline', 'Emirates', 'departure_at', '2026-11-17T04:05', 'return_departure_at', '2026-11-25T14:30',
                           'cabin', 'BUSINESS', 'fare', jsonb_build_object('amount', 2610, 'currency', 'USD'), 'baggage', '40 kg', 'change_penalty', 'USD 200',
                           'refund_penalty', 'USD 300', 'fare_valid_until', (now() + interval '2 hours')::text, 'source', 'MOCK'))));
  ASSERT (r->>'ok')::boolean AND r->>'status' = 'FARES_FOUND', 'fares saved';
  ASSERT (SELECT array_agg(to_status ORDER BY id) FROM rfq_status_history WHERE rfq_id = v_rfq) @> ARRAY['SEARCHING', 'FARES_FOUND'], 'path walked';
  ASSERT (SELECT fare_amount FROM fare_options WHERE rfq_id = v_rfq AND option_code = 'OPT-001' AND is_active) = 2450.00, 'amount preserved exactly';

  RAISE NOTICE '8. quote requires approval; approval is versioned and audited';
  r := of_create_quote(jsonb_build_object('rfq_id', v_rfq, 'email_subject', 's', 'email_body', 'b', 'whatsapp_body', 'w', 'quote_model', '{}'::jsonb,
                                          'generated_by', 'TEMPLATE', 'valid_until', (now() + interval '2 hours')::text, 'require_approval', true));
  ASSERT r->>'rfq_status' = 'PENDING_APPROVAL' AND NOT (r->>'send_now')::boolean, 'pending approval, nothing sent';
  v_quote := (r->>'quote_id')::uuid;
  r := of_quote_decision(jsonb_build_object('quote_id', v_quote, 'action', 'APPROVE', 'reviewer', ''));
  ASSERT r->>'error' = 'REVIEWER_REQUIRED', 'reviewer mandatory';
  r := of_quote_decision(jsonb_build_object('quote_id', v_quote, 'action', 'EDIT', 'reviewer', 'Aisha Khan',
                                            'edited', '{"email_body":"b2","whatsapp_body":"w2"}'::jsonb, 'edit_review', '{"warnings":["numbers changed"]}'::jsonb));
  ASSERT r->>'result' = 'EDITED' AND (r->>'version')::int = 2, 'edit creates version 2';
  v_new_quote := (r->>'quote_id')::uuid;
  r := of_quote_decision(jsonb_build_object('quote_id', v_quote, 'action', 'APPROVE', 'reviewer', 'Aisha Khan'));
  ASSERT r->>'error' = 'QUOTE_NOT_PENDING_APPROVAL', 'old version cannot be approved';
  r := of_quote_decision(jsonb_build_object('quote_id', v_new_quote, 'action', 'APPROVE', 'reviewer', 'Aisha Khan'));
  ASSERT r->>'error' = 'EDIT_WARNINGS_NOT_ACKNOWLEDGED', 'warnings must be acknowledged';
  r := of_quote_decision(jsonb_build_object('quote_id', v_new_quote, 'action', 'APPROVE', 'reviewer', 'Aisha Khan', 'acknowledge_warnings', true, 'note', 'ok'));
  ASSERT r->>'result' = 'APPROVED' AND (r->>'send')::boolean, 'approved';
  ASSERT (SELECT count(*) FROM approvals WHERE rfq_id = v_rfq) = 2, 'EDIT + APPROVE recorded';
  ASSERT (SELECT approved_by FROM approvals WHERE rfq_id = v_rfq AND action = 'APPROVE') = 'Aisha Khan', 'who approved';

  RAISE NOTICE '9. delivery -> QUOTED -> AWAITING_CLIENT';
  r := of_record_outbound(jsonb_build_object('rfq_id', v_rfq, 'quote_id', v_new_quote, 'kind', 'QUOTE', 'channel', 'email', 'conversation_id', v_conv,
                                             'recipient', 'qa.agent@qa-agency.example', 'subject', 's', 'content', 'b2', 'delivery_status', 'SIMULATED'));
  ASSERT r->>'rfq_status' = 'AWAITING_CLIENT', 'awaiting client';
  ASSERT (SELECT status FROM quotes WHERE id = v_new_quote) = 'SENT', 'quote sent';
  ASSERT (SELECT first_response_at IS NOT NULL AND quoted_at IS NOT NULL FROM rfqs WHERE id = v_rfq), 'response timestamps';

  RAISE NOTICE '10. follow-up claim is idempotent';
  r := of_claim_followup(jsonb_build_object('rfq_id', v_rfq, 'quote_id', v_new_quote, 'sequence', 1, 'channel', 'email'));
  ASSERT (r->>'claimed')::boolean, 'first claim';
  ASSERT NOT (of_claim_followup(jsonb_build_object('rfq_id', v_rfq, 'quote_id', v_new_quote, 'sequence', 1))->>'claimed')::boolean, 'no double follow-up';

  RAISE NOTICE '11. client reply correlates by thread and selects option 2';
  r := of_register_inbound_message('{"channel":"email","external_message_id":"t-2","conversation_key":"t-thread-1","sender":{"email":"qa.agent@qa-agency.example"},"message":{"text":"Option 2 works. Please proceed."}}');
  r := of_claim_next_message(jsonb_build_object('conversation_id', v_conv, 'execution_id', 'exec-C'));
  ASSERT r->'active_rfq'->>'id' = v_rfq::text AND r->'active_rfq'->>'correlation' = 'SAME_CONVERSATION', 'correlated';
  ASSERT jsonb_array_length(r->'quote_options') = 2, 'quoted options returned';
  v_msg := (r->'message'->>'id')::uuid;
  r := of_record_client_decision(jsonb_build_object('rfq_id', v_rfq, 'message_id', v_msg, 'action', 'SELECT_OPTION', 'selected_option_code', 'OPT-002',
                                                    'needs_confirmation', false, 'client_message', 'Option 2 works. Please proceed.'));
  ASSERT r->>'result' = 'BOOKING_REQUESTED', 'booking requested';
  ASSERT r->'handoff'->'selected_option'->>'airline' = 'Emirates', 'handoff summary';
  ASSERT (SELECT status FROM rfqs WHERE id = v_rfq) = 'BOOKING_REQUESTED', 'status';
  PERFORM of_complete_message(jsonb_build_object('message_id', v_msg));

  RAISE NOTICE '12. no follow-ups once booking is requested';
  ASSERT NOT EXISTS (SELECT 1 FROM jsonb_array_elements(of_followup_candidates('{}')) c WHERE c->>'rfq_id' = v_rfq::text), 'excluded from candidates';

  RAISE NOTICE '13. after-sales: change request finds the ticketed booking by PNR';
  INSERT INTO rfqs (rfq_number, agency_id, contact_id, intent, status, departure_date, booking_reference, source_channel)
  VALUES ('OFF-RFQ-1999-000001', (SELECT agency_id FROM contacts WHERE id = v_john), v_john, 'NEW_QUOTE', 'TICKETED', current_date + 1, 'T3ST01', 'email');
  r := of_register_inbound_message('{"channel":"email","external_message_id":"t-3","conversation_key":"t-thread-2","sender":{"email":"qa.agent@qa-agency.example"},"message":{"text":"I need to change tomorrow''s flight, PNR T3ST01."}}');
  r := of_create_after_sales_case(jsonb_build_object('intent', 'CHANGE_REQUEST', 'contact_id', v_john, 'agency_id', (SELECT agency_id FROM contacts WHERE id = v_john),
                                                     'message_id', r->>'message_id', 'booking_reference', 'T3ST01', 'travel_date', (current_date + 1)::text, 'summary', 'Change tomorrow''s flight', 'channel', 'email'));
  ASSERT NOT (r->>'created')::boolean AND r->>'status' = 'CHANGE_REQUESTED' AND r->>'booking_reference' = 'T3ST01', 'existing booking moved to CHANGE_REQUESTED';
  r := of_create_after_sales_case(jsonb_build_object('intent', 'CANCELLATION', 'contact_id', v_john, 'agency_id', (SELECT agency_id FROM contacts WHERE id = v_john),
                                                     'message_id', r->>'message_id', 'booking_reference', 'ZZZ999', 'summary', 'cancel ZZZ999', 'channel', 'email'));
  ASSERT (r->>'created')::boolean AND r->>'status' = 'REFUND_REQUESTED', 'unknown booking -> new after-sales case for a human';

  RAISE NOTICE '14. SLA breach alerts are deduplicated';
  r := of_record_sla_breaches(jsonb_build_object('breaches', jsonb_build_array(jsonb_build_object('rfq_id', v_rfq, 'status', 'BOOKING_REQUESTED', 'minutes_in_status', 9, 'threshold_minutes', 5, 'dedupe_key', 'SLA:test'))));
  ASSERT jsonb_array_length(r->'new_alerts') = 1, 'first alert';
  r := of_record_sla_breaches(jsonb_build_object('breaches', jsonb_build_array(jsonb_build_object('rfq_id', v_rfq, 'status', 'BOOKING_REQUESTED', 'minutes_in_status', 12, 'threshold_minutes', 5, 'dedupe_key', 'SLA:test'))));
  ASSERT jsonb_array_length(r->'new_alerts') = 0, 'no duplicate alert';
  ASSERT (SELECT sla_breached FROM rfqs WHERE id = v_rfq), 'flag stored';

  RAISE NOTICE '15. workflow error -> retry with backoff -> dead letter after 3 attempts';
  r := of_register_inbound_message('{"channel":"whatsapp","external_message_id":"wamid.t4","conversation_key":"447700900199","sender":{"phone":"447700900199"},"message":{"text":"hello"}}');
  v_conv := (r->>'conversation_id')::uuid;
  FOR i IN 1..3 LOOP
    UPDATE messages SET processing_status = 'PENDING' WHERE external_message_id = 'wamid.t4';
    UPDATE conversations SET locked_until = NULL WHERE id = v_conv;
    PERFORM of_claim_next_message(jsonb_build_object('conversation_id', v_conv, 'execution_id', 'exec-err-' || i));
    r := of_record_workflow_error(jsonb_build_object('workflow_name', 'WF06_RFQ_MANAGER', 'execution_id', 'exec-err-' || i, 'node', 'Classify', 'error_message', 'OpenAI timeout'));
  END LOOP;
  ASSERT (r->>'dead_letter')::boolean, 'dead letter after 3 failures';
  ASSERT (SELECT processing_status FROM messages WHERE external_message_id = 'wamid.t4') = 'DEAD_LETTER', 'status DEAD_LETTER';
  ASSERT (SELECT locked_until IS NULL FROM conversations WHERE id = v_conv), 'lock released';

  RAISE NOTICE '16. WhatsApp delivery receipts only move forward';
  INSERT INTO messages (conversation_id, rfq_id, channel, direction, external_message_id, content, kind, processing_status, delivery_status)
  VALUES (v_conv, v_rfq, 'whatsapp', 'OUTBOUND', 'wamid.out1', 'x', 'ACK', 'SENT', 'SENT');
  PERFORM of_update_delivery_status('{"statuses":[{"external_message_id":"wamid.out1","status":"READ"}]}');
  PERFORM of_update_delivery_status('{"statuses":[{"external_message_id":"wamid.out1","status":"DELIVERED"}]}');
  ASSERT (SELECT delivery_status FROM messages WHERE external_message_id = 'wamid.out1') = 'READ', 'no regression READ -> DELIVERED';

  RAISE NOTICE '17. knowledge base search';
  ASSERT jsonb_array_length(of_kb_search('{"text":"what are your opening hours on weekend"}')) >= 1, 'kb hit';

  RAISE NOTICE 'ALL SQL API TESTS PASSED';
END $$;

ROLLBACK;
