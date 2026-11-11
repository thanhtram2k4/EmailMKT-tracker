/**
 * Notion → app contact synchronization (DESIGN §3.2–§3.3, PLAN M2).
 *
 * Guarantees:
 *  - Identity is the Notion page id: repeated syncs never create duplicate contacts.
 *  - Only Notion-owned fields are imported. App-owned state (suppressions, consent) is never
 *    weakened by a sync: Notion "Subscribed"/blank never removes a suppression and nothing an
 *    import reads can grant consent. Notion "Unsubscribed"/"Bounced"/"Complained" ADDS a suppression.
 *  - One sync at a time (Postgres advisory lock); a crashed run is marked interrupted.
 *  - Partial failures are isolated per page. The incremental cursor only advances when the whole
 *    listing completed and every page was processed; full-sync archiving of pages missing from
 *    Notion only happens after a complete listing.
 *  - Incremental syncs re-read a 5-minute overlap before the cursor (Notion timestamps may be
 *    minute-rounded); upserts are idempotent so re-reading is safe.
 *  - The 10,000-result query cap (request_status "incomplete") is handled by continuing in
 *    time-ordered chunks; if no progress is possible the listing is treated as incomplete.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { writeAudit } from "../audit";
import { systemClock, type Clock } from "../clock";
import type { Db } from "../db/client";
import { contacts, notionConnection, suppressions, syncIssues, syncRuns, syncState } from "../db/schema";
import { getLogger } from "../logger";
import { NotionApiError, type NotionClient } from "../notion/client";
import type { Page } from "../notion/types";
import { appendConsent, hasAnyConsentRecord } from "./consent";
import { normalizeContactFields, singleContactIssues } from "./contact-validation";
import { isSuppressingNotionValue, labelForSuppression, parsePage, validateMapping, type FieldMapping } from "./mapping";
import { clientForConnection, type NotionEnv } from "./notion-env";
import { enqueueSubscriptionWrite } from "./outbox";

export const SYNC_LOCK_KEY = 7419001;
export const INCREMENTAL_OVERLAP_MS = 5 * 60_000;
const STICKY_ISSUES = ["email_changed_from_suppressed"];

export type SyncMode = "full" | "incremental";
export type SyncTrigger = "manual" | "schedule" | "nightly" | "test";

export type SyncCounts = {
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  archived: number;
  reactivated: number;
  archivedMissing: number;
  invalidEmail: number;
  missingEmail: number;
  duplicateContacts: number;
  suppressionsAdded: number;
  outboxQueued: number;
  dataIssues: number;
  pageErrors: number;
  queryPages: number;
  queryChunks: number;
};

export type SyncResult = {
  runId: string | null;
  status: "succeeded" | "partial" | "failed" | "skipped";
  counts: SyncCounts;
  errorCode?: string;
  errorMessage?: string;
  cursorBefore: Date | null;
  cursorAfter: Date | null;
};

const emptyCounts = (): SyncCounts => ({
  fetched: 0, created: 0, updated: 0, unchanged: 0, archived: 0, reactivated: 0, archivedMissing: 0,
  invalidEmail: 0, missingEmail: 0, duplicateContacts: 0, suppressionsAdded: 0, outboxQueued: 0,
  dataIssues: 0, pageErrors: 0, queryPages: 0, queryChunks: 0,
});

export type SyncOptions = {
  mode: SyncMode;
  trigger: SyncTrigger;
  actor: string;
  correlationId?: string;
  clock?: Clock;
  logger?: Logger;
  /** Test hook: called before each page is written (to simulate processing failures). */
  beforePageWrite?: (page: Page) => void | Promise<void>;
};

/** Entry point used by the worker job and tests. */
export async function syncContacts(db: Db, env: NotionEnv, opts: SyncOptions): Promise<SyncResult> {
  const c = await clientForConnection(db, env);
  if (!c || !c.conn.dataSourceId) {
    return { runId: null, status: "skipped", counts: emptyCounts(), errorCode: "not_connected", errorMessage: "Notion is not connected", cursorBefore: null, cursorAfter: null };
  }
  return runSync(db, c.client, c.conn.dataSourceId, c.mapping.fields, opts);
}

