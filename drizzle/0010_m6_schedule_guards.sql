-- M6: campaign guard updated for scheduling.
--  * The approved snapshot still cannot be swapped, with ONE exception: a scheduled (or held) campaign
--    may return to draft (DESIGN §3.4 "edit after scheduling"), which clears the snapshot; the old
--    snapshot and its messages stay as history (messages are cancelled by the application).
--  * A scheduled or held campaign must carry its schedule (UTC time, zone, local time).
--  * Campaigns are still never deleted, and schedule_revision never decreases.
-- Status literals are compared as text inside plpgsql (evaluated at run time), because enum values
-- added by 0009 cannot be referenced by constraints in the same migration transaction.
CREATE OR REPLACE FUNCTION campaigns_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'campaigns cannot be deleted';
  END IF;
  IF OLD.snapshot_id IS NOT NULL AND NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id THEN
    IF NOT (NEW.snapshot_id IS NULL AND NEW.status::text = 'draft'
            AND OLD.status::text IN ('scheduled', 'held_overdue')
            AND NEW.schedule_revision > OLD.schedule_revision) THEN
      RAISE EXCEPTION 'the approved snapshot of a campaign cannot be changed';
    END IF;
  END IF;
  IF NEW.schedule_revision < OLD.schedule_revision THEN
    RAISE EXCEPTION 'schedule_revision cannot decrease';
  END IF;
  IF NEW.status::text IN ('scheduled', 'held_overdue')
     AND (NEW.scheduled_at_utc IS NULL OR NEW.schedule_tz IS NULL OR NEW.snapshot_id IS NULL) THEN
    RAISE EXCEPTION 'a scheduled campaign needs an approved snapshot, a UTC time and a time zone';
  END IF;
  RETURN NEW;
END $$;
