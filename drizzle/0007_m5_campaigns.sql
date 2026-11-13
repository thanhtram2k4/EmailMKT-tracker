CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'queued', 'sending', 'paused', 'blocked', 'cancelling', 'cancelled', 'completed', 'completed_with_issues', 'failed');--> statement-breakpoint
CREATE TYPE "public"."message_delivery_status" AS ENUM('none', 'delayed', 'delivered', 'bounced_soft', 'bounced_hard', 'complained', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."message_event_type" AS ENUM('send', 'delivery', 'bounce_hard', 'bounce_soft', 'complaint', 'reject', 'delay', 'rendering_failure', 'open', 'click', 'unsubscribe');--> statement-breakpoint
CREATE TYPE "public"."message_send_status" AS ENUM('pending', 'claimed', 'sent', 'failed_permanent', 'skipped', 'cancelled', 'unknown', 'marked_not_sent');--> statement-breakpoint
CREATE TABLE "campaign_links" (
	"snapshot_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"url" text NOT NULL,
	"label" text
);
--> statement-breakpoint
CREATE TABLE "campaign_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"contact_id" uuid,
	"email_normalized" text NOT NULL,
	"merge_values" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"schedule_revision" integer NOT NULL,
	"template_version_id" uuid NOT NULL,
	"subject_template" text NOT NULL,
	"html" text NOT NULL,
	"plain_text" text NOT NULL,
	"from_address" text NOT NULL,
	"content_hash" text NOT NULL,
	"audience" jsonb NOT NULL,
	"counts" jsonb NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_transitions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text,
	"schedule_revision" integer NOT NULL,
	"detail" jsonb,
	"correlation_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"template_id" uuid NOT NULL,
	"template_version_id" uuid NOT NULL,
	"audience" jsonb NOT NULL,
	"snapshot_id" uuid,
	"schedule_revision" integer DEFAULT 0 NOT NULL,
	"block_code" text,
	"block_message" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"processing_started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"message_id" uuid,
	"campaign_id" uuid,
	"test_send_id" uuid,
	"type" "message_event_type" NOT NULL,
	"provider_event_id" text,
	"provider_message_id" text,
	"occurred_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"detail" jsonb,
	CONSTRAINT "message_events_provider_event_id_unique" UNIQUE("provider_event_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"email_normalized" text NOT NULL,
	"tracking_token" text NOT NULL,
	"send_status" "message_send_status" DEFAULT 'pending' NOT NULL,
	"delivery_status" "message_delivery_status" DEFAULT 'none' NOT NULL,
	"skip_reason" text,
	"attempt_no" integer DEFAULT 1 NOT NULL,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"release_reason" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"throttle_count" integer DEFAULT 0 NOT NULL,
	"send_started_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"provider_message_id" text,
	"error_code" text,
	"last_error" text,
	"resolution" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_tracking_token_unique" UNIQUE("tracking_token")
);
--> statement-breakpoint
ALTER TABLE "campaign_links" ADD CONSTRAINT "campaign_links_snapshot_id_campaign_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."campaign_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_snapshot_id_campaign_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."campaign_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_snapshots" ADD CONSTRAINT "campaign_snapshots_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_snapshots" ADD CONSTRAINT "campaign_snapshots_template_version_id_template_versions_id_fk" FOREIGN KEY ("template_version_id") REFERENCES "public"."template_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_transitions" ADD CONSTRAINT "campaign_transitions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_template_version_id_template_versions_id_fk" FOREIGN KEY ("template_version_id") REFERENCES "public"."template_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_snapshot_id_campaign_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."campaign_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_recipient_id_campaign_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."campaign_recipients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_links_pk" ON "campaign_links" USING btree ("snapshot_id","idx");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_recipients_email_idx" ON "campaign_recipients" USING btree ("snapshot_id","email_normalized");--> statement-breakpoint
CREATE INDEX "campaign_transitions_campaign_idx" ON "campaign_transitions" USING btree ("campaign_id","id");--> statement-breakpoint
CREATE INDEX "campaigns_status_idx" ON "campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "message_events_message_idx" ON "message_events" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "message_events_campaign_idx" ON "message_events" USING btree ("campaign_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_snapshot_recipient_idx" ON "messages" USING btree ("snapshot_id","recipient_id");--> statement-breakpoint
CREATE INDEX "messages_dispatch_idx" ON "messages" USING btree ("campaign_id","send_status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "messages_claimed_idx" ON "messages" USING btree ("send_status","claimed_at");--> statement-breakpoint
CREATE INDEX "messages_provider_idx" ON "messages" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "messages_email_idx" ON "messages" USING btree ("email_normalized");