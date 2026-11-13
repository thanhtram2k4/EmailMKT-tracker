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
    /** M4: subject line (merge fields allowed). Null for versions saved before M4. */
    subject: text("subject"),
    /** M4: optional preheader (inbox preview text). */
    preheader: text("preheader"),
    createdBy: text("created_by").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("template_versions_no_idx").on(t.templateId, t.versionNo)],
);

// ================================================================ M4: test sends

/**
 * Status of one test-send attempt (one row per recipient address):
 *  - claimed:   written BEFORE the provider is called (write-ahead); a stale claim becomes unknown;
 *  - accepted:  the provider accepted the message (NOT proof of inbox delivery);
 *  - rejected:  the provider refused it definitively;
 *  - retryable: the provider confirmed it did not accept (e.g. throttling); never retried automatically;
 *  - unknown:   the outcome is uncertain (timeout, crash after the call); never retried automatically;
 *  - refused:   our own checks refused it before any provider call (allowlist, suppression, guard…).
 */
export const testSendStatus = pgEnum("test_send_status", ["claimed", "accepted", "rejected", "retryable", "unknown", "refused"]);

/** Test sends are deliberately separate from campaigns: no campaign id, never part of campaign metrics. */
export const testSends = pgTable(
  "test_sends",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** One per submitted form and recipient; a double submit reuses it, so the provider is called once. */
    idempotencyKey: text("idempotency_key").notNull(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => templates.id),
    templateVersionId: uuid("template_version_id")
      .notNull()
      .references(() => templateVersions.id),
    requestedBy: text("requested_by").notNull(),
    recipientEmail: text("recipient_email").notNull(),
    /** Whose data filled the merge fields (sample id or contact:<uuid>). */
    mergeSource: text("merge_source").notNull(),
    renderedSubject: text("rendered_subject"),
    status: testSendStatus("status").notNull(),
    transport: text("transport"),
    providerMessageId: text("provider_message_id"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    sendMode: text("send_mode").notNull(),
    authorizationRef: text("authorization_ref"),
    requestId: text("request_id"),
    /** Set when a staff member explicitly sends again after an uncertain or failed attempt. */
    resendOf: uuid("resend_of"),
    createdAt: ts("created_at").notNull().defaultNow(),
    claimedAt: ts("claimed_at"),
    completedAt: ts("completed_at"),
  },
  (t) => [
    uniqueIndex("test_sends_idem_idx").on(t.idempotencyKey, t.recipientEmail),
    index("test_sends_template_idx").on(t.templateId, t.createdAt),
    index("test_sends_requested_by_idx").on(t.requestedBy, t.createdAt),
    index("test_sends_status_idx").on(t.status, t.claimedAt),
  ],
);

// ================================================================ M5: campaigns and the send engine
// Design: docs/DESIGN.md §3.4 (status model) and §4.1 (durable sending). M6 adds scheduling states.

/**
 * Campaign status (M5 subset of DESIGN §3.4):
 *  draft → queued → sending → completed | completed_with_issues
 *  sending ⇄ paused (user) · sending → blocked (quota / credentials / account) → sending (resume)
 *  queued|sending|paused|blocked → cancelling → cancelled (partial report) · draft → cancelled
 * M6: draft → scheduled → (due, fenced start) queued; scheduled → scheduled (reschedule, revision++);
 *  scheduled|held_overdue → draft (unschedule to edit) | cancelling; scheduled → held_overdue (start
 *  later than the grace period) → queued (admin "send now") | scheduled (reschedule) | cancelled.
 */
export const campaignStatus = pgEnum("campaign_status", [
  "draft",
  "scheduled",
  "held_overdue",
  "queued",
  "sending",
  "paused",
  "blocked",
  "cancelling",
  "cancelled",
  "completed",
  "completed_with_issues",
  "failed",
]);

