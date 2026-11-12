import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { contacts } from "../db/schema";
import { SAMPLE_RECIPIENTS, type Recipient } from "./merge";

export type PreviewRecipient = { id: string; label: string; data: Recipient };

const PREVIEW_UNSUBSCRIBE = "https://app.example/u/preview";

/** Built-in synthetic samples plus up to 25 synced CRM contacts (preview only; nothing is sent). */
export async function previewRecipients(db: Db): Promise<PreviewRecipient[]> {
  const rows = await db
    .select({ id: contacts.id, fullName: contacts.fullName, greetingName: contacts.greetingName, company: contacts.company, email: contacts.emailNormalized })
    .from(contacts)
    .where(and(eq(contacts.state, "active"), eq(contacts.emailStatus, "valid")))
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
