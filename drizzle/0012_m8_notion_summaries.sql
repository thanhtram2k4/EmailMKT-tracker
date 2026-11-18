CREATE TABLE "campaign_notion_summaries" (
	"campaign_id" uuid PRIMARY KEY NOT NULL,
	"notion_page_id" text,
	"stages_done" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_stage" text,
	"last_written_at" timestamp with time zone,
	"last_error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "engagement_queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notion_connection" ADD COLUMN "campaigns_database_id" text;--> statement-breakpoint
ALTER TABLE "notion_connection" ADD COLUMN "campaigns_data_source_id" text;--> statement-breakpoint
ALTER TABLE "campaign_notion_summaries" ADD CONSTRAINT "campaign_notion_summaries_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;