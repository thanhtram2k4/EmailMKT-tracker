-- M5 send-engine guards (defence in depth; the application follows the same rules).

-- Approved snapshots, their recipients and link tables are immutable.
CREATE TRIGGER campaign_snapshots_no_update_delete
  BEFORE UPDATE OR DELETE ON "campaign_snapshots"
  FOR EACH ROW EXECUTE FUNCTION crm_prevent_change();
--> statement-breakpoint
CREATE TRIGGER campaign_recipients_no_update_delete
  BEFORE UPDATE OR DELETE ON "campaign_recipients"
  FOR EACH ROW EXECUTE FUNCTION crm_prevent_change();
--> statement-breakpoint
CREATE TRIGGER campaign_links_no_update_delete
  BEFORE UPDATE OR DELETE ON "campaign_links"
  FOR EACH ROW EXECUTE FUNCTION crm_prevent_change();
--> statement-breakpoint
-- The campaign status history is append-only.
CREATE TRIGGER campaign_transitions_no_update_delete
  BEFORE UPDATE OR DELETE ON "campaign_transitions"
  FOR EACH ROW EXECUTE FUNCTION crm_prevent_change();
--> statement-breakpoint
-- Campaigns are never deleted, and the approved snapshot can never be swapped.
CREATE FUNCTION campaigns_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'campaigns cannot be deleted';
  END IF;
  IF OLD.snapshot_id IS NOT NULL AND NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id THEN
    RAISE EXCEPTION 'the approved snapshot of a campaign cannot be changed';
  END IF;
  IF NEW.schedule_revision < OLD.schedule_revision THEN
    RAISE EXCEPTION 'schedule_revision cannot decrease';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER campaigns_guard BEFORE UPDATE OR DELETE ON "campaigns" FOR EACH ROW EXECUTE FUNCTION campaigns_guard();
--> statement-breakpoint
-- Message send status moves forward only (DESIGN §3.4):
--   pending  -> claimed | skipped | cancelled
--   claimed  -> sent | failed_permanent | unknown | skipped | cancelled
--   claimed  -> pending   only as an explicit release (provider confirmed NOT accepted, or the
--                         campaign stopped before the call): release_reason set, claim cleared
--   unknown  -> sent (event evidence) | marked_not_sent (staff)
--   unknown  -> pending   only as a staff "resend" decision: attempt_no + 1, resolution recorded
--   marked_not_sent -> sent (event evidence)
-- A stale claim can therefore never silently become sendable again. Rows are never deleted.
CREATE FUNCTION messages_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'messages rows cannot be deleted';
  END IF;
  IF NEW.id <> OLD.id OR NEW.campaign_id <> OLD.campaign_id OR NEW.snapshot_id <> OLD.snapshot_id
     OR NEW.recipient_id <> OLD.recipient_id OR NEW.email_normalized <> OLD.email_normalized
     OR NEW.tracking_token <> OLD.tracking_token OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'messages identity columns are immutable';
  END IF;
  IF NEW.attempt_no < OLD.attempt_no THEN
    RAISE EXCEPTION 'attempt_no cannot decrease';
  END IF;
  IF NEW.send_status = OLD.send_status THEN
    IF NEW.attempt_no <> OLD.attempt_no THEN
      RAISE EXCEPTION 'attempt_no changes only with a resend decision';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.send_status = 'pending' AND NEW.send_status IN ('claimed', 'skipped', 'cancelled'))
     OR (OLD.send_status = 'claimed' AND NEW.send_status IN ('sent', 'failed_permanent', 'unknown', 'skipped', 'cancelled'))
     OR (OLD.send_status = 'claimed' AND NEW.send_status = 'pending'
         AND NEW.release_reason IS NOT NULL AND NEW.claimed_at IS NULL AND NEW.attempt_no = OLD.attempt_no)
     OR (OLD.send_status = 'unknown' AND NEW.send_status IN ('sent', 'marked_not_sent'))
     OR (OLD.send_status = 'unknown' AND NEW.send_status = 'pending'
         AND NEW.attempt_no = OLD.attempt_no + 1 AND NEW.resolution = 'resend_approved' AND NEW.resolved_by IS NOT NULL)
     OR (OLD.send_status = 'marked_not_sent' AND NEW.send_status = 'sent') THEN
    IF NEW.send_status <> 'pending' AND NEW.attempt_no <> OLD.attempt_no THEN
      RAISE EXCEPTION 'attempt_no changes only with a resend decision';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'illegal messages send_status change % -> %', OLD.send_status, NEW.send_status;
END $$;
--> statement-breakpoint
CREATE TRIGGER messages_guard BEFORE UPDATE OR DELETE ON "messages" FOR EACH ROW EXECUTE FUNCTION messages_guard();
--> statement-breakpoint
CREATE TRIGGER messages_no_truncate BEFORE TRUNCATE ON "messages" FOR EACH STATEMENT EXECUTE FUNCTION crm_prevent_change();
