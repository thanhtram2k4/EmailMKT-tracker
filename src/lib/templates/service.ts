import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { convert } from "html-to-text";
import { writeAudit } from "../audit";
import type { Db } from "../db/client";
import { templates, templateVersions } from "../db/schema";
import { applyEdits, type EditOp, type FormatChange } from "./editable";
import { parseHtml } from "./html-doc";
import { MAX_SUBJECT_LENGTH } from "./merge";
import { describeFormat } from "./text-runs";
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

/** Default name for an imported email: its <title>, else the first heading. */
export function nameFromHtml(html: string): string | null {
  const $ = parseHtml(html);
  const t = ($("title").first().text() || $("h1,h2").first().text()).replace(/\s+/g, " ").trim();
  return t ? t.slice(0, 120) : null;
}

/** Human-readable summary of a save, stored as the version note. */
export function editNote(ops: EditOp[], changes: FormatChange[]): string {
  const parts = ops.map((o) => (o.kind === "text-runs" ? `${o.id}: text (all formatting kept)` : o.kind === "text" ? `${o.id}: text (${o.mode ?? "html"})` : `${o.id}: ${o.kind}`));
  for (const c of changes) {
    if (c.removed.length) parts.push(`${c.id}: formatting removed (accepted): ${c.removed.map(describeFormat).join("; ")}`);
    if (c.added.length) parts.push(`${c.id}: formatting added: ${c.added.map(describeFormat).join("; ")}`);
  }
  return parts.join(" · ").slice(0, 2000);
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
      .values({ name: i.name.trim() || nameFromHtml(source) || "Untitled email", sourceKind: i.sourceKind, sourceFilename: i.sourceFilename ?? null, sourceSha256: sha256, extractSelector: i.extractSelector?.trim() || null, createdBy: i.actor })
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
  const note = i.note ?? editNote(i.ops, edited.formatChanges);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"template:" + i.templateId}))`);
    const versionNo = await nextVersionNo(tx, i.templateId);
    const [v] = await tx
      .insert(templateVersions)
      .values({ templateId: i.templateId, versionNo, baseVersionId: base.id, editor: "structured", html, plainText: plainTextOf(html), ops: i.ops, sanitizeReport: report, note, subject: base.subject, preheader: base.preheader, createdBy: i.actor })
      .returning();
    await tx.update(templates).set({ updatedAt: new Date() }).where(eq(templates.id, i.templateId));
    await writeAudit(tx as unknown as Db, { actor: i.actor, action: "template.version_saved", entityType: "template", entityId: i.templateId, after: { versionNo, editor: "structured", ops: i.ops.map((o) => `${o.kind}:${o.id}`), formatChanges: edited.formatChanges.map((c) => ({ id: c.id, mode: c.mode, removed: c.removed.length, added: c.added.length })) }, correlationId: i.correlationId });
    return v;
  });
}

/**
 * M4: change the subject (and preheader). Versions are immutable, so this stores a new version with
 * the same HTML. Line breaks are refused (header injection); merge-field problems are reported by
 * scanSubject and block test sends, but a draft subject may still be saved and fixed later.
 */
export async function saveSubject(db: Db, i: { templateId: string; baseVersionId: string; subject: string; preheader?: string | null; actor: string; correlationId?: string }) {
  const subject = i.subject.trim();
  const preheader = (i.preheader ?? "").trim() || null;
  if (/[\r\n]/.test(i.subject) || /[\r\n]/.test(i.preheader ?? "")) throw new Error("The subject and preheader must be a single line.");
  if (!subject) throw new Error("Enter a subject.");
  if (subject.length > MAX_SUBJECT_LENGTH) throw new Error(`The subject is longer than ${MAX_SUBJECT_LENGTH} characters.`);
  if (preheader && preheader.length > 250) throw new Error("The preheader is longer than 250 characters.");
  const base = await getVersion(db, i.templateId, i.baseVersionId);
  if (!base) throw new Error("Base version not found");
  if (base.subject === subject && (base.preheader ?? null) === preheader) throw new Error("Nothing changed.");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"template:" + i.templateId}))`);
    const versionNo = await nextVersionNo(tx, i.templateId);
    const [v] = await tx
      .insert(templateVersions)
      .values({ templateId: i.templateId, versionNo, baseVersionId: base.id, editor: base.editor === "grapesjs" ? "grapesjs" : "structured", html: base.html, plainText: base.plainText, ops: [{ kind: "subject" }], sanitizeReport: base.sanitizeReport, note: base.subject ? "Subject changed" : "Subject added", subject, preheader, createdBy: i.actor })
      .returning();
    await tx.update(templates).set({ updatedAt: new Date() }).where(eq(templates.id, i.templateId));
    await writeAudit(tx as unknown as Db, { actor: i.actor, action: "template.subject_saved", entityType: "template", entityId: i.templateId, before: { subject: base.subject, preheader: base.preheader }, after: { versionNo, subject, preheader }, correlationId: i.correlationId });
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