export async function runSync(db: Db, client: NotionClient, dataSourceId: string, mapping: FieldMapping, opts: SyncOptions): Promise<SyncResult> {
  const clock = opts.clock ?? systemClock;
  const log = (opts.logger ?? getLogger()).child({ component: "crm-sync", mode: opts.mode, trigger: opts.trigger, request_id: opts.correlationId });
  const counts = emptyCounts();

  // ---- single-flight lock on a dedicated connection
  const lockClient = await db.$client.connect();
  let locked = false;
  try {
    locked = (await lockClient.query("select pg_try_advisory_lock($1) as ok", [SYNC_LOCK_KEY])).rows[0].ok;
    if (!locked) {
      const [run] = await db
        .insert(syncRuns)
        .values({ mode: opts.mode, trigger: opts.trigger, status: "skipped", finishedAt: clock.now(), requestedBy: opts.actor, correlationId: opts.correlationId, errorCode: "already_running", errorMessage: "Another sync is in progress", counts })
        .returning();
      log.info("sync skipped: another sync holds the lock");
      return { runId: run.id, status: "skipped", counts, errorCode: "already_running", cursorBefore: null, cursorAfter: null };
    }

    // A previous run that never finished (worker crash) — we hold the lock, so it is not running.
    await db
      .update(syncRuns)
      .set({ status: "failed", finishedAt: clock.now(), errorCode: "interrupted", errorMessage: "Run did not finish (worker stopped); superseded by a later run" })
      .where(eq(syncRuns.status, "running"));

    const state = (await db.select().from(syncState).where(eq(syncState.id, "notion")).limit(1))[0];
    const cursorBefore = state?.incrementalCursor ?? null;
    const [run] = await db
      .insert(syncRuns)
      .values({ mode: opts.mode, trigger: opts.trigger, status: "running", startedAt: clock.now(), cursorBefore, requestedBy: opts.actor, correlationId: opts.correlationId })
      .returning();

    const issue = async (sev: "data" | "error", code: string, message: string, pageId?: string, contactId?: string) => {
      await db.insert(syncIssues).values({ runId: run.id, severity: sev, code, message, notionPageId: pageId, contactId });
      if (sev === "data") counts.dataIssues++;
      else counts.pageErrors++;
    };

    const finish = async (status: SyncResult["status"], cursorAfter: Date | null, errorCode?: string, errorMessage?: string): Promise<SyncResult> => {
      await db.update(syncRuns).set({ status, finishedAt: clock.now(), cursorAfter, counts, errorCode, errorMessage }).where(eq(syncRuns.id, run.id));
      await writeAudit(db, {
        actor: opts.actor,
        action: "crm.sync_finished",
        entityType: "sync_run",
        entityId: run.id,
        after: { status, mode: opts.mode, trigger: opts.trigger, counts, errorCode },
        correlationId: opts.correlationId,
      });
      log.info({ run_id: run.id, status, counts, error_code: errorCode }, "sync finished");
      return { runId: run.id, status, counts, errorCode, errorMessage, cursorBefore, cursorAfter };
    };

    // ---- schema check: never import with a broken mapping
    try {
      const ds = await client.retrieveDataSource(dataSourceId);
      const v = validateMapping(mapping, ds);
      if (!v.ok) {
        await db.update(notionConnection).set({ lastError: `Mapping no longer matches Notion: ${v.errors.join("; ")}`, updatedAt: clock.now() }).where(eq(notionConnection.id, "default"));
        return await finish("failed", cursorBefore, "schema_mismatch", v.errors.join("; "));
      }
    } catch (e) {
      return await finish("failed", cursorBefore, e instanceof NotionApiError ? e.code : "schema_check_failed", e instanceof Error ? e.message : String(e));
    }

    // ---- listing + processing
    const seen = new Set<string>();
    let maxEdited: number | null = null;
    let listingComplete = false;
    let listingError: { code: string; message: string } | null = null;
    const baseFilterFrom = opts.mode === "incremental" && cursorBefore ? new Date(cursorBefore.getTime() - INCREMENTAL_OVERLAP_MS) : null;

    try {
      let chunkFrom: Date | null = baseFilterFrom;
      for (;;) {
        counts.queryChunks++;
        let cursor: string | undefined;
        let incomplete = false;
        let lastEditedInChunk: number | null = null;
        for (;;) {
          const res = await client.queryDataSource(dataSourceId, {
            ...(chunkFrom ? { filter: { timestamp: "last_edited_time", last_edited_time: { on_or_after: chunkFrom.toISOString() } } } : {}),
            sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
            page_size: 100,
            ...(cursor ? { start_cursor: cursor } : {}),
          });
          counts.queryPages++;
          for (const page of res.results) {
            const edited = Date.parse(page.last_edited_time);
            lastEditedInChunk = Math.max(lastEditedInChunk ?? edited, edited);
            maxEdited = Math.max(maxEdited ?? edited, edited);
            if (seen.has(page.id)) continue; // overlap between chunks
            seen.add(page.id);
            counts.fetched++;
            try {
              await opts.beforePageWrite?.(page);
              await processPage(db, page, mapping, run.id, clock, counts, issue, opts);
            } catch (e) {
              await issue("error", "page_processing_failed", e instanceof Error ? e.message : String(e), page.id);
              log.error({ page_id: page.id, err: e instanceof Error ? e.message : String(e) }, "page processing failed");
            }
          }
          if (res.request_status?.type === "incomplete") {
            incomplete = true;
            break;
          }
          if (!res.has_more || !res.next_cursor) break;
          cursor = res.next_cursor;
        }
        if (!incomplete) {
          listingComplete = true;
          break;
        }
        // Hit the per-query result cap: continue from the newest timestamp seen in this chunk.
        const nextFrom = lastEditedInChunk === null ? null : new Date(lastEditedInChunk);
        if (!nextFrom || (chunkFrom && nextFrom.getTime() <= chunkFrom.getTime())) {
          listingError = { code: "query_cap_no_progress", message: "Notion query hit the 10,000-result cap without timestamp progress; listing incomplete" };
          break;
        }
        chunkFrom = nextFrom;
      }
    } catch (e) {
      listingError = {
        code: e instanceof NotionApiError ? e.code : "listing_failed",
        message: e instanceof Error ? e.message : String(e),
      };
      log.error({ err: listingError.message }, "listing failed");
    }

    // ---- full sync: archive contacts whose pages are gone (only after a COMPLETE listing)
    if (opts.mode === "full" && listingComplete && !listingError) {
      const active = await db.select({ id: contacts.id, pageId: contacts.notionPageId }).from(contacts).where(eq(contacts.state, "active"));
      const missing = active.filter((a) => !seen.has(a.pageId)).map((a) => a.id);
      for (let i = 0; i < missing.length; i += 500) {
        const ids = missing.slice(i, i + 500);
        await db
          .update(contacts)
          .set({ state: "archived", archivedAt: clock.now(), archivedReason: "missing_from_source", updatedAt: clock.now(), lastSyncRunId: run.id })
          .where(and(inArray(contacts.id, ids), eq(contacts.state, "active")));
      }
      counts.archivedMissing = missing.length;
    }

    counts.duplicateContacts = await recomputeDuplicates(db);

    // ---- cursor + state
    const clean = listingComplete && !listingError && counts.pageErrors === 0;
    let cursorAfter = cursorBefore;
    if (clean && maxEdited !== null) cursorAfter = new Date(Math.max(maxEdited, cursorBefore?.getTime() ?? 0));
    if (clean) {
      const now = clock.now();
      const set = {
        incrementalCursor: cursorAfter,
        lastSuccessAt: now,
        updatedAt: now,
        ...(opts.mode === "full" ? { lastFullSyncAt: now } : {}),
      };
      await db.insert(syncState).values({ id: "notion", ...set }).onConflictDoUpdate({ target: syncState.id, set });
    }

    if (listingError) {
      return await finish(counts.fetched > 0 ? "partial" : "failed", cursorBefore, listingError.code, listingError.message);
    }
    if (counts.pageErrors > 0) {
      return await finish("partial", cursorBefore, "page_errors", `${counts.pageErrors} page(s) could not be processed; they will be retried on the next sync`);
    }
    return await finish("succeeded", cursorAfter);
  } finally {
    if (locked) await lockClient.query("select pg_advisory_unlock($1)", [SYNC_LOCK_KEY]).catch(() => {});
    lockClient.release();
  }
}

