-- Persist the complete after-sales request when an existing TICKETED RFQ is reused.
BEGIN;

CREATE OR REPLACE FUNCTION of_create_after_sales_case(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_related rfqs%ROWTYPE; v_case rfqs%ROWTYPE; v_target text; v_type text; v_ref text := nullif(p->>'booking_reference', '');
  v_requested_departure date := coalesce(nullif(p->>'requested_departure_date', ''), nullif(p->>'travel_date', ''))::date;
  v_requested_return date := nullif(p->>'requested_return_date', '')::date;
  v_clarification boolean := coalesce((p->>'clarification_required')::boolean, false);
  v_parent jsonb;
BEGIN
  v_type := CASE p->>'intent' WHEN 'CHANGE_REQUEST' THEN 'CHANGE' WHEN 'CANCELLATION' THEN 'CANCELLATION' ELSE 'REFUND' END;
  v_target := CASE WHEN v_type = 'CHANGE' THEN 'CHANGE_REQUESTED' ELSE 'REFUND_REQUESTED' END;

  v_parent := of_find_after_sales_parent(p);
  IF nullif(v_parent->>'parent_rfq_id', '') IS NOT NULL THEN
    SELECT * INTO v_related FROM rfqs WHERE id = (v_parent->>'parent_rfq_id')::uuid;
  END IF;

  IF v_related.id IS NOT NULL AND v_related.status = 'TICKETED' THEN
    UPDATE rfqs SET
      intent = p->>'intent',
      after_sales_type = v_type,
      requirements = coalesce(requirements, '{}'::jsonb) || jsonb_build_object(
        'intent', p->>'intent',
        'after_sales_type', v_type,
        'summary', p->>'summary',
        'client_message', coalesce(p->>'client_message', p->>'summary'),
        'parent_rfq_id', v_related.id,
        'parent_rfq_number', v_related.rfq_number,
        'original', v_parent,
        'requested_departure_date', v_requested_departure,
        'requested_return_date', v_requested_return,
        'requested_changes', jsonb_build_object('departure_date', v_requested_departure, 'return_date', v_requested_return),
        'clarification_required', v_clarification,
        'ambiguities', coalesce(p->'ambiguities', '[]'::jsonb)),
      missing_fields = CASE
        WHEN v_clarification THEN ARRAY(SELECT DISTINCT field FROM unnest(coalesce(missing_fields, '{}'::text[]) || ARRAY['requested_change_date']) AS u(field))
        ELSE array_remove(coalesce(missing_fields, '{}'::text[]), 'requested_change_date')
      END,
      requires_human = true,
      human_review_reason = CASE WHEN v_clarification THEN 'Clarification required: exact travel date needed' ELSE 'After-sales request requires operator review' END,
      updated_at = now()
    WHERE id = v_related.id;
    PERFORM of_transition_rfq(v_related.id, v_target, 'CLIENT', p->>'message_id', left(p->>'summary', 200));
    UPDATE messages SET rfq_id = v_related.id WHERE id = (p->>'message_id')::uuid;
    PERFORM of_audit(v_related.id, 'rfq', v_related.id::text, v_target, 'CLIENT', p->>'message_id',
                     jsonb_build_object(
                       'booking_reference', coalesce(v_ref, v_related.booking_reference),
                       'summary', p->>'summary', 'client_message', coalesce(p->>'client_message', p->>'summary'),
                       'requested_changes', jsonb_build_object('departure_date', v_requested_departure, 'return_date', v_requested_return),
                       'clarification_required', v_clarification, 'ambiguities', coalesce(p->'ambiguities', '[]'::jsonb),
                       'original', v_parent));
    RETURN jsonb_build_object('ok', true, 'rfq_id', v_related.id, 'rfq_number', v_related.rfq_number, 'created', false, 'status', v_target,
                              'booking_reference', coalesce(v_ref, v_related.booking_reference), 'travel_date', v_related.departure_date,
                              'requested_departure_date', v_requested_departure, 'requested_return_date', v_requested_return,
                              'clarification_required', v_clarification, 'parent_context', v_parent,
                              'snapshot', of_rfq_snapshot(v_related.id));
  END IF;

  -- No ticketed booking found in the system: open a new after-sales case linked to whatever we found.
  INSERT INTO rfqs (rfq_number, agency_id, contact_id, conversation_id, related_rfq_id, intent, status, source_channel,
                    booking_reference, after_sales_type, trip_type, cabin, origin_iata, destination_iata,
                    departure_date, return_date, adults, children, infants, preferred_airlines,
                    requirements, missing_fields, requires_human, human_review_reason)
  VALUES (of_next_rfq_number(), (p->>'agency_id')::uuid, (p->>'contact_id')::uuid, (p->>'conversation_id')::uuid, v_related.id,
          p->>'intent', 'NEW', p->>'channel', coalesce(v_ref, v_related.booking_reference), v_type,
          v_related.trip_type, v_related.cabin, v_related.origin_iata, v_related.destination_iata,
          coalesce(v_requested_departure, v_related.departure_date), coalesce(v_requested_return, v_related.return_date),
          v_related.adults, coalesce(v_related.children, 0), coalesce(v_related.infants, 0), coalesce(v_related.preferred_airlines, '{}'),
          jsonb_build_object(
            'intent', p->>'intent', 'summary', p->>'summary', 'client_message', coalesce(p->>'client_message', p->>'summary'),
            'trip_type', v_related.trip_type,
            'origin', jsonb_build_object('iata', v_related.origin_iata),
            'destination', jsonb_build_object('iata', v_related.destination_iata),
            'departure_date', coalesce(v_requested_departure, v_related.departure_date),
            'return_date', coalesce(v_requested_return, v_related.return_date),
            'passengers', jsonb_build_object('adults', v_related.adults, 'children', coalesce(v_related.children, 0), 'infants', coalesce(v_related.infants, 0)),
            'cabin', v_related.cabin, 'preferred_airlines', to_jsonb(coalesce(v_related.preferred_airlines, '{}')),
            'parent_rfq_id', v_related.id, 'parent_rfq_number', v_related.rfq_number,
            'original', v_parent,
            'requested_changes', jsonb_build_object('departure_date', v_requested_departure, 'return_date', v_requested_return),
            'clarification_required', v_clarification, 'ambiguities', coalesce(p->'ambiguities', '[]'::jsonb)),
          CASE
            WHEN v_related.id IS NULL AND v_clarification THEN ARRAY['parent_booking_context', 'requested_change_date']::text[]
            WHEN v_related.id IS NULL THEN ARRAY['parent_booking_context']::text[]
            WHEN v_clarification THEN ARRAY['requested_change_date']::text[]
            ELSE '{}'::text[]
          END, true,
          CASE WHEN v_related.id IS NULL THEN 'Booking not found in system – verify reference' ELSE 'Linked booking not yet ticketed' END)
  RETURNING * INTO v_case;
  INSERT INTO rfq_status_history (rfq_id, from_status, to_status, actor_type, actor_id, reason) VALUES (v_case.id, NULL, 'NEW', 'SYSTEM', p->>'workflow', 'After-sales case');
  PERFORM of_audit(v_case.id, 'rfq', v_case.id::text, 'RFQ_CREATED', 'SYSTEM', p->>'workflow',
                   jsonb_build_object('rfq_number', v_case.rfq_number, 'after_sales_type', v_type, 'related_rfq', v_related.rfq_number));
  PERFORM of_transition_rfq(v_case.id, v_target, 'CLIENT', p->>'message_id', left(p->>'summary', 200));
  UPDATE messages SET rfq_id = v_case.id WHERE id = (p->>'message_id')::uuid;
  RETURN jsonb_build_object('ok', true, 'rfq_id', v_case.id, 'rfq_number', v_case.rfq_number, 'created', true, 'status', v_target,
                            'booking_reference', coalesce(v_ref, v_related.booking_reference),
                            'travel_date', coalesce(v_requested_departure, v_related.departure_date),
                            'requested_departure_date', v_requested_departure, 'requested_return_date', v_requested_return,
                            'clarification_required', v_clarification,
                            'parent_rfq_id', v_related.id, 'parent_rfq_number', v_related.rfq_number,
                            'related_rfq', v_related.rfq_number, 'parent_context', v_parent,
                            'snapshot', of_rfq_snapshot(v_case.id));
END $$;

COMMIT;
