/**
 * Drizzle schema. Migrations are generated into ./drizzle with `npm run db:generate`.
 *
 * Tables `user`, `session`, `account`, `verification` are owned by Better Auth
 * (model names must stay as-is). Everything else is application-owned.
 */
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

// ---------------------------------------------------------------- Better Auth
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: ts("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    refreshTokenExpiresAt: ts("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

// ---------------------------------------------------------------- Application
export const staffRole = pgEnum("staff_role", ["admin", "member"]);

/**
 * Who may sign in, and with which role. Source of truth for authorization:
 * a valid Google (or local dev) identity is necessary but not sufficient.
 */
export const staffAllowlist = pgTable("staff_allowlist", {
  /** Lower-cased email address. */
  email: text("email").primaryKey(),
  role: staffRole("role").notNull(),
  addedBy: text("added_by").notNull(),
  addedAt: ts("added_at").notNull().defaultNow(),
  /** Non-null means access revoked; row kept for audit. */
  disabledAt: ts("disabled_at"),
  disabledBy: text("disabled_by"),
});

/** Append-only audit trail. Never updated or deleted by application code. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: ts("at").notNull().defaultNow(),
    /** e.g. "user:<id>", "cli:<os-user>", "system", "anonymous" */
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    /** Correlation id (request id / job id) for joining with logs. */
    correlationId: text("correlation_id"),
  },
  (t) => [index("audit_log_at_idx").on(t.at), index("audit_log_entity_idx").on(t.entityType, t.entityId)],
);

/** Runtime-adjustable settings (key → JSON value). Changes are audited. */
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  updatedBy: text("updated_by").notNull(),
});

/** Liveness of background worker processes, read by /healthz. */
export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: text("worker_id").primaryKey(),
  hostname: text("hostname").notNull(),
  pid: text("pid").notNull(),
  buildId: text("build_id").notNull(),
  startedAt: ts("started_at").notNull(),
  lastSeenAt: ts("last_seen_at").notNull(),
  stoppedAt: ts("stopped_at"),
});

/**
 * Results of `system_probe` jobs. Used by tests and smoke checks to prove the
 * worker actually executes queued jobs (including jobs queued while it was down).
 */
export const systemProbes = pgTable("system_probes", {
  probeId: uuid("probe_id").primaryKey(),
  enqueuedAt: ts("enqueued_at").notNull(),
  ranAt: ts("ran_at").notNull().default(sql`now()`),
  workerId: text("worker_id").notNull(),
  jobId: text("job_id").notNull(),
});

// ================================================================ M2: CRM (Notion)
// Field ownership (DESIGN §3.3): Notion owns full name, greeting name, email, company, tags.
// The app owns suppression/subscription state, consent records, last emailed/engagement.

const emptyTextArray = sql`'{}'::text[]`;

export const contactState = pgEnum("contact_state", ["active", "archived"]);
export const emailStatus = pgEnum("email_status", ["valid", "invalid", "missing"]);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Stable identity: the Notion page id. An email change keeps the same contact. */
    notionPageId: text("notion_page_id").notNull().unique(),
    notionUrl: text("notion_url"),
    fullName: text("full_name"),
    greetingName: text("greeting_name"),
    email: text("email"),
    emailNormalized: text("email_normalized"),
    emailStatus: emailStatus("email_status").notNull(),
    emailInvalidReason: text("email_invalid_reason"),
    company: text("company"),
    tags: text("tags").array().notNull().default(emptyTextArray),
    state: contactState("state").notNull().default("active"),
    archivedAt: ts("archived_at"),
    archivedReason: text("archived_reason"),
    /** Data-quality issue codes (see src/lib/crm/contact-validation.ts). */
    issues: text("issues").array().notNull().default(emptyTextArray),
    isDuplicate: boolean("is_duplicate").notNull().default(false),
    /** Last values seen in Notion for app-managed / evidence columns (read-only mirrors). */
    notionSubscriptionValue: text("notion_subscription_value"),
    notionConsentEvidence: text("notion_consent_evidence"),
    notionLastEditedAt: ts("notion_last_edited_at"),
    firstSyncedAt: ts("first_synced_at").notNull().defaultNow(),
    lastSyncedAt: ts("last_synced_at").notNull().defaultNow(),
    lastSyncRunId: uuid("last_sync_run_id"),
    // App-owned engagement fields (written from M5/M7, mirrored to Notion).
    lastEmailedAt: ts("last_emailed_at"),
    lastEngagementAt: ts("last_engagement_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("contacts_email_normalized_idx").on(t.emailNormalized), index("contacts_state_idx").on(t.state)],
);

