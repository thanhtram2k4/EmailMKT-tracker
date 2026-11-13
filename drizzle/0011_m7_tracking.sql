ALTER TABLE "message_events" ADD COLUMN "link_idx" integer;--> statement-breakpoint
ALTER TABLE "message_events" ADD COLUMN "ip_hash" text;--> statement-breakpoint
ALTER TABLE "message_events" ADD COLUMN "user_agent" text;--> statement-breakpoint
ALTER TABLE "message_events" ADD COLUMN "suspected_automated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "message_events" ADD COLUMN "flags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "tracking_enabled" boolean;--> statement-breakpoint
CREATE INDEX "message_events_activity_idx" ON "message_events" USING btree ("message_id","type","occurred_at");