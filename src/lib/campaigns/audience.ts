/**
 * Campaign audiences. The audience is a rule (all eligible contacts, or contacts with any of some
 * tags), resolved against the CRM at review and again, inside the approval transaction, when the
 * snapshot is frozen. Eligibility (src/lib/crm/eligibility.ts) excludes archived, invalid,
 * unresolved-duplicate, suppressed and (by default) no-consent contacts; the review shows counts.
 */
import { z } from "zod";
import type { Db } from "../db/client";
import { queryContacts, type ContactRow } from "../crm/queries";
import type { IneligibleReason } from "../crm/eligibility";

export const audienceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all_eligible") }),
  z.object({ kind: z.literal("tags"), tags: z.array(z.string().min(1).max(200)).min(1).max(50) }),
]);
export type Audience = z.infer<typeof audienceSchema>;

export function parseAudience(v: unknown): Audience {
  return audienceSchema.parse(v);
}

export function describeAudience(a: Audience): string {
  return a.kind === "all_eligible" ? "All eligible contacts" : `Contacts tagged ${a.tags.map((t) => `“${t}”`).join(" or ")}`;
}

export type ResolvedAudience = {
  /** Active contacts matched by the rule (before eligibility). */
  matched: number;
  included: ContactRow[];
  excludedTotal: number;
  /** A contact can have several reasons; each reason is counted. */
  excludedByReason: Partial<Record<IneligibleReason | "duplicate_address", number>>;
};

export async function resolveAudience(db: Db, a: Audience): Promise<ResolvedAudience> {
  const rows = await queryContacts(db, { state: "active" });
  const matched = a.kind === "all_eligible" ? rows : rows.filter((r) => r.tags.some((t) => a.tags.includes(t)));
  const included: ContactRow[] = [];
  const excludedByReason: ResolvedAudience["excludedByReason"] = {};
  const seen = new Set<string>();
  let excludedTotal = 0;
  for (const r of matched) {
    if (!r.eligible) {
      excludedTotal++;
      for (const reason of r.reasons) excludedByReason[reason] = (excludedByReason[reason] ?? 0) + 1;
      continue;
    }
    // Defence in depth: one message per address per campaign (also a DB unique constraint).
    if (!r.emailNormalized || seen.has(r.emailNormalized)) {
      excludedTotal++;
      excludedByReason.duplicate_address = (excludedByReason.duplicate_address ?? 0) + 1;
      continue;
    }
    seen.add(r.emailNormalized);
    included.push(r);
  }
  return { matched: matched.length, included, excludedTotal, excludedByReason };
}
