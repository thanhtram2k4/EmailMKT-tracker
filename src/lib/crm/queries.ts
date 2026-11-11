/** Read models for the Contacts, Data issues and Sync screens. */
import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { appSettings, notionOutbox, syncIssues, syncRuns, syncState } from "../db/schema";
import { eligibility, type IneligibleReason } from "./eligibility";

export const REQUIRE_CONSENT_KEY = "crm.require_marketing_consent";

/** Default TRUE (safe) until counsel decides — see docs/COMPLIANCE.md. */
export async function getRequireConsent(db: Db): Promise<boolean> {
  const r = (await db.select().from(appSettings).where(eq(appSettings.key, REQUIRE_CONSENT_KEY)).limit(1))[0];
  return r ? r.value !== false : true;
}

export type ContactRow = {
  id: string;
  notionPageId: string;
  notionUrl: string | null;
  fullName: string | null;
  greetingName: string | null;
  email: string | null;
  emailNormalized: string | null;
  emailStatus: "valid" | "invalid" | "missing";
  emailInvalidReason: string | null;
  company: string | null;
  tags: string[];
  state: "active" | "archived";
  archivedReason: string | null;
  issues: string[];
  isDuplicate: boolean;
  suppressionReason: string | null;
  marketingConsent: "unknown" | "granted" | "refused" | "withdrawn";
  duplicateResolution: "none" | "primary" | "secondary";
  lastSyncedAt: Date;
  notionLastEditedAt: Date | null;
  notionSubscriptionValue: string | null;
  notionConsentEvidence: string | null;
  eligible: boolean;
  reasons: IneligibleReason[];
};

export type ContactFilters = {
  q?: string;
  tag?: string;
  state?: "active" | "archived" | "all";
  issue?: "any" | "duplicate" | "email_invalid" | "email_missing" | "greeting_name_missing" | "full_name_missing" | "email_changed_from_suppressed";
  suppressed?: "yes" | "no";
  consent?: "unknown" | "granted" | "refused" | "withdrawn";
  eligible?: "yes" | "no";
  id?: string;
};

type Raw = Record<string, unknown>;

function toRow(r: Raw, requireConsent: boolean): ContactRow {
  const isDuplicate = r.is_duplicate as boolean;
  const primary = r.valid_primary_id as string | null;
  const duplicateResolution: ContactRow["duplicateResolution"] = !isDuplicate || !primary ? "none" : primary === r.id ? "primary" : "secondary";
  const base = {
    id: r.id as string,
    notionPageId: r.notion_page_id as string,
    notionUrl: (r.notion_url as string) ?? null,
    fullName: (r.full_name as string) ?? null,
    greetingName: (r.greeting_name as string) ?? null,
    email: (r.email as string) ?? null,
    emailNormalized: (r.email_normalized as string) ?? null,
    emailStatus: r.email_status as ContactRow["emailStatus"],
    emailInvalidReason: (r.email_invalid_reason as string) ?? null,
    company: (r.company as string) ?? null,
    tags: (r.tags as string[]) ?? [],
    state: r.state as ContactRow["state"],
    archivedReason: (r.archived_reason as string) ?? null,
    issues: (r.issues as string[]) ?? [],
    isDuplicate,
    suppressionReason: (r.suppression_reason as string) ?? null,
    marketingConsent: r.marketing_consent as ContactRow["marketingConsent"],
    duplicateResolution,
    lastSyncedAt: new Date(r.last_synced_at as string),
    notionLastEditedAt: r.notion_last_edited_at ? new Date(r.notion_last_edited_at as string) : null,
    notionSubscriptionValue: (r.notion_subscription_value as string) ?? null,
    notionConsentEvidence: (r.notion_consent_evidence as string) ?? null,
  };
  const e = eligibility({
    state: base.state,
    emailStatus: base.emailStatus,
    isDuplicate,
    duplicateResolution,
    suppressed: Boolean(base.suppressionReason),
    marketingConsent: base.marketingConsent,
    requireConsent,
  });
  return { ...base, eligible: e.eligible, reasons: e.reasons };
}

