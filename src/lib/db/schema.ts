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
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
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