/** Admin decision for a duplicate email group: which Notion page is the primary contact. */
export const duplicateResolutions = pgTable("duplicate_resolutions", {
  emailNormalized: text("email_normalized").primaryKey(),
  primaryContactId: uuid("primary_contact_id")
    .notNull()
    .references(() => contacts.id),
  decidedBy: text("decided_by").notNull(),
  decidedAt: ts("decided_at").notNull().defaultNow(),
  note: text("note"),
});

export const suppressionReason = pgEnum("suppression_reason", [
  "unsubscribe",
  "hard_bounce",
  "complaint",
  "manual",
  "notion_unsubscribed",
]);

/**
 * Suppression list keyed by normalized email (follows the address, not the Notion page).
 * Rows can never be updated or deleted (DB trigger): sync and imports can only ADD suppressions.
 */
export const suppressions = pgTable("suppressions", {
  emailNormalized: text("email_normalized").primaryKey(),
  reason: suppressionReason("reason").notNull(),
  source: text("source").notNull(),
  /** Raw Notion value that caused it, when source = notion_sync. */
  notionValue: text("notion_value"),
  contactId: uuid("contact_id"),
  campaignId: uuid("campaign_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: text("created_by").notNull(),
  note: text("note"),
});

export const consentPurpose = pgEnum("consent_purpose", ["marketing_email", "email_tracking"]);
export const consentStatus = pgEnum("consent_status", ["unknown", "granted", "refused", "withdrawn"]);
export const consentSource = pgEnum("consent_source", [
  "notion_import",
  "notion_unsubscribe",
  "staff_entry",
  "unsubscribe_link",
  "system",
]);

/**
 * Append-only consent history per address and purpose (DB trigger blocks UPDATE/DELETE).
 * Current state = latest row by id for (email_normalized, purpose); no row = unknown.
 * Imports never create `granted` rows — consent can only be granted by an explicit staff entry
 * with evidence (or, later, a consent form). See docs/COMPLIANCE.md.
 */
export const consentRecords = pgTable(
  "consent_records",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    emailNormalized: text("email_normalized").notNull(),
    contactId: uuid("contact_id").references(() => contacts.id),
    purpose: consentPurpose("purpose").notNull(),
    status: consentStatus("status").notNull(),
    source: consentSource("source").notNull(),
    /** When consent was given/refused/withdrawn according to the evidence (may precede recordedAt). */
    effectiveAt: ts("effective_at"),
    recordedAt: ts("recorded_at").notNull().defaultNow(),
    recordedBy: text("recorded_by").notNull(),
    /** Pointer to evidence: form submission id, document URL, ticket, Notion "Consent evidence" value. */
    evidenceRef: text("evidence_ref"),
    evidenceNote: text("evidence_note"),
    consentTextVersion: text("consent_text_version"),
    correlationId: text("correlation_id"),
  },
  (t) => [index("consent_records_lookup_idx").on(t.emailNormalized, t.purpose, t.id)],
);

export const notionConnectionStatus = pgEnum("notion_connection_status", ["connected", "disconnected"]);

