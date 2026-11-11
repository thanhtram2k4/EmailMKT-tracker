-- Suppressions can only be added, never changed or removed, by any code path (sync, import,
-- application). Lifting a suppression, if ever needed, must be designed as a separate, explicit,
-- audited mechanism, not an UPDATE or DELETE here.
CREATE OR REPLACE FUNCTION crm_prevent_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% not allowed)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER suppressions_no_update_delete
  BEFORE UPDATE OR DELETE ON "suppressions"
  FOR EACH ROW EXECUTE FUNCTION crm_prevent_change();
--> statement-breakpoint
CREATE TRIGGER suppressions_no_truncate
  BEFORE TRUNCATE ON "suppressions"
  FOR EACH STATEMENT EXECUTE FUNCTION crm_prevent_change();
--> statement-breakpoint
-- Consent history is append-only: a change of consent is a new row, never an edit.
CREATE TRIGGER consent_records_no_update_delete
  BEFORE UPDATE OR DELETE ON "consent_records"
  FOR EACH ROW EXECUTE FUNCTION crm_prevent_change();
--> statement-breakpoint
CREATE TRIGGER consent_records_no_truncate
  BEFORE TRUNCATE ON "consent_records"
  FOR EACH STATEMENT EXECUTE FUNCTION crm_prevent_change();
--> statement-breakpoint
-- An imported/synced record can never grant consent (defence in depth; the app also refuses).
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_import_never_grants"
  CHECK (NOT (status = 'granted' AND source IN ('notion_import', 'notion_unsubscribe', 'system')));
--> statement-breakpoint
-- A staff-entered grant must carry an evidence reference or note.
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_grant_requires_evidence"
  CHECK (status <> 'granted' OR coalesce(nullif(trim(evidence_ref), ''), nullif(trim(evidence_note), '')) IS NOT NULL);