export const campaigns = pgTable(
  "campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    status: campaignStatus("status").notNull().default("draft"),
    templateId: uuid("template_id")
      .notNull()
      .references(() => templates.id),
    /** The template version chosen for this campaign (content is copied into the snapshot at approval). */
    templateVersionId: uuid("template_version_id")
      .notNull()
      .references(() => templateVersions.id),
    /** {"kind":"all_eligible"} or {"kind":"tags","tags":[...]} (any of the tags). */
    audience: jsonb("audience").notNull(),
    /** Set once at approval; the snapshot is immutable. */
    snapshotId: uuid("snapshot_id"),
    /** Incremented by every edit; fences stale jobs (M6 scheduling relies on it too). */
    scheduleRevision: integer("schedule_revision").notNull().default(0),
    /** Why the campaign is blocked (quota, credentials, account_paused, …), with a human message. */
    blockCode: text("block_code"),
    blockMessage: text("block_message"),
    approvedBy: text("approved_by"),
    approvedAt: ts("approved_at"),
    processingStartedAt: ts("processing_started_at"),
    finishedAt: ts("finished_at"),
    // ---- M6 scheduling (DESIGN §4.2). Times are stored in UTC; the IANA zone and the local
    // wall-clock time as entered are kept for display and audit.
    scheduledAtUtc: ts("scheduled_at_utc"),
    scheduleTz: text("schedule_tz"),
    /** Local date-time as entered, "YYYY-MM-DD HH:mm". */
    scheduleLocal: text("schedule_local"),
    /** UTC offset (minutes) that applied; chosen by the user for an ambiguous (DST overlap) time. */
    scheduleOffsetMinutes: integer("schedule_offset_minutes"),
    scheduledBy: text("scheduled_by"),
    /** Why a scheduled campaign is held (e.g. started later than the grace period). */
    holdReason: text("hold_reason"),
    /** Measured delay between the scheduled time and the fenced start, in ms. */
    startDelayMs: integer("start_delay_ms"),
    createdBy: text("created_by").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("campaigns_status_idx").on(t.status), index("campaigns_due_idx").on(t.status, t.scheduledAtUtc)],
);

/** Immutable (DB trigger): the exact content approved for sending. */
export const campaignSnapshots = pgTable("campaign_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  campaignId: uuid("campaign_id")
    .notNull()
    .references(() => campaigns.id),
  scheduleRevision: integer("schedule_revision").notNull(),
  templateVersionId: uuid("template_version_id")
    .notNull()
    .references(() => templateVersions.id),
  subjectTemplate: text("subject_template").notNull(),
  html: text("html").notNull(),
  plainText: text("plain_text").notNull(),
  fromAddress: text("from_address").notNull(),
  contentHash: text("content_hash").notNull(),
  /** Audience definition and counts at approval: included, excluded by reason. */
  audience: jsonb("audience").notNull(),
  counts: jsonb("counts").notNull(),
  approvedBy: text("approved_by").notNull(),
  approvedAt: ts("approved_at").notNull(),
});

/** Immutable link table of a snapshot (click redirects in M7 go only to these URLs). */
export const campaignLinks = pgTable(
  "campaign_links",
  {
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => campaignSnapshots.id),
    idx: integer("idx").notNull(),
    url: text("url").notNull(),
    label: text("label"),
  },
  (t) => [uniqueIndex("campaign_links_pk").on(t.snapshotId, t.idx)],
);

/** Immutable: recipients frozen at approval, with their merge values (later CRM edits do not apply). */
export const campaignRecipients = pgTable(
  "campaign_recipients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => campaignSnapshots.id),
    contactId: uuid("contact_id").references(() => contacts.id),
    emailNormalized: text("email_normalized").notNull(),
    mergeValues: jsonb("merge_values").notNull(),
  },
  (t) => [uniqueIndex("campaign_recipients_email_idx").on(t.snapshotId, t.emailNormalized)],
);

/**
 * Per-recipient send state (DESIGN §3.4 "Message send_status"). Forward-only (DB trigger):
 *  pending → claimed → sent | failed_permanent | unknown | pending (provider confirmed NOT accepted)
 *  pending|claimed → skipped (suppressed / consent) | cancelled
 *  unknown → sent (event evidence) | marked_not_sent (staff) | pending (staff "resend", attempt_no+1)
 *  marked_not_sent → sent (event evidence)
 * A stale claim becomes `unknown`, never `pending`; `unknown` is never retried automatically.
 */
export const messageSendStatus = pgEnum("message_send_status", [
  "pending",
  "claimed",
  "sent",
  "failed_permanent",
  "skipped",
  "cancelled",
  "unknown",
  "marked_not_sent",
]);

