-- =============================================================================
-- Offshore Fares — transactional API used by the n8n workflows
--
-- Convention: every API function takes ONE jsonb argument and returns jsonb.
-- n8n calls them with:  SELECT of_xxx($1::jsonb) AS r;
-- Expected business refusals return {"ok": false, "error": "..."}; integrity
-- violations (e.g. an illegal status transition) RAISE and roll back.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Internal helpers
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION of_audit(p_rfq uuid, p_entity_type text, p_entity_id text, p_action text,
                                    p_actor_type text, p_actor_id text, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO audit_logs (rfq_id, entity_type, entity_id, action, actor_type, actor_id, metadata)
  VALUES (p_rfq, p_entity_type, p_entity_id, p_action, p_actor_type, p_actor_id, coalesce(p_meta, '{}'::jsonb));
$$;

CREATE OR REPLACE FUNCTION of_event(p jsonb, p_event text, p_status text DEFAULT 'OK', p_rfq uuid DEFAULT NULL,
                                    p_conv uuid DEFAULT NULL, p_msg uuid DEFAULT NULL, p_details jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO workflow_events (workflow, execution_id, rfq_id, conversation_id, message_id, event, status, duration_ms, details)
  VALUES (coalesce(p->>'workflow', 'unknown'), p->>'execution_id', p_rfq, p_conv, p_msg, p_event, p_status,
          CASE WHEN p ? 'started_at' THEN (extract(epoch FROM now() - (p->>'started_at')::timestamptz) * 1000)::int END,
          coalesce(p_details, '{}'::jsonb));
$$;

CREATE OR REPLACE FUNCTION of_next_rfq_number() RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_year int := extract(year FROM now() AT TIME ZONE 'UTC')::int;
  v_next int;
BEGIN
  INSERT INTO rfq_counters (year, last_value) VALUES (v_year, 1)
  ON CONFLICT (year) DO UPDATE SET last_value = rfq_counters.last_value + 1
  RETURNING last_value INTO v_next;
  RETURN format('OFF-RFQ-%s-%s', v_year, lpad(v_next::text, 6, '0'));
END $$;

CREATE OR REPLACE FUNCTION of_alert(p_rfq uuid, p_type text, p_severity text, p_desk text, p_title text,
                                    p_details jsonb DEFAULT '{}'::jsonb, p_dedupe text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO alerts (rfq_id, alert_type, severity, desk_code, title, details, dedupe_key)
  VALUES (p_rfq, p_type, p_severity, p_desk, p_title, coalesce(p_details, '{}'::jsonb), p_dedupe)
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- State machine enforcement. Same-status calls are no-ops.
CREATE OR REPLACE FUNCTION of_transition_rfq(p_rfq uuid, p_to text, p_actor_type text, p_actor_id text, p_reason text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_from text;
BEGIN
  SELECT status INTO v_from FROM rfqs WHERE id = p_rfq FOR UPDATE;
  IF v_from IS NULL THEN RAISE EXCEPTION 'RFQ_NOT_FOUND: %', p_rfq; END IF;
  IF v_from = p_to THEN RETURN v_from; END IF;
  IF NOT EXISTS (SELECT 1 FROM rfq_status_transitions WHERE from_status = v_from AND to_status = p_to) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: % -> %', v_from, p_to USING ERRCODE = 'P0001';
  END IF;
  UPDATE rfqs SET status = p_to, status_changed_at = now(), updated_at = now(),
         closed_at = CASE WHEN p_to IN ('CLOSED', 'CANCELLED', 'LOST') THEN now() ELSE closed_at END,
         quoted_at = CASE WHEN p_to = 'QUOTED' THEN coalesce(quoted_at, now()) ELSE quoted_at END,
         booking_requested_at = CASE WHEN p_to = 'BOOKING_REQUESTED' THEN now() ELSE booking_requested_at END,
         clarification_due_at = CASE WHEN p_to = 'NEEDS_INFORMATION' THEN clarification_due_at ELSE NULL END
   WHERE id = p_rfq;
  INSERT INTO rfq_status_history (rfq_id, from_status, to_status, actor_type, actor_id, reason)
  VALUES (p_rfq, v_from, p_to, p_actor_type, p_actor_id, p_reason);
  PERFORM of_audit(p_rfq, 'rfq', p_rfq::text, 'STATUS_CHANGED', p_actor_type, p_actor_id,
                   jsonb_build_object('from', v_from, 'to', p_to, 'reason', p_reason));
  RETURN v_from;
END $$;

-- Walk a sequence of statuses (skipping those already passed), e.g. ASSIGNED -> SEARCHING -> FARES_FOUND.
CREATE OR REPLACE FUNCTION of_transition_path(p_rfq uuid, p_path text[], p_actor_type text, p_actor_id text, p_reason text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_status text; v_idx int; i int;
BEGIN
  SELECT status INTO v_status FROM rfqs WHERE id = p_rfq FOR UPDATE;
  v_idx := array_position(p_path, v_status);
  FOR i IN coalesce(v_idx + 1, 1) .. array_length(p_path, 1) LOOP
    PERFORM of_transition_rfq(p_rfq, p_path[i], p_actor_type, p_actor_id, p_reason);
  END LOOP;
  RETURN p_path[array_length(p_path, 1)];
END $$;

CREATE OR REPLACE FUNCTION of_is_open(p_status text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_status NOT IN ('CANCELLED', 'LOST', 'CLOSED');
$$;

-- Active fare options of an RFQ in the shape expected by lib/fares.js and lib/quote.js
CREATE OR REPLACE FUNCTION of_active_options(p_rfq uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', f.id, 'option_no', f.option_no, 'option_code', f.option_code, 'airline', f.airline,
           'flight_segments', f.flight_segments,
           'departure_at', to_char(f.departure_at, 'YYYY-MM-DD"T"HH24:MI'),
           'arrival_at', to_char(f.arrival_at, 'YYYY-MM-DD"T"HH24:MI'),
           'return_departure_at', to_char(f.return_departure_at, 'YYYY-MM-DD"T"HH24:MI'),
           'total_duration_minutes', f.total_duration_minutes, 'stops', f.stops, 'cabin', f.cabin,
           'fare', jsonb_build_object('amount', f.fare_amount, 'currency', f.fare_currency),
           'fare_amount', f.fare_amount, 'fare_currency', f.fare_currency, 'fare_basis', f.fare_basis,
           'baggage', f.baggage, 'change_penalty', f.change_penalty, 'refund_penalty', f.refund_penalty,
           'fare_valid_until', to_char(f.fare_valid_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'expired', f.fare_valid_until <= now(), 'source', f.source, 'verified', f.verified, 'batch_no', f.batch_no
         ) ORDER BY f.option_no), '[]'::jsonb)
    FROM fare_options f WHERE f.rfq_id = p_rfq AND f.is_active;
$$;

CREATE OR REPLACE FUNCTION of_rfq_snapshot(p_rfq uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'id', r.id, 'rfq_number', r.rfq_number, 'status', r.status, 'intent', r.intent, 'trip_type', r.trip_type,
    'cabin', r.cabin, 'origin_iata', r.origin_iata, 'destination_iata', r.destination_iata,
    'departure_date', r.departure_date, 'return_date', r.return_date,
    'requirements', r.requirements, 'missing_fields', to_jsonb(r.missing_fields),
    'priority_score', r.priority_score, 'priority_level', r.priority_level,
    'assigned_team', r.assigned_team, 'source_channel', r.source_channel,
    'requires_human', r.requires_human, 'conversation_id', r.conversation_id,
    'contact_id', r.contact_id, 'agency_id', r.agency_id, 'booking_reference', r.booking_reference,
    'status_changed_at', r.status_changed_at, 'updated_at', r.updated_at,
    'contact', (SELECT jsonb_build_object('id', c.id, 'first_name', c.first_name, 'last_name', c.last_name, 'email', c.email,
                                          'whatsapp_phone', c.whatsapp_phone, 'preferred_channel', c.preferred_channel,
                                          'opted_out_followups', c.opted_out_followups, 'verification_status', c.verification_status)
                  FROM contacts c WHERE c.id = r.contact_id),
    'agency', (SELECT jsonb_build_object('id', a.id, 'name', a.name, 'code', a.code, 'priority_level', a.priority_level, 'status', a.status)
                 FROM agencies a WHERE a.id = r.agency_id)
  ) FROM rfqs r WHERE r.id = p_rfq;
$$;

-- -----------------------------------------------------------------------------
-- WF01 / WF02 — idempotent intake
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION of_register_inbound_message(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_channel text := p->>'channel';
  v_ext text := nullif(p->>'external_message_id', '');
  v_key text := nullif(p->>'conversation_key', '');
  v_email text := lower(nullif(p->'sender'->>'email', ''));
  v_phone text := nullif(regexp_replace(coalesce(p->'sender'->>'phone', ''), '\D', '', 'g'), '');
  v_name text := nullif(trim(p->'sender'->>'name'), '');
  v_contact contacts%ROWTYPE;
  v_agency uuid;
  v_conv uuid;
  v_msg uuid;
  v_existing uuid;
  v_received timestamptz := coalesce((p->'message'->>'received_at')::timestamptz, now());
BEGIN
  IF v_channel NOT IN ('email', 'whatsapp') OR v_ext IS NULL OR v_key IS NULL OR (v_email IS NULL AND v_phone IS NULL) THEN
    PERFORM of_event(p, 'MALFORMED_MESSAGE', 'ERROR', NULL, NULL, NULL, jsonb_build_object('channel', v_channel, 'external_message_id', v_ext));
    RETURN jsonb_build_object('ok', false, 'status', 'REJECTED', 'error', 'MALFORMED_MESSAGE');
  END IF;

  SELECT id INTO v_existing FROM messages WHERE channel = v_channel AND external_message_id = v_ext AND direction = 'INBOUND';
  IF v_existing IS NOT NULL THEN
    PERFORM of_event(p, 'DUPLICATE_IGNORED', 'SKIPPED', NULL, NULL, v_existing, jsonb_build_object('external_message_id', v_ext));
    RETURN jsonb_build_object('ok', true, 'status', 'DUPLICATE', 'message_id', v_existing);
  END IF;

  -- Identify the travel agent and the agency
  IF v_email IS NOT NULL THEN SELECT * INTO v_contact FROM contacts WHERE lower(email) = v_email; END IF;
  IF v_contact.id IS NULL AND v_phone IS NOT NULL THEN
    SELECT * INTO v_contact FROM contacts
     WHERE whatsapp_phone = v_phone OR regexp_replace(coalesce(phone, ''), '\D', '', 'g') = v_phone
     ORDER BY (whatsapp_phone = v_phone) DESC LIMIT 1;
  END IF;
  IF v_contact.id IS NULL THEN
    IF v_email IS NOT NULL THEN SELECT id INTO v_agency FROM agencies WHERE email_domain = split_part(v_email, '@', 2); END IF;
    INSERT INTO contacts (agency_id, first_name, last_name, email, whatsapp_phone, preferred_channel, verification_status)
    VALUES (v_agency, split_part(coalesce(v_name, ''), ' ', 1),
            nullif(trim(substr(coalesce(v_name, ''), length(split_part(coalesce(v_name, ''), ' ', 1)) + 1)), ''),
            v_email, CASE WHEN v_channel = 'whatsapp' THEN v_phone END, v_channel, 'UNVERIFIED')
    ON CONFLICT DO NOTHING
    RETURNING * INTO v_contact;
    IF v_contact.id IS NULL THEN
      SELECT * INTO v_contact FROM contacts WHERE lower(email) = v_email OR whatsapp_phone = v_phone LIMIT 1;
    ELSE
      PERFORM of_audit(NULL, 'contact', v_contact.id::text, 'CONTACT_CREATED_UNVERIFIED', 'SYSTEM', p->>'workflow',
                       jsonb_build_object('channel', v_channel, 'agency_matched_by_domain', v_agency IS NOT NULL));
    END IF;
  END IF;
  v_agency := coalesce(v_contact.agency_id, v_agency);

  INSERT INTO conversations (channel, external_thread_id, contact_id, agency_id, subject, last_inbound_at)
  VALUES (v_channel, v_key, v_contact.id, v_agency, p->'message'->>'subject', v_received)
  ON CONFLICT (channel, external_thread_id) DO UPDATE
    SET last_inbound_at = greatest(conversations.last_inbound_at, excluded.last_inbound_at),
        contact_id = coalesce(conversations.contact_id, excluded.contact_id),
        agency_id = coalesce(conversations.agency_id, excluded.agency_id),
        subject = coalesce(conversations.subject, excluded.subject),
        updated_at = now()
  RETURNING id INTO v_conv;

  INSERT INTO messages (conversation_id, channel, direction, external_message_id, sender, recipient, subject, content, content_raw,
                        in_reply_to, attachments, referenced_rfq_numbers, security_flags, received_at, processing_status)
  VALUES (v_conv, v_channel, 'INBOUND', v_ext, coalesce(v_email, v_phone), p->>'recipient', p->'message'->>'subject',
          coalesce(p->'message'->>'text', ''), p->'message'->>'text_raw', p->>'in_reply_to',
          coalesce(p->'attachments', '[]'::jsonb),
          ARRAY(SELECT jsonb_array_elements_text(coalesce(p->'referenced_rfq_numbers', '[]'::jsonb))),
          ARRAY(SELECT jsonb_array_elements_text(coalesce(p->'security'->'signals', '[]'::jsonb))),
          v_received, 'PENDING')
  ON CONFLICT (channel, external_message_id) WHERE direction = 'INBOUND' DO NOTHING
  RETURNING id INTO v_msg;

  IF v_msg IS NULL THEN  -- lost a race with an identical webhook delivery
    SELECT id INTO v_existing FROM messages WHERE channel = v_channel AND external_message_id = v_ext AND direction = 'INBOUND';
    PERFORM of_event(p, 'DUPLICATE_IGNORED', 'SKIPPED', NULL, v_conv, v_existing, '{}'::jsonb);
    RETURN jsonb_build_object('ok', true, 'status', 'DUPLICATE', 'message_id', v_existing);
  END IF;

  PERFORM of_audit(NULL, 'message', v_msg::text, 'MESSAGE_RECEIVED', 'CLIENT', coalesce(v_email, v_phone),
                   jsonb_build_object('channel', v_channel, 'conversation_id', v_conv, 'subject', p->'message'->>'subject',
                                      'security_flags', coalesce(p->'security'->'signals', '[]'::jsonb)));
  PERFORM of_event(p, 'MESSAGE_REGISTERED', 'OK', NULL, v_conv, v_msg, jsonb_build_object('channel', v_channel));
  RETURN jsonb_build_object('ok', true, 'status', 'REGISTERED', 'message_id', v_msg, 'conversation_id', v_conv,
                            'contact_id', v_contact.id, 'agency_id', v_agency,
                            'contact_verified', coalesce(v_contact.verification_status, 'UNVERIFIED') = 'VERIFIED');
END $$;

-- WhatsApp delivery receipts (sent / delivered / read / failed)
CREATE OR REPLACE FUNCTION of_update_delivery_status(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE s jsonb; v_count int := 0; v_rank jsonb := '{"SIMULATED":0,"SENT":1,"DELIVERED":2,"READ":3}'::jsonb; v_id uuid;
BEGIN
  FOR s IN SELECT * FROM jsonb_array_elements(coalesce(p->'statuses', '[]'::jsonb)) LOOP
    UPDATE messages m SET delivery_status = s->>'status',
           delivery_error = CASE WHEN s->>'status' = 'FAILED' THEN left((s->'errors')::text, 500) ELSE m.delivery_error END
     WHERE m.direction = 'OUTBOUND' AND m.external_message_id = s->>'external_message_id'
       AND s->>'status' IN ('SENT', 'DELIVERED', 'READ', 'FAILED')
       AND (s->>'status' = 'FAILED' OR coalesce((v_rank->>m.delivery_status)::int, -1) < (v_rank->>(s->>'status'))::int)
    RETURNING m.id INTO v_id;
    IF v_id IS NOT NULL THEN
      v_count := v_count + 1;
      UPDATE quotes q SET delivery_status = s->>'status'
        FROM messages m WHERE m.id = v_id AND m.kind = 'QUOTE' AND q.rfq_id = m.rfq_id AND q.status = 'SENT';
      IF s->>'status' = 'FAILED' THEN
        PERFORM of_alert((SELECT rfq_id FROM messages WHERE id = v_id), 'DELIVERY_FAILED', 'WARNING', NULL,
                         'WhatsApp message could not be delivered', jsonb_build_object('errors', s->'errors'), 'DELIVERY:' || (s->>'external_message_id'));
      END IF;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'updated', v_count);
END $$;

-- -----------------------------------------------------------------------------
-- WF06 — message processing (per-conversation lock, ordered processing)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION of_claim_next_message(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_conv conversations%ROWTYPE;
  v_msg messages%ROWTYPE;
  v_exec text := coalesce(p->>'execution_id', 'manual');
  v_window interval := make_interval(hours => coalesce((p->>'correlation_hours')::int, 72));
  v_rfq rfqs%ROWTYPE;
  v_link text := NULL;
  v_quote jsonb := NULL;
  v_options jsonb := '[]'::jsonb;
BEGIN
  UPDATE conversations SET locked_until = now() + interval '3 minutes', locked_by = v_exec
   WHERE id = (p->>'conversation_id')::uuid AND (locked_until IS NULL OR locked_until < now() OR locked_by = v_exec)
  RETURNING * INTO v_conv;
  IF v_conv.id IS NULL THEN RETURN jsonb_build_object('claimed', false, 'reason', 'LOCKED_OR_UNKNOWN'); END IF;

  SELECT * INTO v_msg FROM messages
   WHERE conversation_id = v_conv.id AND direction = 'INBOUND' AND processing_status = 'PENDING'
   ORDER BY coalesce(received_at, created_at), created_at
   LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF v_msg.id IS NULL THEN
    UPDATE conversations SET locked_until = NULL, locked_by = NULL WHERE id = v_conv.id;
    RETURN jsonb_build_object('claimed', false, 'reason', 'NO_PENDING_MESSAGE');
  END IF;
  UPDATE messages SET processing_status = 'PROCESSING', processing_execution_id = v_exec, processing_started_at = now()
   WHERE id = v_msg.id;

  -- Conversation correlation: 1) RFQ number quoted in the message, 2) open RFQ of this conversation,
  -- 3) the contact's single open RFQ on another channel (cross-channel replies).
  SELECT r.* INTO v_rfq FROM rfqs r
   WHERE r.rfq_number = ANY (v_msg.referenced_rfq_numbers)
     AND (r.contact_id = v_conv.contact_id OR (r.agency_id IS NOT NULL AND r.agency_id = v_conv.agency_id))
     AND of_is_open(r.status)
   ORDER BY r.updated_at DESC LIMIT 1;
  IF v_rfq.id IS NOT NULL THEN v_link := 'RFQ_NUMBER_IN_MESSAGE'; END IF;
  IF v_rfq.id IS NULL THEN
    -- Several open RFQs in one conversation: a reply-like message ("option 2", "go ahead", "too expensive")
    -- goes to the RFQ whose quote is awaiting an answer; anything else to the most recently active RFQ.
    SELECT r.* INTO v_rfq FROM rfqs r
     WHERE r.conversation_id = v_conv.id AND of_is_open(r.status)
       AND r.status NOT IN ('TICKETED', 'CHANGE_REQUESTED', 'REFUND_REQUESTED', 'ERROR')
       AND r.updated_at > now() - v_window
     ORDER BY CASE WHEN r.status IN ('QUOTED', 'AWAITING_CLIENT', 'CLIENT_INTERESTED')
                    AND v_msg.content ~* '\m(option|opt|proceed|go ahead|book|hold|cheaper|expensive|confirm|first one|second one|third one|works|yes|ok|okay)\M'
                   THEN 0 ELSE 1 END,
              r.updated_at DESC
     LIMIT 1;
    IF v_rfq.id IS NOT NULL THEN v_link := 'SAME_CONVERSATION'; END IF;
  END IF;
  IF v_rfq.id IS NULL AND v_conv.contact_id IS NOT NULL THEN
    IF (SELECT count(*) FROM rfqs r WHERE r.contact_id = v_conv.contact_id
          AND r.status IN ('NEEDS_INFORMATION', 'QUOTED', 'AWAITING_CLIENT', 'CLIENT_INTERESTED')
          AND r.updated_at > now() - v_window) = 1 THEN
      SELECT r.* INTO v_rfq FROM rfqs r WHERE r.contact_id = v_conv.contact_id
         AND r.status IN ('NEEDS_INFORMATION', 'QUOTED', 'AWAITING_CLIENT', 'CLIENT_INTERESTED')
         AND r.updated_at > now() - v_window;
      v_link := 'CONTACT_SINGLE_OPEN_RFQ';
    END IF;
  END IF;

  IF v_rfq.id IS NOT NULL AND v_rfq.status IN ('QUOTED', 'AWAITING_CLIENT', 'CLIENT_INTERESTED') THEN
    SELECT jsonb_build_object('id', q.id, 'version', q.version, 'sent_at', q.sent_at, 'valid_until', q.valid_until)
      INTO v_quote FROM quotes q WHERE q.rfq_id = v_rfq.id AND q.status = 'SENT' ORDER BY q.version DESC LIMIT 1;
    v_options := of_active_options(v_rfq.id);
  END IF;

  PERFORM of_event(p, 'MESSAGE_CLAIMED', 'OK', v_rfq.id, v_conv.id, v_msg.id, jsonb_build_object('correlation', v_link));
  RETURN jsonb_build_object(
    'claimed', true,
    'message', jsonb_build_object('id', v_msg.id, 'channel', v_msg.channel, 'external_message_id', v_msg.external_message_id,
                                  'subject', v_msg.subject, 'text', v_msg.content, 'received_at', v_msg.received_at,
                                  'sender', v_msg.sender, 'security_flags', to_jsonb(v_msg.security_flags),
                                  'referenced_rfq_numbers', to_jsonb(v_msg.referenced_rfq_numbers)),
    'conversation', jsonb_build_object('id', v_conv.id, 'channel', v_conv.channel, 'external_thread_id', v_conv.external_thread_id, 'subject', v_conv.subject),
    'contact', (SELECT jsonb_build_object('id', c.id, 'first_name', c.first_name, 'last_name', c.last_name, 'email', c.email,
                                          'whatsapp_phone', c.whatsapp_phone, 'verification_status', c.verification_status,
                                          'opted_out_followups', c.opted_out_followups)
                  FROM contacts c WHERE c.id = v_conv.contact_id),
    'agency', (SELECT jsonb_build_object('id', a.id, 'name', a.name, 'priority_level', a.priority_level, 'status', a.status)
                 FROM agencies a WHERE a.id = v_conv.agency_id),
    'active_rfq', CASE WHEN v_rfq.id IS NULL THEN NULL ELSE of_rfq_snapshot(v_rfq.id) || jsonb_build_object('correlation', v_link) END,
    'quote', v_quote,
    'quote_options', v_options,
    'history', (SELECT coalesce(jsonb_agg(h ORDER BY h.at), '[]'::jsonb) FROM (
                  SELECT m.direction, left(m.content, 400) AS text, coalesce(m.received_at, m.sent_at, m.created_at) AS at
                    FROM messages m WHERE m.conversation_id = v_conv.id AND m.id <> v_msg.id
                   ORDER BY coalesce(m.received_at, m.sent_at, m.created_at) DESC LIMIT 6) h)
  );
END $$;

CREATE OR REPLACE FUNCTION of_complete_message(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_msg messages%ROWTYPE; v_more int;
BEGIN
  UPDATE messages SET processing_status = coalesce(p->>'status', 'PROCESSED'), processed_at = now(),
         rfq_id = coalesce((p->>'rfq_id')::uuid, rfq_id),
         classification = coalesce(p->'classification', classification),
         processing_notes = coalesce(p->'notes', processing_notes)
   WHERE id = (p->>'message_id')::uuid
  RETURNING * INTO v_msg;
  IF v_msg.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'MESSAGE_NOT_FOUND'); END IF;
  UPDATE conversations SET locked_until = NULL, locked_by = NULL WHERE id = v_msg.conversation_id;
  SELECT count(*) INTO v_more FROM messages WHERE conversation_id = v_msg.conversation_id AND processing_status = 'PENDING' AND direction = 'INBOUND';
  PERFORM of_event(p, 'MESSAGE_PROCESSED', 'OK', v_msg.rfq_id, v_msg.conversation_id, v_msg.id,
                   jsonb_build_object('route', p->>'route', 'status', v_msg.processing_status));
  RETURN jsonb_build_object('ok', true, 'conversation_id', v_msg.conversation_id, 'has_more', v_more > 0);
END $$;

-- Scheduled sweeper: requeue failed messages (backoff), release stale locks, find orphan pending messages.
CREATE OR REPLACE FUNCTION of_sweep(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_requeued int; v_stale int;
BEGIN
  UPDATE messages SET processing_status = 'PENDING', next_retry_at = NULL
   WHERE processing_status = 'FAILED' AND retry_count < 3 AND next_retry_at <= now();
  GET DIAGNOSTICS v_requeued = ROW_COUNT;
  -- Processing that never finished (worker crash): back to PENDING
  UPDATE messages SET processing_status = 'PENDING', retry_count = retry_count + 1
   WHERE processing_status = 'PROCESSING' AND processing_started_at < now() - interval '5 minutes';
  GET DIAGNOSTICS v_stale = ROW_COUNT;
  UPDATE conversations SET locked_until = NULL, locked_by = NULL WHERE locked_until < now();
  RETURN jsonb_build_object('requeued', v_requeued, 'stale_recovered', v_stale,
    'conversations', (SELECT coalesce(jsonb_agg(DISTINCT m.conversation_id), '[]'::jsonb) FROM messages m
                        JOIN conversations c ON c.id = m.conversation_id
                       WHERE m.direction = 'INBOUND' AND m.processing_status = 'PENDING'
                         AND m.created_at < now() - interval '20 seconds'
                         AND (c.locked_until IS NULL OR c.locked_until < now())));
END $$;

-- Create a new RFQ or merge requirements into an existing one (request merging).
CREATE OR REPLACE FUNCTION of_upsert_rfq_from_message(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_rfq rfqs%ROWTYPE;
  v_req jsonb := coalesce(p->'requirements', '{}'::jsonb);
  v_ready boolean := coalesce((p->>'ready')::boolean, false);
  v_created boolean := false;
  v_prev text;
  v_target text;
  v_missing text[] := ARRAY(SELECT jsonb_array_elements_text(coalesce(v_req->'missing_fields', '[]'::jsonb)));
  v_debounce int := coalesce((p->>'debounce_seconds')::int, 0);
  v_allow_requote boolean := coalesce((p->>'allow_requote')::boolean, false);
BEGIN
  IF nullif(p->>'rfq_id', '') IS NULL THEN
    INSERT INTO rfqs (rfq_number, agency_id, contact_id, conversation_id, intent, status, source_channel)
    VALUES (of_next_rfq_number(), (p->>'agency_id')::uuid, (p->>'contact_id')::uuid, (p->>'conversation_id')::uuid,
            coalesce(v_req->>'intent', p->>'intent', 'NEW_QUOTE'), 'NEW', p->>'channel')
    RETURNING * INTO v_rfq;
    INSERT INTO rfq_status_history (rfq_id, from_status, to_status, actor_type, actor_id, reason)
    VALUES (v_rfq.id, NULL, 'NEW', 'SYSTEM', p->>'workflow', 'Created from inbound message');
    PERFORM of_audit(v_rfq.id, 'rfq', v_rfq.id::text, 'RFQ_CREATED', 'SYSTEM', p->>'workflow',
                     jsonb_build_object('rfq_number', v_rfq.rfq_number, 'channel', p->>'channel', 'message_id', p->>'message_id'));
    v_created := true;
  ELSE
    SELECT * INTO v_rfq FROM rfqs WHERE id = (p->>'rfq_id')::uuid FOR UPDATE;
    IF v_rfq.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'RFQ_NOT_FOUND'); END IF;
    IF NOT (v_rfq.status IN ('NEW', 'NEEDS_INFORMATION', 'READY_FOR_SEARCH', 'ASSIGNED', 'SEARCHING')
            OR (v_allow_requote AND v_rfq.status IN ('AWAITING_CLIENT', 'CLIENT_INTERESTED'))) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'RFQ_NOT_MERGEABLE', 'status', v_rfq.status, 'rfq_id', v_rfq.id);
    END IF;
  END IF;
  v_prev := v_rfq.status;

  UPDATE rfqs SET
    intent = CASE WHEN v_created OR p->>'intent' = 'GROUP_BOOKING' THEN coalesce(v_req->>'intent', p->>'intent', intent) ELSE intent END,
    trip_type = nullif(v_req->>'trip_type', ''),
    cabin = coalesce(nullif(v_req->>'cabin', ''), 'UNKNOWN'),
    origin_iata = v_req->'origin'->>'iata',
    destination_iata = v_req->'destination'->>'iata',
    departure_date = (v_req->>'departure_date')::date,
    return_date = (v_req->>'return_date')::date,
    adults = (v_req->'passengers'->>'adults')::int,
    children = coalesce((v_req->'passengers'->>'children')::int, 0),
    infants = coalesce((v_req->'passengers'->>'infants')::int, 0),
    preferred_airlines = ARRAY(SELECT jsonb_array_elements_text(coalesce(v_req->'preferred_airlines', '[]'::jsonb))),
    requirements = v_req,
    missing_fields = v_missing,
    classification = coalesce(p->'classification', classification),
    extraction_meta = coalesce(p->'extraction_meta', extraction_meta),
    requires_human = CASE WHEN coalesce((p->>'requires_human')::boolean, false) THEN true ELSE requires_human END,
    human_review_reason = coalesce(nullif(p->>'human_review_reason', ''), human_review_reason),
    security_flags = ARRAY(SELECT DISTINCT unnest(security_flags || ARRAY(SELECT jsonb_array_elements_text(coalesce(p->'security_flags', '[]'::jsonb))))),
    updated_at = now()
  WHERE id = v_rfq.id;

  DELETE FROM rfq_segments WHERE rfq_id = v_rfq.id;
  INSERT INTO rfq_segments (rfq_id, seq, origin_iata, destination_iata, departure_date)
  SELECT v_rfq.id, ord::int, s->'origin'->>'iata', s->'destination'->>'iata', (s->>'date')::date
    FROM jsonb_array_elements(coalesce(v_req->'segments', '[]'::jsonb)) WITH ORDINALITY AS t(s, ord);
  IF NOT EXISTS (SELECT 1 FROM rfq_segments WHERE rfq_id = v_rfq.id) AND v_req->'origin'->>'iata' IS NOT NULL THEN
    INSERT INTO rfq_segments (rfq_id, seq, origin_iata, destination_iata, departure_date)
    VALUES (v_rfq.id, 1, v_req->'origin'->>'iata', v_req->'destination'->>'iata', (v_req->>'departure_date')::date);
    IF v_req->>'return_date' IS NOT NULL THEN
      INSERT INTO rfq_segments (rfq_id, seq, origin_iata, destination_iata, departure_date)
      VALUES (v_rfq.id, 2, v_req->'destination'->>'iata', v_req->'origin'->>'iata', (v_req->>'return_date')::date);
    END IF;
  END IF;
  DELETE FROM rfq_passengers WHERE rfq_id = v_rfq.id;
  INSERT INTO rfq_passengers (rfq_id, pax_type, count)
  SELECT v_rfq.id, t.k, t.v FROM (VALUES ('ADT', (v_req->'passengers'->>'adults')::int),
                                         ('CHD', (v_req->'passengers'->>'children')::int),
                                         ('INF', (v_req->'passengers'->>'infants')::int)) AS t(k, v)
   WHERE t.v IS NOT NULL AND t.v > 0;

  IF p ? 'message_id' THEN UPDATE messages SET rfq_id = v_rfq.id WHERE id = (p->>'message_id')::uuid; END IF;
  IF jsonb_array_length(coalesce(p->'security_flags', '[]'::jsonb)) > 0 THEN
    PERFORM of_alert(v_rfq.id, 'SECURITY', 'WARNING', 'GENERAL_DESK', v_rfq.rfq_number || ': message contained instruction-override content (treated as data)',
                     jsonb_build_object('signals', p->'security_flags', 'message_id', p->>'message_id'), 'SEC:' || coalesce(p->>'message_id', v_rfq.id::text));
  END IF;

  PERFORM of_audit(v_rfq.id, 'rfq', v_rfq.id::text, 'AI_CLASSIFIED', CASE WHEN p->'classification'->>'source' = 'rules' THEN 'SYSTEM' ELSE 'AI' END,
                   coalesce(p->'classification'->>'source', 'openai'), coalesce(p->'classification', '{}'::jsonb));
  PERFORM of_audit(v_rfq.id, 'rfq', v_rfq.id::text, 'REQUIREMENTS_EXTRACTED', CASE WHEN p->'extraction_meta'->>'source' = 'rules' THEN 'SYSTEM' ELSE 'AI' END,
                   coalesce(p->'extraction_meta'->>'source', 'openai'),
                   jsonb_build_object('summary', p->>'summary', 'missing_fields', to_jsonb(v_missing), 'ready', v_ready,
                                      'changes', coalesce(p->'changes', '[]'::jsonb), 'report', coalesce(p->'extraction_meta'->'report', '[]'::jsonb)));
  IF NOT v_created THEN
    PERFORM of_audit(v_rfq.id, 'rfq', v_rfq.id::text, 'RFQ_UPDATED', 'CLIENT', p->>'message_id',
                     jsonb_build_object('changes', coalesce(p->'changes', '[]'::jsonb), 'message_id', p->>'message_id'));
  END IF;

  -- Status decision
  v_target := CASE WHEN v_ready THEN 'READY_FOR_SEARCH' ELSE 'NEEDS_INFORMATION' END;
  IF v_prev IN ('NEW', 'NEEDS_INFORMATION', 'AWAITING_CLIENT', 'CLIENT_INTERESTED') THEN
    PERFORM of_transition_rfq(v_rfq.id, v_target, 'SYSTEM', p->>'workflow',
                              CASE WHEN v_ready THEN 'All mandatory information present' ELSE 'Missing: ' || array_to_string(v_missing, ', ') END);
  ELSIF NOT v_ready THEN
    PERFORM of_transition_rfq(v_rfq.id, 'NEEDS_INFORMATION', 'SYSTEM', p->>'workflow', 'Missing: ' || array_to_string(v_missing, ', '));
  ELSIF v_prev IN ('ASSIGNED', 'SEARCHING') AND jsonb_array_length(coalesce(p->'changes', '[]'::jsonb)) > 0 THEN
    PERFORM of_alert(v_rfq.id, 'DESK_NOTIFICATION', 'WARNING', v_rfq.assigned_team,
                     v_rfq.rfq_number || ': agent updated the request while you are searching',
                     jsonb_build_object('changes', p->'changes', 'summary', p->>'summary'), NULL);
  END IF;
  IF v_prev IN ('AWAITING_CLIENT', 'CLIENT_INTERESTED') THEN
    UPDATE rfqs SET selected_option_id = NULL, requires_fare_recheck = false WHERE id = v_rfq.id;
  END IF;

  UPDATE rfqs SET clarification_due_at = CASE WHEN status = 'NEEDS_INFORMATION' THEN now() + make_interval(secs => v_debounce) ELSE NULL END
   WHERE id = v_rfq.id
  RETURNING * INTO v_rfq;

  PERFORM of_event(p, CASE WHEN v_created THEN 'RFQ_CREATED' ELSE 'RFQ_UPDATED' END, 'OK', v_rfq.id, (p->>'conversation_id')::uuid,
                   (p->>'message_id')::uuid, jsonb_build_object('status', v_rfq.status, 'ready', v_ready));
  RETURN jsonb_build_object('ok', true, 'rfq_id', v_rfq.id, 'rfq_number', v_rfq.rfq_number, 'status', v_rfq.status,
                            'previous_status', CASE WHEN v_created THEN NULL ELSE v_prev END, 'created', v_created,
                            'became_ready', v_rfq.status = 'READY_FOR_SEARCH' AND coalesce(v_prev, 'NEW') <> 'READY_FOR_SEARCH',
                            'assigned_team', v_rfq.assigned_team, 'snapshot', of_rfq_snapshot(v_rfq.id));
END $$;

-- -----------------------------------------------------------------------------
-- WF07 / WF09 — priority and assignment
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION of_save_priority(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_rfq rfqs%ROWTYPE;
BEGIN
  UPDATE rfqs SET priority_score = (p->>'score')::int, priority_level = p->>'level', priority_breakdown = p->'breakdown', updated_at = now()
   WHERE id = (p->>'rfq_id')::uuid RETURNING * INTO v_rfq;
  IF v_rfq.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'RFQ_NOT_FOUND'); END IF;
  PERFORM of_audit(v_rfq.id, 'rfq', v_rfq.id::text, 'PRIORITY_CALCULATED', 'SYSTEM', 'WF07_PRIORITY_ENGINE',
                   jsonb_build_object('score', v_rfq.priority_score, 'level', v_rfq.priority_level, 'breakdown', p->'breakdown',
                                      'hours_to_departure', p->'hours_to_departure'));
  RETURN jsonb_build_object('ok', true, 'rfq_id', v_rfq.id, 'score', v_rfq.priority_score, 'level', v_rfq.priority_level, 'status', v_rfq.status);
END $$;

CREATE OR REPLACE FUNCTION of_assign_rfq(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_rfq rfqs%ROWTYPE;
  v_desk desks%ROWTYPE;
  v_op record;
  v_assignment uuid;
  v_current assignments%ROWTYPE;
BEGIN
  SELECT * INTO v_rfq FROM rfqs WHERE id = (p->>'rfq_id')::uuid FOR UPDATE;
  SELECT * INTO v_desk FROM desks WHERE code = p->>'desk_code' AND is_active;
  IF v_rfq.id IS NULL OR v_desk.code IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'RFQ_OR_DESK_NOT_FOUND'); END IF;

  SELECT * INTO v_current FROM assignments WHERE rfq_id = v_rfq.id AND is_current;
  IF v_current.id IS NOT NULL AND v_current.desk_code = v_desk.code THEN
    v_assignment := v_current.id;
    SELECT id, full_name INTO v_op FROM operators WHERE id = v_current.operator_id;
  ELSE
    SELECT o.id, o.full_name INTO v_op
      FROM operators o
      LEFT JOIN assignments a ON a.operator_id = o.id AND a.is_current
      LEFT JOIN rfqs r ON r.id = a.rfq_id AND of_is_open(r.status)
     WHERE o.desk_code = v_desk.code AND o.is_active
     GROUP BY o.id, o.full_name
     ORDER BY count(r.id), o.full_name
     LIMIT 1;
    UPDATE assignments SET is_current = false, unassigned_at = now() WHERE rfq_id = v_rfq.id AND is_current;
    INSERT INTO assignments (rfq_id, desk_code, operator_id, rule, assigned_by)
    VALUES (v_rfq.id, v_desk.code, v_op.id, p->>'rule', coalesce(p->>'assigned_by', 'SYSTEM'))
    RETURNING id INTO v_assignment;
    UPDATE rfqs SET assigned_team = v_desk.code, assigned_user = v_op.id, updated_at = now() WHERE id = v_rfq.id;
    PERFORM of_audit(v_rfq.id, 'rfq', v_rfq.id::text, 'ASSIGNED', CASE WHEN p->>'assigned_by' IS NULL THEN 'SYSTEM' ELSE 'HUMAN' END,
                     coalesce(p->>'assigned_by', 'WF09_FARE_DESK_ROUTER'),
                     jsonb_build_object('desk', v_desk.code, 'operator', v_op.full_name, 'rule', p->>'rule'));
  END IF;

  IF v_rfq.status = 'READY_FOR_SEARCH' THEN
    PERFORM of_transition_rfq(v_rfq.id, 'ASSIGNED', 'SYSTEM', 'WF09_FARE_DESK_ROUTER', 'Routed to ' || v_desk.name);
  END IF;
  PERFORM of_alert(v_rfq.id, 'DESK_NOTIFICATION',
                   CASE v_rfq.priority_level WHEN 'CRITICAL' THEN 'CRITICAL' WHEN 'HIGH' THEN 'WARNING' ELSE 'INFO' END,
                   v_desk.code, coalesce(p->>'title', v_rfq.rfq_number || ' assigned to ' || v_desk.name),
                   jsonb_build_object('operator', v_op.full_name, 'priority', v_rfq.priority_level, 'note', p->>'note', 'handoff', p->'handoff'),
                   'ASSIGN:' || v_assignment::text || ':' || coalesce(p->>'reason_key', v_rfq.status));
  RETURN jsonb_build_object('ok', true, 'rfq_id', v_rfq.id, 'rfq_number', v_rfq.rfq_number, 'desk_code', v_desk.code, 'desk_name', v_desk.name,
                            'operator_id', v_op.id, 'operator_name', v_op.full_name,
                            'status', (SELECT status FROM rfqs WHERE id = v_rfq.id));
END $$;

-- -----------------------------------------------------------------------------
-- WF05 — clarification scheduling (debounced, never the same question twice)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION of_due_clarifications(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_max int := coalesce((p->>'max_clarifications')::int, 2); v_out jsonb;
BEGIN
  WITH due AS (
    SELECT r.id FROM rfqs r
     WHERE r.status = 'NEEDS_INFORMATION' AND r.clarification_due_at <= now()
       AND (nullif(p->>'rfq_id', '') IS NULL OR r.id = (p->>'rfq_id')::uuid)
     ORDER BY r.clarification_due_at
     LIMIT coalesce((p->>'limit')::int, 20)
     FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE rfqs r SET clarification_due_at = NULL FROM due WHERE r.id = due.id RETURNING r.*
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'rfq_id', c.id, 'rfq_number', c.rfq_number, 'requirements', c.requirements, 'missing_fields', to_jsonb(c.missing_fields),
           'clarification_key', array_to_string(ARRAY(SELECT unnest(c.missing_fields) ORDER BY 1), '|'),
           'action', CASE
             WHEN c.last_clarification_key IS NOT DISTINCT FROM array_to_string(ARRAY(SELECT unnest(c.missing_fields) ORDER BY 1), '|') THEN 'SKIP_ALREADY_ASKED'
             WHEN c.clarification_count >= v_max THEN 'ESCALATE'
             ELSE 'SEND' END,
           'contact_first_name', ct.first_name, 'conversation_subject', cv.subject, 'source_channel', c.source_channel)), '[]'::jsonb)
    INTO v_out
    FROM claimed c
    LEFT JOIN contacts ct ON ct.id = c.contact_id
    LEFT JOIN conversations cv ON cv.id = c.conversation_id;
  RETURN jsonb_build_object('items', v_out);
END $$;

CREATE OR REPLACE FUNCTION of_mark_clarification(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_rfq rfqs%ROWTYPE;
BEGIN
  IF p->>'action' = 'ESCALATE' THEN
    UPDATE rfqs SET requires_human = true, human_review_reason = 'Missing information after repeated clarification requests'
     WHERE id = (p->>'rfq_id')::uuid RETURNING * INTO v_rfq;
    PERFORM of_alert(v_rfq.id, 'HUMAN_REVIEW', 'WARNING', coalesce(v_rfq.assigned_team, 'GENERAL_DESK'),
                     v_rfq.rfq_number || ': still incomplete after ' || v_rfq.clarification_count || ' clarification requests',
                     jsonb_build_object('missing', to_jsonb(v_rfq.missing_fields)), 'CLARIFY_ESCALATE:' || v_rfq.id || ':' || coalesce(p->>'clarification_key', ''));
    RETURN jsonb_build_object('ok', true, 'escalated', true);
  END IF;
  UPDATE rfqs SET clarification_count = clarification_count + 1, last_clarification_key = p->>'clarification_key', updated_at = now()
   WHERE id = (p->>'rfq_id')::uuid RETURNING * INTO v_rfq;
  PERFORM of_audit(v_rfq.id, 'rfq', v_rfq.id::text, 'MISSING_INFO_REQUESTED', 'SYSTEM', 'WF05_MISSING_INFORMATION_HANDLER',
                   jsonb_build_object('missing', to_jsonb(v_rfq.missing_fields), 'question', p->>'question', 'channel', p->>'channel'));
  RETURN jsonb_build_object('ok', true, 'escalated', false, 'count', v_rfq.clarification_count);
END $$;

-- -----------------------------------------------------------------------------
-- Mock Fare Desk / FareProvider intake (WF16) and quotes (WF10 / WF11)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION of_save_fare_options(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_rfq rfqs%ROWTYPE; v_batch int; v_ids jsonb;
BEGIN
  SELECT * INTO v_rfq FROM rfqs
   WHERE id = CASE WHEN nullif(p->>'rfq_id', '') IS NOT NULL THEN (p->>'rfq_id')::uuid END OR rfq_number = p->>'rfq_number'
   FOR UPDATE;
  IF v_rfq.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'RFQ_NOT_FOUND'); END IF;
  IF v_rfq.status NOT IN ('ASSIGNED', 'SEARCHING', 'FARES_FOUND', 'PENDING_APPROVAL') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'RFQ_NOT_READY_FOR_FARES', 'status', v_rfq.status);
  END IF;
  IF v_rfq.status = 'PENDING_APPROVAL' THEN
    UPDATE quotes SET status = 'SUPERSEDED' WHERE rfq_id = v_rfq.id AND status = 'PENDING_APPROVAL';
    PERFORM of_transition_rfq(v_rfq.id, 'FARES_FOUND', 'HUMAN', p->>'entered_by', 'Fare options replaced before approval');
  ELSE
    PERFORM of_transition_path(v_rfq.id, ARRAY['ASSIGNED', 'SEARCHING', 'FARES_FOUND'], 'HUMAN', p->>'entered_by', 'Fare options entered');
  END IF;

  SELECT coalesce(max(batch_no), 0) + 1 INTO v_batch FROM fare_options WHERE rfq_id = v_rfq.id;
  UPDATE fare_options SET is_active = false WHERE rfq_id = v_rfq.id AND is_active;
  WITH ins AS (
    INSERT INTO fare_options (rfq_id, batch_no, option_no, option_code, airline, flight_segments, departure_at, arrival_at,
                              return_departure_at, total_duration_minutes, stops, cabin, fare_amount, fare_currency, fare_basis,
                              baggage, change_penalty, refund_penalty, fare_valid_until, source, verified, entered_by, notes)
    SELECT v_rfq.id, v_batch, (o->>'option_no')::int, o->>'option_code', o->>'airline', coalesce(o->'flight_segments', '[]'::jsonb),
           (o->>'departure_at')::timestamp, nullif(o->>'arrival_at', '')::timestamp, nullif(o->>'return_departure_at', '')::timestamp,
           nullif(o->>'total_duration_minutes', '')::int, nullif(o->>'stops', '')::int, o->>'cabin',
           (o->'fare'->>'amount')::numeric, o->'fare'->>'currency', coalesce(o->>'fare_basis', 'PER_PASSENGER'),
           o->>'baggage', o->>'change_penalty', o->>'refund_penalty', (o->>'fare_valid_until')::timestamptz,
           coalesce(o->>'source', 'MANUAL'), coalesce((o->>'verified')::boolean, true), p->>'entered_by', nullif(o->>'notes', '')
      FROM jsonb_array_elements(p->'options') AS o
    RETURNING id, option_code
  )
  SELECT jsonb_agg(jsonb_build_object('id', id, 'option_code', option_code) ORDER BY option_code) INTO v_ids FROM ins;

  UPDATE rfqs SET requires_fare_recheck = false, updated_at = now() WHERE id = v_rfq.id;
  UPDATE alerts SET status = 'RESOLVED', resolved_at = now(), resolved_by = p->>'entered_by'
   WHERE rfq_id = v_rfq.id AND alert_type IN ('SLA_BREACH', 'RECHECK_FARE') AND status <> 'RESOLVED';
  PERFORM of_audit(v_rfq.id, 'rfq', v_rfq.id::text, 'FARES_ADDED', 'HUMAN', p->>'entered_by',
                   jsonb_build_object('batch', v_batch, 'count', jsonb_array_length(p->'options'),
                                      'options', (SELECT jsonb_agg(jsonb_build_object('airline', o->>'airline', 'amount', o->'fare'->>'amount', 'currency', o->'fare'->>'currency', 'source', o->>'source'))
                                                    FROM jsonb_array_elements(p->'options') o)));
  RETURN jsonb_build_object('ok', true, 'rfq_id', v_rfq.id, 'rfq_number', v_rfq.rfq_number, 'batch_no', v_batch, 'options', v_ids, 'status', 'FARES_FOUND');
END $$;

CREATE OR REPLACE FUNCTION of_get_quote_context(p jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT of_rfq_snapshot(r.id) || jsonb_build_object(
           'options', of_active_options(r.id),
           'last_inbound_channel', (SELECT m.channel FROM messages m WHERE m.rfq_id = r.id AND m.direction = 'INBOUND' ORDER BY m.created_at DESC LIMIT 1))
    FROM rfqs r WHERE r.id = (p->>'rfq_id')::uuid OR r.rfq_number = p->>'rfq_number';
$$;

CREATE OR REPLACE FUNCTION of_create_quote(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_rfq rfqs%ROWTYPE; v_version int; v_quote quotes%ROWTYPE; v_require boolean := coalesce((p->>'require_approval')::boolean, true);
        v_hash text;
BEGIN
  SELECT * INTO v_rfq FROM rfqs WHERE id = (p->>'rfq_id')::uuid FOR UPDATE;
  IF v_rfq.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'RFQ_NOT_FOUND'); END IF;
  IF v_rfq.status <> 'FARES_FOUND' THEN RETURN jsonb_build_object('ok', false, 'error', 'RFQ_NOT_IN_FARES_FOUND', 'status', v_rfq.status); END IF;
  UPDATE quotes SET status = 'SUPERSEDED' WHERE rfq_id = v_rfq.id AND status IN ('PENDING_APPROVAL', 'APPROVED');
  SELECT coalesce(max(version), 0) + 1 INTO v_version FROM quotes WHERE rfq_id = v_rfq.id;
  v_hash := encode(digest(coalesce(p->>'email_subject', '') || E'\n' || coalesce(p->>'email_body', '') || E'\n' || coalesce(p->>'whatsapp_body', ''), 'sha256'), 'hex');
  INSERT INTO quotes (rfq_id, version, status, email_subject, email_body, whatsapp_body, quote_model, generated_by, ai_model,
                      validation, content_hash, valid_until, approved_by, approved_at)
  VALUES (v_rfq.id, v_version, CASE WHEN v_require THEN 'PENDING_APPROVAL' ELSE 'APPROVED' END,
          p->>'email_subject', p->>'email_body', p->>'whatsapp_body', p->'quote_model', p->>'generated_by', p->>'ai_model',
          p->'validation', v_hash, (p->>'valid_until')::timestamptz,
          CASE WHEN v_require THEN NULL ELSE 'SYSTEM (REQUIRE_HUMAN_APPROVAL=false)' END, CASE WHEN v_require THEN NULL ELSE now() END)
  RETURNING * INTO v_quote;
  INSERT INTO quote_options (quote_id, fare_option_id, display_order)
  SELECT v_quote.id, f.id, f.option_no FROM fare_options f WHERE f.rfq_id = v_rfq.id AND f.is_active;
  PERFORM of_audit(v_rfq.id, 'quote', v_quote.id::text, 'QUOTE_GENERATED', CASE WHEN v_quote.generated_by = 'AI' THEN 'AI' ELSE 'SYSTEM' END,
                   coalesce(v_quote.ai_model, 'template'),
                   jsonb_build_object('version', v_version, 'generated_by', v_quote.generated_by, 'validation', p->'validation'));
  IF v_require THEN
    PERFORM of_transition_rfq(v_rfq.id, 'PENDING_APPROVAL', 'SYSTEM', 'WF10_QUOTE_FORMATTER', 'Quote v' || v_version || ' awaiting human approval');
    PERFORM of_alert(v_rfq.id, 'DESK_NOTIFICATION', CASE WHEN v_rfq.priority_level IN ('HIGH', 'CRITICAL') THEN 'WARNING' ELSE 'INFO' END,
                     v_rfq.assigned_team, v_rfq.rfq_number || ': quote v' || v_version || ' ready for approval',
                     jsonb_build_object('quote_id', v_quote.id), 'APPROVAL:' || v_quote.id);
  ELSE
    INSERT INTO approvals (quote_id, rfq_id, quote_version, action, approval_status, approved_by, approval_note, content_hash, content_snapshot)
    VALUES (v_quote.id, v_rfq.id, v_version, 'AUTO_APPROVE', 'APPROVED', 'SYSTEM', 'REQUIRE_HUMAN_APPROVAL=false', v_hash,
            jsonb_build_object('email_subject', v_quote.email_subject, 'email_body', v_quote.email_body, 'whatsapp_body', v_quote.whatsapp_body));
    PERFORM of_transition_rfq(v_rfq.id, 'APPROVED', 'SYSTEM', 'WF10_QUOTE_FORMATTER', 'Auto-approved (REQUIRE_HUMAN_APPROVAL=false)');
    PERFORM of_audit(v_rfq.id, 'quote', v_quote.id::text, 'QUOTE_APPROVED', 'SYSTEM', 'auto', jsonb_build_object('version', v_version));
  END IF;
  RETURN jsonb_build_object('ok', true, 'quote_id', v_quote.id, 'version', v_version, 'quote_status', v_quote.status,
                            'rfq_status', (SELECT status FROM rfqs WHERE id = v_rfq.id), 'send_now', NOT v_require,
                            'rfq_id', v_rfq.id, 'rfq_number', v_rfq.rfq_number);
END $$;

CREATE OR REPLACE FUNCTION of_get_quote(p jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('quote', to_jsonb(q) - 'quote_model', 'quote_model', q.quote_model,
                            'rfq_status', r.status, 'rfq_number', r.rfq_number,
                            'is_latest', q.version = (SELECT max(version) FROM quotes WHERE rfq_id = q.rfq_id))
    FROM quotes q JOIN rfqs r ON r.id = q.rfq_id WHERE q.id = (p->>'quote_id')::uuid;
$$;

CREATE OR REPLACE FUNCTION of_quote_decision(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_q quotes%ROWTYPE; v_rfq rfqs%ROWTYPE; v_action text := upper(p->>'action'); v_by text := nullif(trim(p->>'reviewer'), '');
  v_new quotes%ROWTYPE; v_hash text; v_warn int;
BEGIN
  SELECT * INTO v_q FROM quotes WHERE id = (p->>'quote_id')::uuid FOR UPDATE;
  IF v_q.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'QUOTE_NOT_FOUND'); END IF;
  SELECT * INTO v_rfq FROM rfqs WHERE id = v_q.rfq_id FOR UPDATE;
  IF v_by IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'REVIEWER_REQUIRED'); END IF;
  IF v_action NOT IN ('APPROVE', 'EDIT', 'REJECT') THEN RETURN jsonb_build_object('ok', false, 'error', 'INVALID_ACTION'); END IF;
  IF v_q.status <> 'PENDING_APPROVAL' OR v_rfq.status <> 'PENDING_APPROVAL' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'QUOTE_NOT_PENDING_APPROVAL', 'quote_status', v_q.status, 'rfq_status', v_rfq.status);
  END IF;
  IF v_q.version <> (SELECT max(version) FROM quotes WHERE rfq_id = v_q.rfq_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_LATEST_VERSION');
  END IF;

  IF v_action = 'APPROVE' THEN
    IF v_q.valid_until IS NOT NULL AND v_q.valid_until <= now() THEN
      RETURN jsonb_build_object('ok', false, 'error', 'QUOTE_EXPIRED', 'message', 'Fare validity has passed – recheck fares before approving.');
    END IF;
    v_warn := coalesce(jsonb_array_length(v_q.validation->'warnings'), 0);
    IF v_q.generated_by = 'HUMAN_EDIT' AND v_warn > 0 AND NOT coalesce((p->>'acknowledge_warnings')::boolean, false) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'EDIT_WARNINGS_NOT_ACKNOWLEDGED', 'warnings', v_q.validation->'warnings');
    END IF;
    UPDATE quotes SET status = 'APPROVED', approved_by = v_by, approved_at = now() WHERE id = v_q.id;
    INSERT INTO approvals (quote_id, rfq_id, quote_version, action, approval_status, approved_by, approval_note, content_hash, content_snapshot)
    VALUES (v_q.id, v_rfq.id, v_q.version, 'APPROVE', 'APPROVED', v_by, p->>'note', v_q.content_hash,
            jsonb_build_object('email_subject', v_q.email_subject, 'email_body', v_q.email_body, 'whatsapp_body', v_q.whatsapp_body));
    PERFORM of_transition_rfq(v_rfq.id, 'APPROVED', 'HUMAN', v_by, coalesce(p->>'note', 'Quote approved'));
    PERFORM of_audit(v_rfq.id, 'quote', v_q.id::text, 'QUOTE_APPROVED', 'HUMAN', v_by,
                     jsonb_build_object('version', v_q.version, 'content_hash', v_q.content_hash, 'note', p->>'note'));
    UPDATE alerts SET status = 'RESOLVED', resolved_at = now(), resolved_by = v_by WHERE dedupe_key = 'APPROVAL:' || v_q.id;
    RETURN jsonb_build_object('ok', true, 'result', 'APPROVED', 'quote_id', v_q.id, 'version', v_q.version, 'rfq_id', v_rfq.id,
                              'rfq_number', v_rfq.rfq_number, 'send', true);
  ELSIF v_action = 'EDIT' THEN
    IF coalesce(p->'edited'->>'email_body', '') = '' OR coalesce(p->'edited'->>'whatsapp_body', '') = '' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'EDITED_TEXT_REQUIRED');
    END IF;
    v_hash := encode(digest(coalesce(p->'edited'->>'email_subject', v_q.email_subject) || E'\n' || (p->'edited'->>'email_body') || E'\n' || (p->'edited'->>'whatsapp_body'), 'sha256'), 'hex');
    UPDATE quotes SET status = 'SUPERSEDED' WHERE id = v_q.id;
    INSERT INTO quotes (rfq_id, version, status, email_subject, email_body, whatsapp_body, quote_model, generated_by, ai_model,
                        validation, content_hash, edited_from, valid_until)
    VALUES (v_rfq.id, v_q.version + 1, 'PENDING_APPROVAL', coalesce(p->'edited'->>'email_subject', v_q.email_subject),
            p->'edited'->>'email_body', p->'edited'->>'whatsapp_body', v_q.quote_model, 'HUMAN_EDIT', NULL,
            jsonb_build_object('warnings', coalesce(p->'edit_review'->'warnings', '[]'::jsonb), 'edited_by', v_by), v_hash, v_q.id, v_q.valid_until)
    RETURNING * INTO v_new;
    INSERT INTO quote_options (quote_id, fare_option_id, display_order)
    SELECT v_new.id, fare_option_id, display_order FROM quote_options WHERE quote_id = v_q.id;
    INSERT INTO approvals (quote_id, rfq_id, quote_version, action, approval_status, approved_by, approval_note, content_hash, content_snapshot)
    VALUES (v_q.id, v_rfq.id, v_q.version, 'EDIT', 'EDITED', v_by, p->>'note', v_hash,
            jsonb_build_object('new_version', v_new.version, 'email_subject', v_new.email_subject, 'email_body', v_new.email_body, 'whatsapp_body', v_new.whatsapp_body));
    PERFORM of_audit(v_rfq.id, 'quote', v_new.id::text, 'QUOTE_EDITED', 'HUMAN', v_by,
                     jsonb_build_object('from_version', v_q.version, 'to_version', v_new.version, 'warnings', coalesce(p->'edit_review'->'warnings', '[]'::jsonb)));
    UPDATE alerts SET status = 'RESOLVED', resolved_at = now(), resolved_by = v_by WHERE dedupe_key = 'APPROVAL:' || v_q.id;
    PERFORM of_alert(v_rfq.id, 'DESK_NOTIFICATION', 'INFO', v_rfq.assigned_team, v_rfq.rfq_number || ': edited quote v' || v_new.version || ' ready for approval',
                     jsonb_build_object('quote_id', v_new.id), 'APPROVAL:' || v_new.id);
    RETURN jsonb_build_object('ok', true, 'result', 'EDITED', 'quote_id', v_new.id, 'version', v_new.version, 'rfq_id', v_rfq.id,
                              'warnings', coalesce(p->'edit_review'->'warnings', '[]'::jsonb), 'send', false);
  ELSE
    UPDATE quotes SET status = 'REJECTED' WHERE id = v_q.id;
    INSERT INTO approvals (quote_id, rfq_id, quote_version, action, approval_status, approved_by, approval_note, content_hash, content_snapshot)
    VALUES (v_q.id, v_rfq.id, v_q.version, 'REJECT', 'REJECTED', v_by, p->>'note', v_q.content_hash, jsonb_build_object('reason', p->>'note'));
    PERFORM of_transition_rfq(v_rfq.id, 'SEARCHING', 'HUMAN', v_by, 'Quote rejected: ' || coalesce(p->>'note', 'no reason given'));
    PERFORM of_audit(v_rfq.id, 'quote', v_q.id::text, 'QUOTE_REJECTED', 'HUMAN', v_by, jsonb_build_object('version', v_q.version, 'note', p->>'note'));
    UPDATE alerts SET status = 'RESOLVED', resolved_at = now(), resolved_by = v_by WHERE dedupe_key = 'APPROVAL:' || v_q.id;
    PERFORM of_alert(v_rfq.id, 'DESK_NOTIFICATION', 'WARNING', v_rfq.assigned_team, v_rfq.rfq_number || ': quote rejected – rework fares',
                     jsonb_build_object('note', p->>'note', 'reviewer', v_by), 'REJECTED:' || v_q.id);
    RETURN jsonb_build_object('ok', true, 'result', 'REJECTED', 'quote_id', v_q.id, 'rfq_id', v_rfq.id, 'send', false);
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- WF12 — delivery context and outbound recording
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION of_get_delivery_context(p jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'rfq', of_rfq_snapshot(r.id),
    'quote', (SELECT jsonb_build_object('id', q.id, 'version', q.version, 'status', q.status, 'email_subject', q.email_subject,
                                        'email_body', q.email_body, 'whatsapp_body', q.whatsapp_body)
                FROM quotes q WHERE q.id = nullif(p->>'quote_id', '')::uuid AND q.rfq_id = r.id),
    'last_inbound_channel', (SELECT m.channel FROM messages m WHERE m.rfq_id = r.id AND m.direction = 'INBOUND' ORDER BY m.created_at DESC LIMIT 1),
    'email', (SELECT jsonb_build_object('conversation_id', cv.id, 'thread_id', cv.external_thread_id, 'subject', cv.subject,
                                        'last_inbound_external_id', (SELECT m.external_message_id FROM messages m WHERE m.conversation_id = cv.id AND m.direction = 'INBOUND' ORDER BY m.created_at DESC LIMIT 1),
                                        'last_inbound_subject', (SELECT m.subject FROM messages m WHERE m.conversation_id = cv.id AND m.direction = 'INBOUND' ORDER BY m.created_at DESC LIMIT 1))
                FROM conversations cv
               WHERE cv.channel = 'email' AND (cv.id = r.conversation_id OR cv.id IN (SELECT conversation_id FROM messages WHERE rfq_id = r.id))
               ORDER BY cv.last_inbound_at DESC NULLS LAST LIMIT 1),
    'whatsapp', (SELECT jsonb_build_object('conversation_id', cv.id, 'phone', cv.external_thread_id, 'last_inbound_at', cv.last_inbound_at,
                                           'last_inbound_external_id', (SELECT m.external_message_id FROM messages m WHERE m.conversation_id = cv.id AND m.direction = 'INBOUND' ORDER BY m.created_at DESC LIMIT 1))
                   FROM conversations cv
                  WHERE cv.channel = 'whatsapp' AND cv.contact_id = r.contact_id
                  ORDER BY cv.last_inbound_at DESC NULLS LAST LIMIT 1))
  FROM rfqs r WHERE r.id = (p->>'rfq_id')::uuid;
$$;

CREATE OR REPLACE FUNCTION of_record_outbound(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_rfq rfqs%ROWTYPE; v_conv uuid := nullif(p->>'conversation_id', '')::uuid; v_msg uuid;
  v_ok boolean := coalesce(p->>'delivery_status', 'FAILED') IN ('SIMULATED', 'SENT', 'DELIVERED', 'READ');
  v_kind text := coalesce(p->>'kind', 'MESSAGE');
BEGIN
  SELECT * INTO v_rfq FROM rfqs WHERE id = (p->>'rfq_id')::uuid FOR UPDATE;
  IF v_rfq.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'RFQ_NOT_FOUND'); END IF;
  -- Human-approval gate (defence in depth): a quote can only leave the system once, and only when APPROVED.
  IF v_kind = 'QUOTE' AND NOT EXISTS (SELECT 1 FROM quotes WHERE id = nullif(p->>'quote_id', '')::uuid AND rfq_id = v_rfq.id AND status = 'APPROVED') THEN
    PERFORM of_audit(v_rfq.id, 'quote', coalesce(p->>'quote_id', 'none'), 'QUOTE_SEND_BLOCKED', 'SYSTEM', 'WF12_QUOTE_DELIVERY',
                     jsonb_build_object('reason', 'QUOTE_NOT_APPROVED_OR_ALREADY_SENT',
                                        'quote_status', (SELECT status FROM quotes WHERE id = nullif(p->>'quote_id', '')::uuid)));
    RETURN jsonb_build_object('ok', false, 'error', 'QUOTE_NOT_APPROVED', 'rfq_status', v_rfq.status);
  END IF;
  IF v_conv IS NULL THEN
    INSERT INTO conversations (channel, external_thread_id, contact_id, agency_id, subject)
    VALUES (p->>'channel', coalesce(nullif(p->>'thread_key', ''), 'out-' || v_rfq.rfq_number || '-' || (p->>'channel')), v_rfq.contact_id, v_rfq.agency_id, p->>'subject')
    ON CONFLICT (channel, external_thread_id) DO UPDATE SET updated_at = now()
    RETURNING id INTO v_conv;
  END IF;
  INSERT INTO messages (conversation_id, rfq_id, channel, direction, external_message_id, sender, recipient, subject, content, kind,
                        sent_at, processing_status, delivery_status, delivery_error, processing_notes)
  VALUES (v_conv, v_rfq.id, p->>'channel', 'OUTBOUND', nullif(p->>'external_message_id', ''), 'Offshore Fares', p->>'recipient',
          p->>'subject', coalesce(p->>'content', ''), v_kind, now(), 'SENT', coalesce(p->>'delivery_status', 'FAILED'),
          left(p->>'delivery_error', 1000), jsonb_build_object('template', p->'template', 'simulated', p->>'delivery_status' = 'SIMULATED'))
  RETURNING id INTO v_msg;
  UPDATE conversations SET last_outbound_at = now(), updated_at = now() WHERE id = v_conv;

  IF v_ok THEN
    IF v_rfq.first_response_at IS NULL AND v_kind IN ('ACK', 'CLARIFICATION', 'QUOTE', 'CONFIRMATION_QUESTION', 'AFTER_SALES_ACK', 'BOOKING_ACK') THEN
      UPDATE rfqs SET first_response_at = now() WHERE id = v_rfq.id;
    END IF;
    IF v_kind = 'QUOTE' THEN
      UPDATE quotes SET status = 'SENT', sent_at = now(), delivery_channel = p->>'channel', delivery_status = p->>'delivery_status'
       WHERE id = (p->>'quote_id')::uuid;
      PERFORM of_transition_path(v_rfq.id, ARRAY['APPROVED', 'QUOTED', 'AWAITING_CLIENT'], 'SYSTEM', 'WF12_QUOTE_DELIVERY', 'Quote delivered via ' || (p->>'channel'));
      PERFORM of_audit(v_rfq.id, 'quote', p->>'quote_id', 'QUOTE_SENT', 'SYSTEM', 'WF12_QUOTE_DELIVERY',
                       jsonb_build_object('channel', p->>'channel', 'delivery_status', p->>'delivery_status', 'message_id', v_msg, 'recipient', p->>'recipient'));
    ELSE
      PERFORM of_audit(v_rfq.id, 'message', v_msg::text, 'MESSAGE_SENT', 'SYSTEM', 'WF12_QUOTE_DELIVERY',
                       jsonb_build_object('kind', v_kind, 'channel', p->>'channel', 'delivery_status', p->>'delivery_status'));
    END IF;
  ELSE
    PERFORM of_alert(v_rfq.id, 'DELIVERY_FAILED', 'CRITICAL', v_rfq.assigned_team, v_rfq.rfq_number || ': ' || v_kind || ' could not be delivered via ' || (p->>'channel'),
                     jsonb_build_object('error', left(p->>'delivery_error', 500), 'message_id', v_msg), 'DELIVERY:' || v_msg);
    PERFORM of_audit(v_rfq.id, 'message', v_msg::text, 'DELIVERY_FAILED', 'SYSTEM', 'WF12_QUOTE_DELIVERY',
                     jsonb_build_object('kind', v_kind, 'channel', p->>'channel', 'error', left(p->>'delivery_error', 300)));
  END IF;
  RETURN jsonb_build_object('ok', v_ok, 'message_id', v_msg, 'conversation_id', v_conv, 'rfq_status', (SELECT status FROM rfqs WHERE id = v_rfq.id));
END $$;

-- -----------------------------------------------------------------------------
-- WF13 — follow-ups
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION of_followup_candidates(p jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) FROM (
    SELECT r.id AS rfq_id, r.rfq_number, r.status, r.cabin, r.origin_iata || ' → ' || r.destination_iata AS route,
           q.id AS quote_id, q.sent_at AS quote_sent_at, q.valid_until AS quote_valid_until, q.delivery_channel,
           (SELECT count(*) FROM followups f WHERE f.rfq_id = r.id AND f.quote_id = q.id AND f.status = 'SENT') AS followups_sent,
           (SELECT max(m.created_at) FROM messages m WHERE m.rfq_id = r.id AND m.direction = 'INBOUND') AS last_client_message_at,
           c.first_name AS contact_first_name, c.email AS contact_email, c.whatsapp_phone, c.opted_out_followups AS opted_out,
           (SELECT max(cv.last_inbound_at) FROM conversations cv WHERE cv.channel = 'whatsapp' AND cv.contact_id = r.contact_id) AS whatsapp_last_inbound_at
      FROM rfqs r
      JOIN LATERAL (SELECT * FROM quotes q WHERE q.rfq_id = r.id AND q.status = 'SENT' ORDER BY q.version DESC LIMIT 1) q ON true
      LEFT JOIN contacts c ON c.id = r.contact_id
     WHERE r.status IN ('QUOTED', 'AWAITING_CLIENT')
     ORDER BY q.sent_at
     LIMIT 200) x;
$$;

CREATE OR REPLACE FUNCTION of_claim_followup(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO followups (rfq_id, quote_id, sequence_no, status, channel, quote_expired)
  VALUES ((p->>'rfq_id')::uuid, (p->>'quote_id')::uuid, (p->>'sequence')::int, 'PENDING', p->>'channel', coalesce((p->>'quote_expired')::boolean, false))
  ON CONFLICT (rfq_id, quote_id, sequence_no) DO NOTHING
  RETURNING id INTO v_id;
  RETURN p || jsonb_build_object('claimed', v_id IS NOT NULL, 'followup_id', v_id);
END $$;

CREATE OR REPLACE FUNCTION of_record_followup(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_f followups%ROWTYPE; v_rfq rfqs%ROWTYPE;
BEGIN
  UPDATE followups SET status = CASE WHEN coalesce((p->>'delivered')::boolean, false) THEN 'SENT' ELSE 'FAILED' END,
         message_id = nullif(p->>'message_id', '')::uuid, sent_at = now()
   WHERE id = (p->>'followup_id')::uuid RETURNING * INTO v_f;
  IF v_f.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'FOLLOWUP_NOT_FOUND'); END IF;
  SELECT * INTO v_rfq FROM rfqs WHERE id = v_f.rfq_id;
  PERFORM of_audit(v_f.rfq_id, 'followup', v_f.id::text, CASE WHEN v_f.status = 'SENT' THEN 'FOLLOWUP_SENT' ELSE 'FOLLOWUP_FAILED' END, 'SYSTEM',
                   'WF13_FOLLOWUP_ENGINE', jsonb_build_object('sequence', v_f.sequence_no, 'channel', v_f.channel, 'quote_expired', v_f.quote_expired,
                                                              'template', p->'template'));
  IF v_f.quote_expired THEN
    -- The quote keeps status SENT (historical fact); expiry is derived from valid_until and a recheck task is raised.
    PERFORM of_alert(v_f.rfq_id, 'RECHECK_FARE', 'WARNING', v_rfq.assigned_team, v_rfq.rfq_number || ': quoted fares expired – recheck before any booking',
                     jsonb_build_object('quote_id', v_f.quote_id), 'RECHECK:' || v_f.quote_id);
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', v_f.status);
END $$;

-- -----------------------------------------------------------------------------
-- WF08 — SLA monitor
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION of_sla_candidates(p jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'rfq_number', r.rfq_number, 'status', r.status,
                                               'status_changed_at', r.status_changed_at, 'priority_level', r.priority_level,
                                               'assigned_team', r.assigned_team)), '[]'::jsonb)
    FROM rfqs r WHERE of_is_open(r.status) AND r.status NOT IN ('TICKETED', 'ERROR');
$$;

CREATE OR REPLACE FUNCTION of_record_sla_breaches(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE b jsonb; v_alert uuid; v_new jsonb := '[]'::jsonb; v_rfq rfqs%ROWTYPE;
BEGIN
  FOR b IN SELECT * FROM jsonb_array_elements(coalesce(p->'breaches', '[]'::jsonb)) LOOP
    SELECT * INTO v_rfq FROM rfqs WHERE id = (b->>'rfq_id')::uuid;
    CONTINUE WHEN v_rfq.id IS NULL OR v_rfq.status <> b->>'status';
    v_alert := of_alert(v_rfq.id, 'SLA_BREACH', CASE WHEN v_rfq.priority_level IN ('HIGH', 'CRITICAL') THEN 'CRITICAL' ELSE 'WARNING' END,
                        v_rfq.assigned_team,
                        format('%s: SLA breached – %s min in %s (limit %s min)', v_rfq.rfq_number, b->>'minutes_in_status', v_rfq.status, b->>'threshold_minutes'),
                        b, b->>'dedupe_key');
    IF v_alert IS NOT NULL THEN
      UPDATE rfqs SET sla_breached = true WHERE id = v_rfq.id;
      PERFORM of_audit(v_rfq.id, 'rfq', v_rfq.id::text, 'SLA_BREACHED', 'SYSTEM', 'WF08_SLA_MONITOR', b);
      v_new := v_new || jsonb_build_object('alert_id', v_alert, 'rfq_number', v_rfq.rfq_number, 'status', v_rfq.status, 'desk', v_rfq.assigned_team);
    END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'new_alerts', v_new);
END $$;

-- -----------------------------------------------------------------------------
-- WF14 — client decisions after a quote
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION of_record_client_decision(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_rfq rfqs%ROWTYPE; v_opt fare_options%ROWTYPE; v_action text := p->>'action'; v_handoff jsonb; v_contact contacts%ROWTYPE; v_agency agencies%ROWTYPE;
BEGIN
  SELECT * INTO v_rfq FROM rfqs WHERE id = (p->>'rfq_id')::uuid FOR UPDATE;
  IF v_rfq.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'RFQ_NOT_FOUND'); END IF;
  UPDATE messages SET rfq_id = v_rfq.id WHERE id = (p->>'message_id')::uuid;
  PERFORM of_audit(v_rfq.id, 'message', p->>'message_id', 'CLIENT_REPLIED', 'CLIENT', p->>'message_id',
                   jsonb_build_object('action', v_action, 'confidence', p->'confidence', 'reason', p->>'reason', 'source', p->>'source'));
  IF v_rfq.status = 'QUOTED' THEN PERFORM of_transition_rfq(v_rfq.id, 'AWAITING_CLIENT', 'SYSTEM', 'WF14_CLIENT_RESPONSE_HANDLER', 'Client replied'); END IF;

  IF v_action = 'SELECT_OPTION' AND NOT coalesce((p->>'needs_confirmation')::boolean, true) THEN
    SELECT * INTO v_opt FROM fare_options WHERE rfq_id = v_rfq.id AND is_active AND option_code = p->>'selected_option_code';
    IF v_opt.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'OPTION_NOT_FOUND'); END IF;
    SELECT * INTO v_contact FROM contacts WHERE id = v_rfq.contact_id;
    SELECT * INTO v_agency FROM agencies WHERE id = v_rfq.agency_id;
    v_handoff := jsonb_build_object(
      'rfq_number', v_rfq.rfq_number,
      'agency', v_agency.name,
      'contact', trim(coalesce(v_contact.first_name, '') || ' ' || coalesce(v_contact.last_name, '')),
      'contact_email', v_contact.email, 'contact_whatsapp', v_contact.whatsapp_phone,
      'passengers', jsonb_build_object('adults', v_rfq.adults, 'children', v_rfq.children, 'infants', v_rfq.infants),
      'selected_option', jsonb_build_object('code', v_opt.option_code, 'airline', v_opt.airline, 'fare_amount', v_opt.fare_amount,
                                            'fare_currency', v_opt.fare_currency, 'fare_basis', v_opt.fare_basis,
                                            'segments', v_opt.flight_segments, 'baggage', v_opt.baggage,
                                            'change_penalty', v_opt.change_penalty, 'refund_penalty', v_opt.refund_penalty,
                                            'fare_valid_until', v_opt.fare_valid_until),
      'travel_dates', jsonb_build_object('departure', v_rfq.departure_date, 'return', v_rfq.return_date),
      'cabin', v_rfq.cabin,
      'requires_fare_recheck', v_opt.fare_valid_until <= now(),
      'notes', coalesce(p->>'client_message', ''),
      'requested_at', now());
    UPDATE rfqs SET selected_option_id = v_opt.id, requires_fare_recheck = v_opt.fare_valid_until <= now(), handoff = v_handoff, updated_at = now()
     WHERE id = v_rfq.id;
    PERFORM of_transition_rfq(v_rfq.id, 'BOOKING_REQUESTED', 'CLIENT', p->>'message_id', 'Agent selected ' || v_opt.option_code);
    PERFORM of_audit(v_rfq.id, 'rfq', v_rfq.id::text, 'BOOKING_REQUESTED', 'CLIENT', p->>'message_id',
                     jsonb_build_object('selected_option', v_opt.option_code, 'airline', v_opt.airline, 'fare_expired', v_opt.fare_valid_until <= now()));
    IF v_opt.fare_valid_until <= now() THEN
      PERFORM of_alert(v_rfq.id, 'RECHECK_FARE', 'CRITICAL', 'TICKETING_DESK', v_rfq.rfq_number || ': selected fare has expired – revalidate before ticketing',
                       jsonb_build_object('option', v_opt.option_code), 'RECHECK_BOOKING:' || v_opt.id);
    END IF;
    RETURN jsonb_build_object('ok', true, 'result', 'BOOKING_REQUESTED', 'rfq_id', v_rfq.id, 'rfq_number', v_rfq.rfq_number,
                              'handoff', v_handoff, 'requires_fare_recheck', v_opt.fare_valid_until <= now());
  ELSIF v_action = 'SELECT_OPTION' THEN
    PERFORM of_audit(v_rfq.id, 'rfq', v_rfq.id::text, 'SELECTION_NEEDS_CONFIRMATION', 'SYSTEM', 'WF14_CLIENT_RESPONSE_HANDLER', jsonb_build_object('reason', p->>'reason'));
    RETURN jsonb_build_object('ok', true, 'result', 'CONFIRMATION_REQUIRED', 'rfq_id', v_rfq.id, 'rfq_number', v_rfq.rfq_number);
  ELSIF v_action = 'HOLD' THEN
    PERFORM of_transition_rfq(v_rfq.id, 'CLIENT_INTERESTED', 'CLIENT', p->>'message_id', 'Agent asked to hold / will revert');
    PERFORM of_alert(v_rfq.id, 'DESK_NOTIFICATION', 'INFO', v_rfq.assigned_team, v_rfq.rfq_number || ': agent asked to hold the options',
                     jsonb_build_object('message', left(p->>'client_message', 500)), 'HOLD:' || (p->>'message_id'));
    RETURN jsonb_build_object('ok', true, 'result', 'CLIENT_INTERESTED', 'rfq_id', v_rfq.id);
  ELSIF v_action IN ('PRICE_OBJECTION', 'ALTERNATIVE_REQUEST') THEN
    UPDATE rfqs SET intent = 'PRICE_CHECK',
           preferred_airlines = ARRAY(SELECT DISTINCT unnest(preferred_airlines || ARRAY(SELECT jsonb_array_elements_text(coalesce(p->'requested_airlines', '[]'::jsonb))))),
           requirements = jsonb_set(requirements, '{preferred_airlines}',
                                    to_jsonb(ARRAY(SELECT DISTINCT unnest(ARRAY(SELECT jsonb_array_elements_text(coalesce(requirements->'preferred_airlines', '[]'::jsonb)))
                                                                         || ARRAY(SELECT jsonb_array_elements_text(coalesce(p->'requested_airlines', '[]'::jsonb))))))),
           selected_option_id = NULL, updated_at = now()
     WHERE id = v_rfq.id;
    PERFORM of_transition_rfq(v_rfq.id, 'READY_FOR_SEARCH', 'CLIENT', p->>'message_id',
                              CASE v_action WHEN 'PRICE_OBJECTION' THEN 'Agent asks for a cheaper fare' ELSE 'Agent asks for alternatives' END);
    RETURN jsonb_build_object('ok', true, 'result', 'BACK_TO_FARE_DESK', 'rfq_id', v_rfq.id, 'rfq_number', v_rfq.rfq_number,
                              'desk_note', CASE v_action WHEN 'PRICE_OBJECTION' THEN 'Price objection: ' ELSE 'Alternative requested: ' END || left(p->>'client_message', 300));
  ELSIF v_action = 'DECLINE' THEN
    PERFORM of_transition_rfq(v_rfq.id, 'LOST', 'CLIENT', p->>'message_id', 'Agent declined: ' || left(p->>'client_message', 200));
    RETURN jsonb_build_object('ok', true, 'result', 'LOST', 'rfq_id', v_rfq.id);
  ELSE
    PERFORM of_alert(v_rfq.id, 'HUMAN_REVIEW', 'WARNING', v_rfq.assigned_team, v_rfq.rfq_number || ': agent replied – needs an operator answer',
                     jsonb_build_object('message', left(p->>'client_message', 800), 'reason', p->>'reason'), 'REPLY:' || (p->>'message_id'));
    RETURN jsonb_build_object('ok', true, 'result', 'HUMAN_REVIEW', 'rfq_id', v_rfq.id);
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- WF15 — after-sales (change / cancellation / refund)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION of_create_after_sales_case(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_related rfqs%ROWTYPE; v_case rfqs%ROWTYPE; v_target text; v_type text; v_ref text := nullif(p->>'booking_reference', '');
  v_travel date := nullif(p->>'travel_date', '')::date;
BEGIN
  v_type := CASE p->>'intent' WHEN 'CHANGE_REQUEST' THEN 'CHANGE' WHEN 'CANCELLATION' THEN 'CANCELLATION' ELSE 'REFUND' END;
  v_target := CASE WHEN v_type = 'CHANGE' THEN 'CHANGE_REQUESTED' ELSE 'REFUND_REQUESTED' END;

  -- Find the booking: by reference, else the contact's ticketed booking closest to the mentioned travel date.
  IF v_ref IS NOT NULL THEN
    SELECT * INTO v_related FROM rfqs WHERE booking_reference = v_ref AND (contact_id = (p->>'contact_id')::uuid OR agency_id = (p->>'agency_id')::uuid)
     ORDER BY updated_at DESC LIMIT 1;
  END IF;
  IF v_related.id IS NULL THEN
    SELECT * INTO v_related FROM rfqs
     WHERE contact_id = (p->>'contact_id')::uuid AND status IN ('TICKETED', 'TICKETING', 'BOOKING_REQUESTED')
       AND (departure_date IS NULL OR departure_date >= current_date - 1)
     ORDER BY CASE WHEN v_travel IS NOT NULL AND departure_date = v_travel THEN 0 ELSE 1 END, departure_date NULLS LAST, updated_at DESC
     LIMIT 1;
  END IF;

  IF v_related.id IS NOT NULL AND v_related.status = 'TICKETED' THEN
    UPDATE rfqs SET intent = p->>'intent', after_sales_type = v_type, updated_at = now() WHERE id = v_related.id;
    PERFORM of_transition_rfq(v_related.id, v_target, 'CLIENT', p->>'message_id', left(p->>'summary', 200));
    UPDATE messages SET rfq_id = v_related.id WHERE id = (p->>'message_id')::uuid;
    PERFORM of_audit(v_related.id, 'rfq', v_related.id::text, v_target, 'CLIENT', p->>'message_id',
                     jsonb_build_object('booking_reference', coalesce(v_ref, v_related.booking_reference), 'summary', p->>'summary'));
    RETURN jsonb_build_object('ok', true, 'rfq_id', v_related.id, 'rfq_number', v_related.rfq_number, 'created', false, 'status', v_target,
                              'booking_reference', coalesce(v_ref, v_related.booking_reference), 'travel_date', v_related.departure_date,
                              'snapshot', of_rfq_snapshot(v_related.id));
  END IF;

  -- No ticketed booking found in the system: open a new after-sales case linked to whatever we found.
  INSERT INTO rfqs (rfq_number, agency_id, contact_id, conversation_id, related_rfq_id, intent, status, source_channel,
                    booking_reference, after_sales_type, departure_date, requirements, requires_human, human_review_reason)
  VALUES (of_next_rfq_number(), (p->>'agency_id')::uuid, (p->>'contact_id')::uuid, (p->>'conversation_id')::uuid, v_related.id,
          p->>'intent', 'NEW', p->>'channel', v_ref, v_type, coalesce(v_travel, v_related.departure_date),
          jsonb_build_object('intent', p->>'intent', 'summary', p->>'summary'), true,
          CASE WHEN v_related.id IS NULL THEN 'Booking not found in system – verify reference' ELSE 'Linked booking not yet ticketed' END)
  RETURNING * INTO v_case;
  INSERT INTO rfq_status_history (rfq_id, from_status, to_status, actor_type, actor_id, reason) VALUES (v_case.id, NULL, 'NEW', 'SYSTEM', p->>'workflow', 'After-sales case');
  PERFORM of_audit(v_case.id, 'rfq', v_case.id::text, 'RFQ_CREATED', 'SYSTEM', p->>'workflow',
                   jsonb_build_object('rfq_number', v_case.rfq_number, 'after_sales_type', v_type, 'related_rfq', v_related.rfq_number));
  PERFORM of_transition_rfq(v_case.id, v_target, 'CLIENT', p->>'message_id', left(p->>'summary', 200));
  UPDATE messages SET rfq_id = v_case.id WHERE id = (p->>'message_id')::uuid;
  RETURN jsonb_build_object('ok', true, 'rfq_id', v_case.id, 'rfq_number', v_case.rfq_number, 'created', true, 'status', v_target,
                            'booking_reference', v_ref, 'travel_date', coalesce(v_travel, v_related.departure_date), 'related_rfq', v_related.rfq_number,
                            'snapshot', of_rfq_snapshot(v_case.id));
END $$;

-- -----------------------------------------------------------------------------
-- Human operator actions from the ops console (WF17)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION of_operator_action(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_rfq rfqs%ROWTYPE; v_action text := upper(p->>'action'); v_by text := coalesce(nullif(p->>'operator', ''), 'operator');
BEGIN
  IF v_action IN ('RESOLVE_ALERT', 'ACK_ALERT') THEN
    UPDATE alerts SET status = CASE WHEN v_action = 'RESOLVE_ALERT' THEN 'RESOLVED' ELSE 'ACKNOWLEDGED' END,
           resolved_at = CASE WHEN v_action = 'RESOLVE_ALERT' THEN now() END, resolved_by = v_by
     WHERE id = (p->>'alert_id')::uuid;
    RETURN jsonb_build_object('ok', FOUND, 'action', v_action);
  END IF;
  IF v_action = 'RETRY_MESSAGE' THEN
    UPDATE messages SET processing_status = 'PENDING', retry_count = 0, next_retry_at = NULL
     WHERE id = (p->>'message_id')::uuid AND processing_status IN ('FAILED', 'DEAD_LETTER');
    RETURN jsonb_build_object('ok', FOUND, 'action', v_action,
                              'conversation_id', (SELECT conversation_id FROM messages WHERE id = (p->>'message_id')::uuid));
  END IF;

  SELECT * INTO v_rfq FROM rfqs WHERE id = CASE WHEN nullif(p->>'rfq_id', '') IS NOT NULL THEN (p->>'rfq_id')::uuid END OR rfq_number = p->>'rfq_number' FOR UPDATE;
  IF v_rfq.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'RFQ_NOT_FOUND'); END IF;

  BEGIN
    CASE v_action
      WHEN 'START_SEARCH' THEN PERFORM of_transition_rfq(v_rfq.id, 'SEARCHING', 'HUMAN', v_by, 'Fare search started');
      WHEN 'START_TICKETING' THEN PERFORM of_transition_rfq(v_rfq.id, 'TICKETING', 'HUMAN', v_by, 'Ticketing started');
      WHEN 'MARK_TICKETED' THEN
        IF coalesce(p->>'booking_reference', '') !~ '^[A-Z0-9]{6}$' THEN RETURN jsonb_build_object('ok', false, 'error', 'BOOKING_REFERENCE_REQUIRED'); END IF;
        UPDATE rfqs SET booking_reference = p->>'booking_reference' WHERE id = v_rfq.id;
        PERFORM of_transition_rfq(v_rfq.id, 'TICKETED', 'HUMAN', v_by, 'Ticketed – PNR ' || (p->>'booking_reference'));
        PERFORM of_audit(v_rfq.id, 'rfq', v_rfq.id::text, 'TICKETED', 'HUMAN', v_by, jsonb_build_object('booking_reference', p->>'booking_reference'));
      WHEN 'RESOLVE_AFTER_SALES' THEN
        PERFORM of_transition_rfq(v_rfq.id, CASE WHEN v_rfq.status = 'CHANGE_REQUESTED' THEN 'TICKETED' ELSE 'CLOSED' END, 'HUMAN', v_by, coalesce(p->>'note', 'After-sales request handled'));
      WHEN 'MARK_LOST' THEN PERFORM of_transition_rfq(v_rfq.id, 'LOST', 'HUMAN', v_by, coalesce(p->>'note', 'Marked lost'));
      WHEN 'CANCEL' THEN PERFORM of_transition_rfq(v_rfq.id, 'CANCELLED', 'HUMAN', v_by, coalesce(p->>'note', 'Cancelled by operator'));
      WHEN 'CLOSE' THEN PERFORM of_transition_rfq(v_rfq.id, 'CLOSED', 'HUMAN', v_by, coalesce(p->>'note', 'Closed'));
      WHEN 'REOPEN' THEN PERFORM of_transition_rfq(v_rfq.id, 'READY_FOR_SEARCH', 'HUMAN', v_by, coalesce(p->>'note', 'Reopened'));
      WHEN 'CLEAR_HUMAN_FLAG' THEN UPDATE rfqs SET requires_human = false, human_review_reason = NULL WHERE id = v_rfq.id;
      WHEN 'RESEND_QUOTE' THEN
        IF v_rfq.status <> 'APPROVED' THEN RETURN jsonb_build_object('ok', false, 'error', 'ONLY_APPROVED_QUOTES_CAN_BE_RESENT', 'status', v_rfq.status); END IF;
        PERFORM of_audit(v_rfq.id, 'rfq', v_rfq.id::text, 'OPERATOR_ACTION', 'HUMAN', v_by, jsonb_build_object('action', v_action));
        RETURN jsonb_build_object('ok', true, 'rfq_id', v_rfq.id, 'rfq_number', v_rfq.rfq_number, 'status', v_rfq.status,
                                  'quote_id', (SELECT id FROM quotes WHERE rfq_id = v_rfq.id AND status = 'APPROVED' ORDER BY version DESC LIMIT 1));
      ELSE RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_ACTION');
    END CASE;
  EXCEPTION WHEN raise_exception THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
  END;
  IF v_action IN ('RESOLVE_AFTER_SALES', 'CLOSE') THEN
    PERFORM of_audit(v_rfq.id, 'rfq', v_rfq.id::text, 'RFQ_CLOSED', 'HUMAN', v_by, jsonb_build_object('action', v_action, 'note', p->>'note'));
  END IF;
  PERFORM of_audit(v_rfq.id, 'rfq', v_rfq.id::text, 'OPERATOR_ACTION', 'HUMAN', v_by, jsonb_build_object('action', v_action, 'note', p->>'note'));
  RETURN jsonb_build_object('ok', true, 'rfq_id', v_rfq.id, 'rfq_number', v_rfq.rfq_number, 'status', (SELECT status FROM rfqs WHERE id = v_rfq.id));
END $$;

-- -----------------------------------------------------------------------------
-- Misc: opt-out, human review, knowledge base, security events
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION of_flag_message(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_msg messages%ROWTYPE; v_alert uuid;
BEGIN
  SELECT * INTO v_msg FROM messages WHERE id = (p->>'message_id')::uuid;
  IF p->>'kind' = 'OPT_OUT' THEN
    UPDATE contacts SET opted_out_followups = true, updated_at = now()
     WHERE id = (SELECT contact_id FROM conversations WHERE id = v_msg.conversation_id);
    PERFORM of_audit(nullif(p->>'rfq_id', '')::uuid, 'contact', (SELECT contact_id::text FROM conversations WHERE id = v_msg.conversation_id), 'CONTACT_OPTED_OUT', 'CLIENT', v_msg.sender, '{}'::jsonb);
    RETURN jsonb_build_object('ok', true);
  END IF;
  v_alert := of_alert(nullif(p->>'rfq_id', '')::uuid,
                      CASE WHEN p->>'kind' = 'SECURITY' THEN 'SECURITY' ELSE 'HUMAN_REVIEW' END,
                      coalesce(p->>'severity', 'WARNING'), coalesce(nullif(p->>'desk_code', ''), 'GENERAL_DESK'),
                      p->>'title', coalesce(p->'details', '{}'::jsonb) || jsonb_build_object('message_id', v_msg.id, 'excerpt', left(v_msg.content, 300),
                                    'kb_suggestions', CASE WHEN p->>'kind' = 'SECURITY' THEN '[]'::jsonb ELSE of_kb_search(jsonb_build_object('text', v_msg.content)) END),
                      coalesce(p->>'kind', 'REVIEW') || ':' || v_msg.id);
  PERFORM of_audit(nullif(p->>'rfq_id', '')::uuid, 'message', v_msg.id::text,
                   CASE WHEN p->>'kind' = 'SECURITY' THEN 'SECURITY_FLAGGED' ELSE 'HUMAN_REVIEW_REQUESTED' END, 'SYSTEM', p->>'workflow',
                   coalesce(p->'details', '{}'::jsonb));
  RETURN jsonb_build_object('ok', true, 'alert_id', v_alert);
END $$;

CREATE OR REPLACE FUNCTION of_kb_search(p jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('slug', slug, 'title', title, 'excerpt', left(content, 300))), '[]'::jsonb) FROM (
    SELECT slug, title, content FROM knowledge_base
     WHERE search @@ websearch_to_tsquery('english', regexp_replace(coalesce(p->>'text', ''), '[^A-Za-z0-9 ]', ' ', 'g'))
        OR search @@ plainto_tsquery('english', regexp_replace(coalesce(p->>'text', ''), '[^A-Za-z0-9 ]', ' ', 'g'))
     ORDER BY ts_rank(search, plainto_tsquery('english', regexp_replace(coalesce(p->>'text', ''), '[^A-Za-z0-9 ]', ' ', 'g'))) DESC
     LIMIT coalesce((p->>'limit')::int, 2)) k;
$$;

-- -----------------------------------------------------------------------------
-- WF99 — error handler (retry with backoff, dead letter)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION of_record_workflow_error(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_msg messages%ROWTYPE; v_dead boolean := false; v_alert uuid;
BEGIN
  SELECT * INTO v_msg FROM messages
   WHERE processing_execution_id = p->>'execution_id' AND processing_status = 'PROCESSING'
   ORDER BY processing_started_at DESC LIMIT 1;
  IF v_msg.id IS NOT NULL THEN
    v_dead := v_msg.retry_count + 1 >= 3;
    UPDATE messages SET processing_status = CASE WHEN v_dead THEN 'DEAD_LETTER' ELSE 'FAILED' END,
           retry_count = retry_count + 1,
           next_retry_at = CASE WHEN v_dead THEN NULL ELSE now() + (CASE retry_count WHEN 0 THEN interval '1 minute' WHEN 1 THEN interval '5 minutes' ELSE interval '15 minutes' END) END,
           processing_notes = coalesce(processing_notes, '{}'::jsonb) || jsonb_build_object('last_error', left(p->>'error_message', 500), 'failed_node', p->>'node')
     WHERE id = v_msg.id;
    UPDATE conversations SET locked_until = NULL, locked_by = NULL WHERE id = v_msg.conversation_id;
  END IF;
  INSERT INTO workflow_errors (workflow_id, workflow_name, execution_id, node, error_message, error_details, message_id, retryable)
  VALUES (p->>'workflow_id', p->>'workflow_name', p->>'execution_id', p->>'node', left(p->>'error_message', 2000), p->'details', v_msg.id, NOT v_dead);
  v_alert := of_alert(v_msg.rfq_id, 'WORKFLOW_ERROR', CASE WHEN v_dead THEN 'CRITICAL' ELSE 'WARNING' END, NULL,
                      coalesce(p->>'workflow_name', 'workflow') || ' failed' || CASE WHEN v_dead THEN ' – message moved to dead letter' ELSE ' – will retry' END,
                      jsonb_build_object('node', p->>'node', 'error', left(p->>'error_message', 500), 'execution_id', p->>'execution_id', 'message_id', v_msg.id),
                      'ERR:' || coalesce(p->>'workflow_id', '') || ':' || coalesce(v_msg.id::text, p->>'execution_id') || ':' || CASE WHEN v_dead THEN 'dead' ELSE (v_msg.retry_count + 1)::text END);
  PERFORM of_event(p, 'WORKFLOW_ERROR', 'ERROR', v_msg.rfq_id, v_msg.conversation_id, v_msg.id,
                   jsonb_build_object('node', p->>'node', 'error', left(p->>'error_message', 300), 'dead_letter', v_dead));
  RETURN jsonb_build_object('ok', true, 'message_id', v_msg.id, 'dead_letter', v_dead, 'alert_id', v_alert);
END $$;
