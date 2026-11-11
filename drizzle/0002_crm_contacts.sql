CREATE TYPE "public"."consent_purpose" AS ENUM('marketing_email', 'email_tracking');--> statement-breakpoint
CREATE TYPE "public"."consent_source" AS ENUM('notion_import', 'notion_unsubscribe', 'staff_entry', 'unsubscribe_link', 'system');--> statement-breakpoint
CREATE TYPE "public"."consent_status" AS ENUM('unknown', 'granted', 'refused', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."contact_state" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."email_status" AS ENUM('valid', 'invalid', 'missing');--> statement-breakpoint
CREATE TYPE "public"."notion_connection_status" AS ENUM('connected', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."suppression_reason" AS ENUM('unsubscribe', 'hard_bounce', 'complaint', 'manual', 'notion_unsubscribed');--> statement-breakpoint
CREATE TYPE "public"."sync_mode" AS ENUM('full', 'incremental');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('running', 'succeeded', 'partial', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."sync_trigger" AS ENUM('manual', 'schedule', 'nightly', 'test');--> statement-breakpoint
CREATE TABLE "consent_records" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"email_normalized" text NOT NULL,
	"contact_id" uuid,
	"purpose" "consent_purpose" NOT NULL,
	"status" "consent_status" NOT NULL,
	"source" "consent_source" NOT NULL,
	"effective_at" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by" text NOT NULL,
	"evidence_ref" text,
	"evidence_note" text,
	"consent_text_version" text,
	"correlation_id" text
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notion_page_id" text NOT NULL,
	"notion_url" text,
	"full_name" text,
	"greeting_name" text,
	"email" text,
	"email_normalized" text,
	"email_status" "email_status" NOT NULL,
	"email_invalid_reason" text,
	"company" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"state" "contact_state" DEFAULT 'active' NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_reason" text,
	"issues" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_duplicate" boolean DEFAULT false NOT NULL,
	"notion_subscription_value" text,
	"notion_consent_evidence" text,
	"notion_last_edited_at" timestamp with time zone,
	"first_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sync_run_id" uuid,
	"last_emailed_at" timestamp with time zone,
	"last_engagement_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_notion_page_id_unique" UNIQUE("notion_page_id")
);
--> statement-breakpoint
CREATE TABLE "duplicate_resolutions" (
	"email_normalized" text PRIMARY KEY NOT NULL,
	"primary_contact_id" uuid NOT NULL,
	"decided_by" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "notion_connection" (
	"id" text PRIMARY KEY NOT NULL,
	"status" "notion_connection_status" NOT NULL,
	"token_ciphertext" text,
	"token_hint" text,
	"api_version" text NOT NULL,
	"database_id" text,
	"data_source_id" text,
	"database_title" text,
	"mapping" jsonb,
	"connected_by" text,
	"connected_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "notion_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"notion_page_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"reason" text,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"email_normalized" text PRIMARY KEY NOT NULL,
	"reason" "suppression_reason" NOT NULL,
	"source" text NOT NULL,
	"notion_value" text,
	"contact_id" uuid,
	"campaign_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "sync_issues" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"notion_page_id" text,
	"contact_id" uuid,
	"severity" text NOT NULL,
	"code" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mode" "sync_mode" NOT NULL,
	"trigger" "sync_trigger" NOT NULL,
	"status" "sync_status" NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"cursor_before" timestamp with time zone,
	"cursor_after" timestamp with time zone,
	"counts" jsonb,
	"error_code" text,
	"error_message" text,
	"requested_by" text NOT NULL,
	"correlation_id" text
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"id" text PRIMARY KEY NOT NULL,
	"incremental_cursor" timestamp with time zone,
	"last_full_sync_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_resolutions" ADD CONSTRAINT "duplicate_resolutions_primary_contact_id_contacts_id_fk" FOREIGN KEY ("primary_contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_issues" ADD CONSTRAINT "sync_issues_run_id_sync_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sync_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consent_records_lookup_idx" ON "consent_records" USING btree ("email_normalized","purpose","id");--> statement-breakpoint
CREATE INDEX "contacts_email_normalized_idx" ON "contacts" USING btree ("email_normalized");--> statement-breakpoint
CREATE INDEX "contacts_state_idx" ON "contacts" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "notion_outbox_one_pending_idx" ON "notion_outbox" USING btree ("notion_page_id","kind") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "notion_outbox_due_idx" ON "notion_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "sync_issues_run_idx" ON "sync_issues" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "sync_runs_started_idx" ON "sync_runs" USING btree ("started_at");