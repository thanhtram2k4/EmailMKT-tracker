CREATE TYPE "public"."template_editor" AS ENUM('import', 'structured', 'grapesjs');--> statement-breakpoint
CREATE TYPE "public"."template_source" AS ENUM('upload', 'paste', 'fixture');--> statement-breakpoint
CREATE TABLE "template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"base_version_id" uuid,
	"editor" "template_editor" NOT NULL,
	"html" text NOT NULL,
	"plain_text" text NOT NULL,
	"ops" jsonb,
	"sanitize_report" jsonb,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"source_kind" "template_source" NOT NULL,
	"source_filename" text,
	"source_sha256" text,
	"extract_selector" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "template_versions_no_idx" ON "template_versions" USING btree ("template_id","version_no");