export const messageDeliveryStatus = pgEnum("message_delivery_status", ["none", "delayed", "delivered", "bounced_soft", "bounced_hard", "complained", "rejected"]);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => campaignSnapshots.id),
    recipientId: uuid("recipient_id")
      .notNull()
      .references(() => campaignRecipients.id),
    emailNormalized: text("email_normalized").notNull(),
    /** 128-bit random, base64url. Used in unsubscribe (and, in M7, tracking) URLs. Never an email. */
    trackingToken: text("tracking_token").notNull().unique(),
    sendStatus: messageSendStatus("send_status").notNull().default("pending"),
    deliveryStatus: messageDeliveryStatus("delivery_status").notNull().default("none"),
    /** suppressed | consent_withdrawn | consent_missing | … */
    skipReason: text("skip_reason"),
    attemptNo: integer("attempt_no").notNull().default(1),
    claimedBy: text("claimed_by"),
    claimedAt: ts("claimed_at"),
    /** Required by the trigger when a claim is released back to pending (known not sent). */
    releaseReason: text("release_reason"),
    nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
    throttleCount: integer("throttle_count").notNull().default(0),
    sendStartedAt: ts("send_started_at"),
    sentAt: ts("sent_at"),
    providerMessageId: text("provider_message_id"),
    errorCode: text("error_code"),
    lastError: text("last_error"),
    /** M7: whether open/click tracking was applied when the message was sent (consent / setting at send time). */
    trackingEnabled: boolean("tracking_enabled"),
    /** Staff decision on an uncertain send (resend_approved / marked_not_sent), audited. */
    resolution: text("resolution"),
    resolvedBy: text("resolved_by"),
    resolvedAt: ts("resolved_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("messages_snapshot_recipient_idx").on(t.snapshotId, t.recipientId),
    index("messages_dispatch_idx").on(t.campaignId, t.sendStatus, t.nextAttemptAt),
    index("messages_claimed_idx").on(t.sendStatus, t.claimedAt),
    index("messages_provider_idx").on(t.providerMessageId),
    index("messages_email_idx").on(t.emailNormalized),
  ],
);

export const messageEventType = pgEnum("message_event_type", [
  "send",
  "delivery",
  "bounce_hard",
  "bounce_soft",
  "complaint",
  "reject",
  "delay",
  "rendering_failure",
  "open",
  "click",
  "unsubscribe",
]);

/** Provider events (SES via SNS) and unsubscribes. Deduplicated on provider_event_id (SNS MessageId). */
export const messageEvents = pgTable(
  "message_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    messageId: uuid("message_id"),
    campaignId: uuid("campaign_id"),
    /** Events for test sends are stored separately from campaign events and never counted. */
    testSendId: uuid("test_send_id"),
    type: messageEventType("type").notNull(),
    providerEventId: text("provider_event_id").unique(),
    providerMessageId: text("provider_message_id"),
    occurredAt: ts("occurred_at"),
    receivedAt: ts("received_at").notNull().defaultNow(),
    /** Minimal, redacted detail (bounce type/subtype, masked diagnostic). No full addresses. */
    detail: jsonb("detail"),
    // ---- M7 tracking (opens / clicks). Raw events are kept; automation flags are additive.
    /** Clicked link: index into the snapshot's link table. */
    linkIdx: integer("link_idx"),
    /** Keyed hash of the client IP (never the IP itself). */
    ipHash: text("ip_hash"),
    userAgent: text("user_agent"),
    /** True when any flag indicates automated activity (scanner, prefetch, burst, HEAD…). */
    suspectedAutomated: boolean("suspected_automated").notNull().default(false),
    /** e.g. fast_click, multi_link_burst, head_request, scanner_ua, proxy_open (label only). */
    flags: text("flags").array().notNull().default(emptyTextArray),
  },
  (t) => [
    index("message_events_message_idx").on(t.messageId),
    index("message_events_campaign_idx").on(t.campaignId, t.type),
    index("message_events_activity_idx").on(t.messageId, t.type, t.occurredAt),
  ],
);

/** Append-only (DB trigger): every campaign status change, who made it and why. */
export const campaignTransitions = pgTable(
  "campaign_transitions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    actor: text("actor").notNull(),
    reason: text("reason"),
    scheduleRevision: integer("schedule_revision").notNull(),
    detail: jsonb("detail"),
    correlationId: text("correlation_id"),
    at: ts("at").notNull().defaultNow(),
  },
  (t) => [index("campaign_transitions_campaign_idx").on(t.campaignId, t.id)],
);

// ================================================================ M6: admin alerts

/**
 * Operational alerts for administrators (DESIGN §4.2 "Visibility"): a campaign held because it
 * started too late, or blocked at execution time. Shown in the app; emailed to active admins only
 * when the sending guard allows it (never in SEND_MODE=disabled). Rows are kept as an audit record.
 */
export const adminAlerts = pgTable(
  "admin_alerts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kind: text("kind").notNull(),
    campaignId: uuid("campaign_id").references(() => campaigns.id),
    message: text("message").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    /** pending | sent | not_sent | failed */
    emailStatus: text("email_status").notNull().default("pending"),
    emailDetail: text("email_detail"),
    emailedAt: ts("emailed_at"),
    acknowledgedBy: text("acknowledged_by"),
    acknowledgedAt: ts("acknowledged_at"),
  },
  (t) => [index("admin_alerts_open_idx").on(t.acknowledgedAt, t.createdAt), index("admin_alerts_email_idx").on(t.emailStatus)],
);
