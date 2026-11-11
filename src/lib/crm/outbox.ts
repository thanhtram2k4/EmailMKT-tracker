/**
 * Notion outbox: app → Notion writes of APP-OWNED fields only (subscription status now; last
 * emailed / last engagement from M5/M7). Processed by the worker, rate limited by the shared
 * Notion client, retried with backoff, and visible on the Sync screen when it fails.
 *
 * Coalescing: one pending row per (page, kind); a newer value replaces the older payload.
 * Crash safety: claiming a row pushes next_attempt_at forward (a lease), so a crashed worker's
 * claims are retried later rather than lost; the write is idempotent (absolute value).
 */
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { getLogger } from "../logger";
import { NotionApiError } from "../notion/client";
import { subscriptionWrite } from "./mapping";
import { clientForConnection, type NotionEnv } from "./notion-env";

type Exec = Pick<Db, "execute">;

export async function enqueueSubscriptionWrite(db: Exec, i: { notionPageId: string; label: string; reason: string }) {
  await db.execute(sql`
    insert into notion_outbox (notion_page_id, kind, payload, reason)
    values (${i.notionPageId}, 'set_subscription', ${JSON.stringify({ label: i.label })}::jsonb, ${i.reason})
    on conflict (notion_page_id, kind) where status = 'pending'
    do update set payload = excluded.payload, reason = excluded.reason, attempts = 0,
                  next_attempt_at = now(), updated_at = now(), last_error = null`);
}

export type FlushResult = { claimed: number; done: number; retrying: number; failed: number; skipped?: string };

const PERMANENT = new Set([400, 404, 409]);

export async function flushOutbox(
  db: Db,
  env: NotionEnv,
  opts: { now?: () => Date; limit?: number; maxAttempts?: number } = {},
): Promise<FlushResult> {
  const now = opts.now ?? (() => new Date());
  const maxAttempts = opts.maxAttempts ?? 8;
  const log = getLogger().child({ component: "notion-outbox" });
  const c = await clientForConnection(db, env);
  if (!c) return { claimed: 0, done: 0, retrying: 0, failed: 0, skipped: "not_connected" };

  const lease = new Date(now().getTime() + 5 * 60_000);
  const claimed = (
    await db.execute(sql`
      update notion_outbox set attempts = attempts + 1, next_attempt_at = ${lease.toISOString()}::timestamptz, updated_at = now()
      where id in (
        select id from notion_outbox
        where status = 'pending' and next_attempt_at <= ${now().toISOString()}::timestamptz
        order by id for update skip locked limit ${opts.limit ?? 50})
      returning id, notion_page_id, kind, payload, attempts`)
  ).rows as Array<{ id: number; notion_page_id: string; kind: string; payload: { label: string }; attempts: number }>;

  const r: FlushResult = { claimed: claimed.length, done: 0, retrying: 0, failed: 0 };
  for (const row of claimed) {
    // Only finish the row if it still holds the payload we sent: if a newer value was enqueued
    // while this write was in flight, the row was replaced and must be written again.
    const finish = async (status: "done" | "failed" | "pending", error: string | null, nextAt?: Date) => {
      await db.execute(sql`
        update notion_outbox set status = ${status}, last_error = ${error}, updated_at = now(),
          done_at = ${status === "done" ? now().toISOString() : null}::timestamptz,
          next_attempt_at = ${(nextAt ?? now()).toISOString()}::timestamptz
        where id = ${row.id} and payload = ${JSON.stringify(row.payload)}::jsonb and attempts = ${row.attempts}`);
    };
    try {
      if (row.kind !== "set_subscription") {
        await finish("failed", `unknown outbox kind ${row.kind}`);
        r.failed++;
        continue;
      }
      const prop = c.mapping.fields.subscriptionStatus;
      const type = c.mapping.types.subscriptionStatus;
      if (!prop || (type !== "select" && type !== "status")) {
        await finish("failed", "Subscription status is not mapped to a select/status property");
        r.failed++;
        continue;
      }
      await c.client.updatePageProperties(row.notion_page_id, subscriptionWrite(c.mapping.fields, type, row.payload.label));
      await finish("done", null);
      r.done++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const permanent = e instanceof NotionApiError && PERMANENT.has(e.status);
      if (permanent || row.attempts >= maxAttempts) {
        await finish("failed", msg);
        r.failed++;
        log.error({ outbox_id: row.id, err: msg, attempts: row.attempts }, "notion outbox write failed permanently");
      } else {
        const backoff = Math.min(3_600_000, 30_000 * 2 ** (row.attempts - 1));
        await finish("pending", msg, new Date(now().getTime() + backoff));
        r.retrying++;
        log.warn({ outbox_id: row.id, err: msg, attempts: row.attempts, backoff_ms: backoff }, "notion outbox write will retry");
      }
    }
  }
  return r;
}