async function processPage(
  db: Db,
  page: Page,
  mapping: FieldMapping,
  runId: string,
  clock: Clock,
  counts: SyncCounts,
  issue: (sev: "data" | "error", code: string, message: string, pageId?: string, contactId?: string) => Promise<void>,
  opts: SyncOptions,
) {
  const parsed = parsePage(page, mapping);
  for (const p of parsed.problems) await issue("data", p.code, p.message, page.id);
  const fields = normalizeContactFields(parsed.fields);
  const { emailCheck, issues } = singleContactIssues(fields);
  if (emailCheck.status === "invalid") counts.invalidEmail++;
  if (emailCheck.status === "missing") counts.missingEmail++;
  const emailNormalized = emailCheck.normalized;
  const trashed = page.in_trash === true || page.is_archived === true;
  const now = clock.now();
  const editedAt = new Date(page.last_edited_time);

  await db.transaction(async (tx) => {
    const existing = (await tx.select().from(contacts).where(eq(contacts.notionPageId, page.id)).for("update").limit(1))[0];

    // Email changed away from a suppressed address → keep the suppression on the old address and flag it.
    const sticky = (existing?.issues ?? []).filter((x) => STICKY_ISSUES.includes(x));
    if (existing?.emailNormalized && existing.emailNormalized !== emailNormalized) {
      const oldSuppressed = (await tx.select().from(suppressions).where(eq(suppressions.emailNormalized, existing.emailNormalized)).limit(1))[0];
      if (oldSuppressed && !sticky.includes("email_changed_from_suppressed")) {
        sticky.push("email_changed_from_suppressed");
        await writeAudit(tx as unknown as Db, {
          actor: opts.actor,
          action: "crm.email_changed_from_suppressed",
          entityType: "contact",
          entityId: existing.id,
          before: { email: existing.emailNormalized },
          after: { email: emailNormalized },
          correlationId: opts.correlationId,
        });
      }
    }
    const allIssues = Array.from(new Set([...issues, ...sticky]));

    const row = {
      notionPageId: page.id,
      notionUrl: page.url ?? null,
      fullName: fields.fullName,
      greetingName: fields.greetingName,
      email: fields.email,
      emailNormalized,
      emailStatus: emailCheck.status,
      emailInvalidReason: emailCheck.status === "valid" ? null : emailCheck.reason,
      company: fields.company,
      tags: fields.tags,
      issues: allIssues,
      notionSubscriptionValue: parsed.subscriptionValue,
      notionConsentEvidence: parsed.consentEvidence,
      notionLastEditedAt: editedAt,
      lastSyncedAt: now,
      lastSyncRunId: runId,
    };

    let contactId: string;
    if (!existing) {
      const [ins] = await tx
        .insert(contacts)
        .values({
          ...row,
          state: trashed ? "archived" : "active",
          archivedAt: trashed ? now : null,
          archivedReason: trashed ? "notion_trashed" : null,
          firstSyncedAt: now,
        })
        .returning({ id: contacts.id });
      contactId = ins.id;
      counts.created++;
      if (trashed) counts.archived++;
    } else {
      contactId = existing.id;
      const changed =
        existing.fullName !== row.fullName ||
        existing.greetingName !== row.greetingName ||
        existing.email !== row.email ||
        existing.company !== row.company ||
        JSON.stringify(existing.tags) !== JSON.stringify(row.tags) ||
        JSON.stringify([...existing.issues].sort()) !== JSON.stringify([...row.issues].sort()) ||
        existing.notionSubscriptionValue !== row.notionSubscriptionValue ||
        existing.notionConsentEvidence !== row.notionConsentEvidence ||
        existing.notionUrl !== row.notionUrl;
      const stateChange = trashed ? existing.state === "active" : existing.state === "archived";
      await tx
        .update(contacts)
        .set({
          ...row,
          ...(stateChange
            ? trashed
              ? { state: "archived" as const, archivedAt: now, archivedReason: "notion_trashed" }
              : { state: "active" as const, archivedAt: null, archivedReason: null }
            : {}),
          updatedAt: changed || stateChange ? now : existing.updatedAt,
        })
        .where(eq(contacts.id, existing.id));
      if (stateChange) {
        if (trashed) counts.archived++;
        else counts.reactivated++;
      }
      if (changed) counts.updated++;
      else if (!stateChange) counts.unchanged++;
    }

    if (!emailNormalized || emailCheck.status !== "valid") return;

    // First time we see this address: record consent as UNKNOWN (never granted by import),
    // keeping any evidence reference found in Notion for staff to review.
    if (!(await hasAnyConsentRecord(tx as unknown as Db, emailNormalized, "marketing_email"))) {
      await appendConsent(tx as unknown as Db, {
        emailNormalized,
        contactId,
        purpose: "marketing_email",
        status: "unknown",
        source: "notion_import",
        recordedBy: opts.actor,
        evidenceRef: parsed.consentEvidence,
        evidenceNote: parsed.consentEvidence ? "Evidence reference found in Notion; not verified — consent not granted by import" : null,
        correlationId: opts.correlationId,
      });
    }

    const suppression = (await tx.select().from(suppressions).where(eq(suppressions.emailNormalized, emailNormalized)).limit(1))[0];
    if (isSuppressingNotionValue(parsed.subscriptionValue)) {
      if (!suppression) {
        await tx.insert(suppressions).values({
          emailNormalized,
          reason: "notion_unsubscribed",
          source: "notion_sync",
          notionValue: parsed.subscriptionValue,
          contactId,
          createdBy: opts.actor,
          note: `Notion "${mapping.subscriptionStatus}" was set to "${parsed.subscriptionValue}"`,
        });
        await appendConsent(tx as unknown as Db, {
          emailNormalized,
          contactId,
          purpose: "marketing_email",
          status: "withdrawn",
          source: "notion_unsubscribe",
          effectiveAt: editedAt,
          recordedBy: opts.actor,
          evidenceRef: `notion:${page.id}`,
          evidenceNote: `Subscription status set to "${parsed.subscriptionValue}" in Notion`,
          correlationId: opts.correlationId,
        });
        await writeAudit(tx as unknown as Db, {
          actor: opts.actor,
          action: "crm.suppression_added",
          entityType: "suppression",
          entityId: emailNormalized,
          after: { reason: "notion_unsubscribed", notionValue: parsed.subscriptionValue, contactId },
          correlationId: opts.correlationId,
        });
        counts.suppressionsAdded++;
      }
    } else if (suppression && mapping.subscriptionStatus) {
      // Notion shows Subscribed/blank but the app has a suppression: the app wins; mirror it back.
      const label = labelForSuppression(suppression.reason);
      if (parsed.subscriptionValue !== label) {
        await enqueueSubscriptionWrite(tx, { notionPageId: page.id, label, reason: `suppressed (${suppression.reason}); Notion showed "${parsed.subscriptionValue ?? ""}"` });
        counts.outboxQueued++;
        if (parsed.subscriptionValue) {
          await writeAudit(tx as unknown as Db, {
            actor: opts.actor,
            action: "crm.resubscribe_ignored",
            entityType: "suppression",
            entityId: emailNormalized,
            after: { notionValue: parsed.subscriptionValue, keptReason: suppression.reason },
            correlationId: opts.correlationId,
          });
        }
      }
    }
  });
}

/** Mark active, valid contacts sharing an email as duplicates (and clear the flag elsewhere). */
export async function recomputeDuplicates(db: Pick<Db, "execute">): Promise<number> {
  await db.execute(sql`
    with dup as (
      select email_normalized from contacts
      where state = 'active' and email_status = 'valid'
      group by email_normalized having count(*) > 1)
    update contacts c set is_duplicate = (c.state = 'active' and c.email_status = 'valid' and c.email_normalized in (select email_normalized from dup))
    where c.is_duplicate is distinct from (c.state = 'active' and c.email_status = 'valid' and c.email_normalized in (select email_normalized from dup))`);
  const r = await db.execute(sql`select count(*)::int as n from contacts where is_duplicate`);
  return (r.rows[0] as { n: number }).n;
}