export async function queryContacts(db: Db, f: ContactFilters = {}): Promise<ContactRow[]> {
  const where = [sql`true`];
  const state = f.state ?? "active";
  if (state !== "all") where.push(sql`c.state = ${state}`);
  if (f.id) where.push(sql`c.id = ${f.id}::uuid`);
  if (f.q?.trim()) {
    const like = `%${f.q.trim().replace(/[%_]/g, (m) => "\\" + m)}%`;
    where.push(sql`(c.full_name ilike ${like} or c.email ilike ${like} or c.company ilike ${like} or c.greeting_name ilike ${like})`);
  }
  if (f.tag) where.push(sql`${f.tag} = any(c.tags)`);
  if (f.issue === "duplicate") where.push(sql`c.is_duplicate`);
  else if (f.issue === "any") where.push(sql`(c.is_duplicate or cardinality(c.issues) > 0)`);
  else if (f.issue) where.push(sql`${f.issue} = any(c.issues)`);
  if (f.suppressed === "yes") where.push(sql`s.email_normalized is not null`);
  if (f.suppressed === "no") where.push(sql`s.email_normalized is null`);

  const whereSql = sql.join(where, sql` and `);
  const res = await db.execute(sql`
    select c.*, s.reason::text as suppression_reason,
      coalesce((select cr.status::text from consent_records cr
                where cr.email_normalized = c.email_normalized and cr.purpose = 'marketing_email'
                order by cr.id desc limit 1), 'unknown') as marketing_consent,
      p.id as valid_primary_id
    from contacts c
    left join suppressions s on s.email_normalized = c.email_normalized
    left join duplicate_resolutions dr on dr.email_normalized = c.email_normalized
    left join contacts p on p.id = dr.primary_contact_id and p.state = 'active' and p.email_normalized = c.email_normalized
    where ${whereSql}
    order by c.full_name asc nulls last, c.email asc nulls last`);
  const requireConsent = await getRequireConsent(db);
  let rows = (res.rows as Raw[]).map((r) => toRow(r, requireConsent));
  // Vietnamese alphabetical order (Đ after D, Â/Ă with A…), not the database's byte order.
  const collator = new Intl.Collator("vi", { sensitivity: "base" });
  rows.sort((a, b) => (a.fullName === null ? 1 : b.fullName === null ? -1 : collator.compare(a.fullName, b.fullName)) || collator.compare(a.email ?? "", b.email ?? ""));
  if (f.consent) rows = rows.filter((r) => r.marketingConsent === f.consent);
  if (f.eligible === "yes") rows = rows.filter((r) => r.eligible);
  if (f.eligible === "no") rows = rows.filter((r) => !r.eligible);
  return rows;
}

export async function contactStats(db: Db) {
  const r = await db.execute(sql`
    select
      count(*) filter (where state = 'active')::int as active,
      count(*) filter (where state = 'archived')::int as archived,
      count(*) filter (where state = 'active' and is_duplicate)::int as duplicates,
      count(*) filter (where state = 'active' and email_status = 'invalid')::int as invalid,
      count(*) filter (where state = 'active' and email_status = 'missing')::int as missing,
      count(*) filter (where state = 'active' and 'greeting_name_missing' = any(issues))::int as missing_greeting,
      (select count(*)::int from suppressions) as suppressions
    from contacts`);
  return r.rows[0] as { active: number; archived: number; duplicates: number; invalid: number; missing: number; missing_greeting: number; suppressions: number };
}

export async function allTags(db: Db): Promise<string[]> {
  const r = await db.execute(sql`select distinct unnest(tags) as tag from contacts where state = 'active' order by 1`);
  return (r.rows as Array<{ tag: string }>).map((x) => x.tag);
}

export async function duplicateGroups(db: Db) {
  const rows = await queryContacts(db, { issue: "duplicate" });
  const groups = new Map<string, ContactRow[]>();
  for (const r of rows) groups.set(r.emailNormalized!, [...(groups.get(r.emailNormalized!) ?? []), r]);
  return [...groups.entries()].map(([email, members]) => ({ email, members, resolved: members.some((m) => m.duplicateResolution === "primary") }));
}

export async function syncOverview(db: Db) {
  const [runs, state, outbox] = await Promise.all([
    db.select().from(syncRuns).orderBy(desc(syncRuns.startedAt)).limit(20),
    db.select().from(syncState).limit(1),
    db.execute(sql`select status::text, count(*)::int as n from notion_outbox group by status`),
  ]);
  const failedOutbox = await db.select().from(notionOutbox).where(eq(notionOutbox.status, "failed")).orderBy(desc(notionOutbox.updatedAt)).limit(20);
  const latest = runs.find((r) => r.status !== "skipped");
  const latestIssues = latest ? await db.select().from(syncIssues).where(eq(syncIssues.runId, latest.id)).limit(200) : [];
  return {
    runs,
    state: state[0] ?? null,
    outboxCounts: Object.fromEntries((outbox.rows as Array<{ status: string; n: number }>).map((x) => [x.status, x.n])) as Record<string, number>,
    failedOutbox,
    latestIssues,
    latestRun: latest ?? null,
  };
}
