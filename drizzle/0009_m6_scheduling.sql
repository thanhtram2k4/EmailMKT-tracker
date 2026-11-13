ALTER TYPE "public"."campaign_status" ADD VALUE 'scheduled' BEFORE 'queued';--> statement-breakpoint
ALTER TYPE "public"."campaign_status" ADD VALUE 'held_overdue' BEFORE 'queued';--> statement-breakpoint
CREATE TABLE "admin_alerts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"campaign_id" uuid,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email_status" text DEFAULT 'pending' NOT NULL,
	"email_detail" text,
	"emailed_at" timestamp with time zone,
	"acknowledged_by" text,
	"acknowledged_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "scheduled_at_utc" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "schedule_tz" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "schedule_local" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "schedule_offset_minutes" integer;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "scheduled_by" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "hold_reason" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "start_delay_ms" integer;--> statement-breakpoint
ALTER TABLE "admin_alerts" ADD CONSTRAINT "admin_alerts_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_alerts_open_idx" ON "admin_alerts" USING btree ("acknowledged_at","created_at");--> statement-breakpoint
CREATE INDEX "admin_alerts_email_idx" ON "admin_alerts" USING btree ("email_status");--> statement-breakpoint
CREATE INDEX "campaigns_due_idx" ON "campaigns" USING btree ("status","scheduled_at_utc");