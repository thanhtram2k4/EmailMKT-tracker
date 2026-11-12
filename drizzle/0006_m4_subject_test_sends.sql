CREATE TYPE "public"."test_send_status" AS ENUM('claimed', 'accepted', 'rejected', 'retryable', 'unknown', 'refused');--> statement-breakpoint
CREATE TABLE "test_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"template_id" uuid NOT NULL,
	"template_version_id" uuid NOT NULL,
	"requested_by" text NOT NULL,
	"recipient_email" text NOT NULL,
	"merge_source" text NOT NULL,
	"rendered_subject" text,
	"status" "test_send_status" NOT NULL,
	"transport" text,
	"provider_message_id" text,
	"error_code" text,
	"error_message" text,
	"send_mode" text NOT NULL,
	"authorization_ref" text,
	"request_id" text,
	"resend_of" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "template_versions" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "template_versions" ADD COLUMN "preheader" text;--> statement-breakpoint
ALTER TABLE "test_sends" ADD CONSTRAINT "test_sends_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_sends" ADD CONSTRAINT "test_sends_template_version_id_template_versions_id_fk" FOREIGN KEY ("template_version_id") REFERENCES "public"."template_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "test_sends_idem_idx" ON "test_sends" USING btree ("idempotency_key","recipient_email");--> statement-breakpoint
CREATE INDEX "test_sends_template_idx" ON "test_sends" USING btree ("template_id","created_at");--> statement-breakpoint
CREATE INDEX "test_sends_requested_by_idx" ON "test_sends" USING btree ("requested_by","created_at");--> statement-breakpoint
CREATE INDEX "test_sends_status_idx" ON "test_sends" USING btree ("status","claimed_at");--> statement-breakpoint
-- Test-send status moves forward only. A send is claimed before the provider call; afterwards it
-- may only become a final outcome. "unknown" can later be reconciled to "accepted" (provider
-- evidence) but never goes back to "claimed", so nothing is ever re-sent automatically.
-- Rows are never deleted (evidence).
CREATE FUNCTION test_sends_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'test_sends rows cannot be deleted';
  END IF;
  IF NEW.id <> OLD.id OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.recipient_email <> OLD.recipient_email
     OR NEW.template_version_id <> OLD.template_version_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'test_sends identity columns are immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'claimed' AND NEW.status IN ('accepted', 'rejected', 'retryable', 'unknown'))
    OR (OLD.status = 'unknown' AND NEW.status = 'accepted')
  ) THEN
    RAISE EXCEPTION 'illegal test_sends status change % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER test_sends_guard BEFORE UPDATE OR DELETE ON "test_sends" FOR EACH ROW EXECUTE FUNCTION test_sends_guard();
