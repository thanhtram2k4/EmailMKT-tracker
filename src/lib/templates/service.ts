import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { convert } from "html-to-text";
import { writeAudit } from "../audit";
import type { Db } from "../db/client";
import { templates, templateVersions } from "../db/schema";
import { applyEdits, type EditOp } from "./editable";
import { extractFragment, sanitizeEmailHtml, type SanitizeReport } from "./sanitize";

export const MAX_TEMPLATE_BYTES = 2 * 1024 * 1024;

export function plainTextOf(html: string): string {
  return convert(html, {
    wordwrap: 78,
    // Never change letter case: upper-casing headings would turn {{ full_name }} into
    // {{ FULL_NAME }} and break merge fields in the plain-text part (found in the M3 trial).
    selectors: [
      ...["h1", "h2", "h3", "h4", "h5", "h6"].map((h) => ({ selector: h, options: { uppercase: false } })),
      { selector: "table", options: { uppercaseHeaderCells: false } },
      { selector: "img", format: "skip" },
      { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
      { selector: "style", format: "skip" },
      { selector: "head", format: "skip" },
    ],
  }).trim();
}

export type ImportInput = {
  name: string;
  html: string;
  sourceKind: "upload" | "paste" | "fixture";
  sourceFilename?: string | null;
  extractSelector?: string | null;
  actor: string;
  correlationId?: string;
};

export async function importTemplate(db: Db, i: ImportInput) {
  if (!i.html.trim()) throw new Error("The HTML is empty.");
  if (Buffer.byteLength(i.html) > MAX_TEMPLATE_BYTES) throw new Error("The HTML is larger than 2 MB.");
  const sha256 = createHash("sha256").update(i.html, "utf8").digest("hex");
  let source = i.html;
  let extracted: SanitizeReport["extracted"];
  if (i.extractSelector?.trim()) {
    const x = extractFragment(source, i.extractSelector.trim());
    extracted = { selector: i.extractSelector.trim(), found: x.found };
    if (!x.found) throw new Error(`No element matches "${i.extractSelector}".`);
    source = x.html;
  }
  const { html, report } = sanitizeEmailHtml(source);
  report.extracted = extracted;
  return db.transaction(async (tx) => {
    const [t] = await tx
      .insert(templates)
      .values({ name: i.name.trim() || "Untitled template", sourceKind: i.sourceKind, sourceFilename: i.sourceFilename ?? null, sourceSha256: sha256, extractSelector: i.extractSelector?.trim() || null, createdBy: i.actor })
      .returning();
    const [v] = await tx
      .insert(templateVersions)
      .values({ templateId: t.id, versionNo: 1, editor: "import", html, plainText: plainTextOf(html), sanitizeReport: report, createdBy: i.actor, note: "Imported" })
      .returning();
    await writeAudit(tx as unknown as Db, {
      actor: i.actor,
      action: "template.imported",
      entityType: "template",
      entityId: t.id,
      after: { name: t.name, sourceKind: i.sourceKind, filename: i.sourceFilename, sha256, extract: i.extractSelector ?? null, removed: report.removedElements },
      correlationId: i.correlationId,
    });
    return { template: t, version: v, report };
  });
}

async function nextVersionNo(db: Pick<Db, "execute">, templateId: string) {
  const r = await db.execute(sql`select coalesce(max(version_no), 0) + 1 as n from template_versions where template_id = ${templateId}`);
  return Number((r.rows[0] as { n: number }).n);
}

export async function getVersion(db: Db, templateId: string, versionId?: string) {
  const where = versionId ? and(eq(templateVersions.templateId, templateId), eq(templateVersions.id, versionId)) : eq(templateVersions.templateId, templateId);
  return (await db.select().from(templateVersions).where(where).orderBy(desc(templateVersions.versionNo)).limit(1))[0] ?? null;
}

/** Apply structure-preserving edits to a base version and store the result as a new version. */
export async function saveStructuredEdits(db: Db, i: { templateId: string; baseVersionId: string; ops: EditOp[]; note?: string; actor: string; correlationId?: string }) {
  const base = await getVersion(db, i.templateId, i.baseVersionId);
  if (!base) throw new Error("Base version not found");
  const edited = applyEdits(base.html, i.ops);
  // Re-sanitize the full document after editing (defence in depth).
  const { html, report } = sanitizeEmailHtml(edited.html);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"template:" + i.templateId}))`);
    const versionNo = await nextVersionNo(tx, i.templateId);
    const [v] = await tx
      .insert(templateVersions)
      .values({ templateId: i.templateId, versionNo, baseVersionId: base.id, editor: "structured", html, plainText: plainTextOf(html), ops: i.ops, sanitizeReport: report, note: i.note ?? null, createdBy: i.actor })
      .returning();
    await tx.update(templates).set({ updatedAt: new Date() }).where(eq(templates.id, i.templateId));
    await writeAudit(tx as unknown as Db, { actor: i.actor, action: "template.version_saved", entityType: "template", entityId: i.templateId, after: { versionNo, editor: "structured", ops: i.ops.map((o) => `${o.kind}:${o.id}`) }, correlationId: i.correlationId });
    return v;
  });
}

/** Store HTML exported by the GrapesJS trial editor (sanitized like any import). */
export async function saveGrapesJsVersion(db: Db, i: { templateId: string; baseVersionId: string; html: string; actor: string; correlationId?: string }) {
  if (Buffer.byteLength(i.html) > MAX_TEMPLATE_BYTES) throw new Error("The HTML is larger than 2 MB.");
  const { html, report } = sanitizeEmailHtml(i.html);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"template:" + i.templateId}))`);
    const versionNo = await nextVersionNo(tx, i.templateId);
    const [v] = await tx
      .insert(templateVersions)
      .values({ templateId: i.templateId, versionNo, baseVersionId: i.baseVersionId, editor: "grapesjs", html, plainText: plainTextOf(html), sanitizeReport: report, note: "Saved from GrapesJS trial editor", createdBy: i.actor })
      .returning();
    await writeAudit(tx as unknown as Db, { actor: i.actor, action: "template.version_saved", entityType: "template", entityId: i.templateId, after: { versionNo, editor: "grapesjs" }, correlationId: i.correlationId });
    return v;
  });
}

export async function listTemplates(db: Db) {
  const r = await db.execute(sql`
    select t.*, (select max(version_no) from template_versions v where v.template_id = t.id) as latest_version
    from templates t order by t.updated_at desc`);
  return r.rows as Array<{ id: string; name: string; source_kind: string; source_filename: string | null; source_sha256: string | null; extract_selector: string | null; updated_at: string; latest_version: number }>;
}

export async function getTemplate(db: Db, id: string) {
  const t = (await db.select().from(templates).where(eq(templates.id, id)).limit(1))[0];
  if (!t) return null;
  const versions = await db
    .select({ id: templateVersions.id, versionNo: templateVersions.versionNo, editor: templateVersions.editor, note: templateVersions.note, createdBy: templateVersions.createdBy, createdAt: templateVersions.createdAt })
    .from(templateVersions)
    .where(eq(templateVersions.templateId, id))
    .orderBy(desc(templateVersions.versionNo));
  return { template: t, versions };
}
