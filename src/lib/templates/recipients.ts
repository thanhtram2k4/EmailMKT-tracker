import { and, asc, eq, ilike, or } from "drizzle-orm";
import type { Db } from "../db/client";
import { contacts } from "../db/schema";
import { SAMPLE_RECIPIENTS, fieldsNeedingValues, scanMergeFields, scanSubject, type MergeField, type Recipient } from "./merge";

export type PreviewRecipient = { id: string; label: string; data: Recipient };

const PREVIEW_UNSUBSCRIBE = "https://app.example/u/preview";

/**
 * Built-in synthetic samples plus up to 25 synced CRM contacts (preview only; nothing is sent).
 * With `q`, the contacts are those whose name, greeting, email or company contains it.
 */
export async function previewRecipients(db: Db, q?: string): Promise<PreviewRecipient[]> {
  const term = q?.trim().slice(0, 100);
  // Escape LIKE wildcards so the search is a plain "contains".
  const like = term ? `%${term.replace(/[\\%_]/g, (c) => "\\" + c)}%` : null;
  const rows = await db
    .select({ id: contacts.id, fullName: contacts.fullName, greetingName: contacts.greetingName, company: contacts.company, email: contacts.emailNormalized })
    .from(contacts)
    .where(
      and(
        eq(contacts.state, "active"),
        eq(contacts.emailStatus, "valid"),
        like ? or(ilike(contacts.fullName, like), ilike(contacts.greetingName, like), ilike(contacts.emailNormalized, like), ilike(contacts.company, like)) : undefined,
      ),
    )
    .orderBy(asc(contacts.fullName))
    .limit(25);
  return [
    ...SAMPLE_RECIPIENTS,
    ...rows.map((c) => ({
      id: `contact:${c.id}`,
      label: `CRM: ${c.fullName ?? c.email}${c.greetingName ? "" : " (thiếu tên gọi)"}`,
      data: { full_name: c.fullName, greeting_name: c.greetingName, company: c.company, email: c.email, unsubscribe_url: PREVIEW_UNSUBSCRIBE },
    })),
  ];
}

export async function findRecipient(db: Db, id: string): Promise<PreviewRecipient | null> {
  const s = SAMPLE_RECIPIENTS.find((x) => x.id === id);
  if (s) return s;
  const m = /^contact:([0-9a-f-]{36})$/i.exec(id);
  if (!m) return null;
  const c = (await db.select().from(contacts).where(eq(contacts.id, m[1])).limit(1))[0];
  if (!c) return null;
  return {
    id,
    label: c.fullName ?? c.email ?? id,
    data: { full_name: c.fullName, greeting_name: c.greetingName, company: c.company, email: c.emailNormalized, unsubscribe_url: PREVIEW_UNSUBSCRIBE },
  };
}

export type PersonalizationCheck = {
  /** Problems that block every recipient (unknown field, bad filter, syntax, line break, Liquid tag…). */
  blocking: Array<{ where: "subject" | "body"; raw: string; error: string }>;
  /** Fields used without a fallback; each recipient needs a value for them. */
  fieldsNeedingValues: string[];
  checked: number;
  affected: Array<{ id: string; name: string; missing: string[] }>;
};

/**
 * Check a subject + body against every active contact with a valid email (the pool campaigns will
 * draw from; the campaign audience and eligibility rules are applied later, in M5).
 */
export async function personalizationCheck(db: Db, t: { subject: string | null; html: string }): Promise<PersonalizationCheck> {
  const blocking: PersonalizationCheck["blocking"] = [];
  if (!t.subject?.trim()) blocking.push({ where: "subject", raw: "", error: "the email has no subject yet" });
  for (const p of scanSubject(t.subject ?? "")) blocking.push({ where: "subject", ...p });
  for (const u of scanMergeFields(t.html).uses) if (u.problem) blocking.push({ where: "body", raw: u.raw, error: u.problem.replace(/_/g, " ") });
  const need = fieldsNeedingValues(t.subject ?? "", t.html);
  const rows = await db
    .select({ id: contacts.id, fullName: contacts.fullName, greetingName: contacts.greetingName, company: contacts.company, email: contacts.emailNormalized })
    .from(contacts)
    .where(and(eq(contacts.state, "active"), eq(contacts.emailStatus, "valid")))
    .orderBy(asc(contacts.fullName));
  const affected: PersonalizationCheck["affected"] = [];
  for (const c of rows) {
    const data: Recipient = { full_name: c.fullName, greeting_name: c.greetingName, company: c.company, email: c.email };
    const missing = need.filter((f) => !String(data[f as MergeField] ?? "").trim());
    if (missing.length) affected.push({ id: c.id, name: c.fullName ?? c.email ?? c.id, missing });
  }
  return { blocking, fieldsNeedingValues: need, checked: rows.length, affected };
}