/** Single Notion workspace connection (row id "default"). The token is stored encrypted only. */
export const notionConnection = pgTable("notion_connection", {
  id: text("id").primaryKey(),
  status: notionConnectionStatus("status").notNull(),
  tokenCiphertext: text("token_ciphertext"),
  /** Last 4 characters only, for display. */
  tokenHint: text("token_hint"),
  apiVersion: text("api_version").notNull(),
  databaseId: text("database_id"),
  dataSourceId: text("data_source_id"),
  databaseTitle: text("database_title"),
  /** App field → Notion property name. */
  mapping: jsonb("mapping"),
  connectedBy: text("connected_by"),
  connectedAt: ts("connected_at"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  lastVerifiedAt: ts("last_verified_at"),
  lastError: text("last_error"),
});

export const syncMode = pgEnum("sync_mode", ["full", "incremental"]);
export const syncTrigger = pgEnum("sync_trigger", ["manual", "schedule", "nightly", "test"]);
export const syncStatus = pgEnum("sync_status", ["running", "succeeded", "partial", "failed", "skipped"]);

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mode: syncMode("mode").notNull(),
    trigger: syncTrigger("trigger").notNull(),
    status: syncStatus("status").notNull(),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
    cursorBefore: ts("cursor_before"),
    cursorAfter: ts("cursor_after"),
    counts: jsonb("counts"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    requestedBy: text("requested_by").notNull(),
    correlationId: text("correlation_id"),
  },
  (t) => [index("sync_runs_started_idx").on(t.startedAt)],
);

/** Singleton sync cursor state (row id "notion"). */
export const syncState = pgTable("sync_state", {
  id: text("id").primaryKey(),
  incrementalCursor: ts("incremental_cursor"),
  lastFullSyncAt: ts("last_full_sync_at"),
  lastSuccessAt: ts("last_success_at"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Page-level problems found during a sync run (data issues and processing errors). */
export const syncIssues = pgTable(
  "sync_issues",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => syncRuns.id),
    notionPageId: text("notion_page_id"),
    contactId: uuid("contact_id"),
    /** "data" (bad/unexpected value in Notion) or "error" (processing failure). */
    severity: text("severity").notNull(),
    code: text("code").notNull(),
    message: text("message").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("sync_issues_run_idx").on(t.runId)],
);

export const outboxStatus = pgEnum("outbox_status", ["pending", "done", "failed"]);

/**
 * Writes from the app to Notion (app-owned fields only), processed by the worker with rate
 * limiting and retries. At most one pending write per (page, kind): newer values replace older.
 */
export const notionOutbox = pgTable(
  "notion_outbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    notionPageId: text("notion_page_id").notNull(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    reason: text("reason"),
    status: outboxStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
    lastError: text("last_error"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    doneAt: ts("done_at"),
  },
  (t) => [
    uniqueIndex("notion_outbox_one_pending_idx").on(t.notionPageId, t.kind).where(sql`status = 'pending'`),
    index("notion_outbox_due_idx").on(t.status, t.nextAttemptAt),
  ],
);

// ================================================================ M3: email templates (editor trial)

export const templateSource = pgEnum("template_source", ["upload", "paste", "fixture"]);
export const templateEditor = pgEnum("template_editor", ["import", "structured", "grapesjs"]);

export const templates = pgTable("templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  sourceKind: templateSource("source_kind").notNull(),
  sourceFilename: text("source_filename"),
  /** SHA-256 of the original uploaded bytes (identifies the exact input file). */
  sourceSha256: text("source_sha256"),
  extractSelector: text("extract_selector"),
  createdBy: text("created_by").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Immutable versions (DB trigger blocks UPDATE/DELETE). Saving always creates a new version. */
export const templateVersions = pgTable(
  "template_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => templates.id),
    versionNo: integer("version_no").notNull(),
    baseVersionId: uuid("base_version_id"),
    editor: templateEditor("editor").notNull(),
    /** Canonical sanitized HTML (no editor annotations). */
    html: text("html").notNull(),
    plainText: text("plain_text").notNull(),
    ops: jsonb("ops"),
    sanitizeReport: jsonb("sanitize_report"),
    note: text("note"),
    createdBy: text("created_by").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("template_versions_no_idx").on(t.templateId, t.versionNo)],
);
