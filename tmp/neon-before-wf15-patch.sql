-- Neon backup before WF15 after-sales patch.
-- of_find_after_sales_parent(jsonb): NOT PRESENT before patch.

CREATE OR REPLACE FUNCTION public.of_create_after_sales_case(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
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
END $function$
