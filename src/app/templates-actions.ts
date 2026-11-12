"use server";
/**
 * Server Functions for the M3 template editor trial. Every function re-checks the signed-in
 * staff member (Server Functions are reachable by direct POST). Nothing here sends email.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireStaff } from "../lib/auth/session";
import { getDb } from "../lib/db/client";
import { EditError, type EditOp } from "../lib/templates/editable";
import { FIXTURES } from "../lib/templates/fixtures";
import { importTemplate, saveGrapesJsVersion, saveStructuredEdits } from "../lib/templates/service";

const actorOf = (s: { userId: string }) => `user:${s.userId}`;
const rid = async () => (await headers()).get("x-request-id") ?? undefined;

export async function importTemplateAction(form: FormData) {
  const s = await requireStaff();
  const file = form.get("file");
  const pasted = String(form.get("html") ?? "");
  let html = pasted;
  let filename: string | null = null;
  let kind: "upload" | "paste" = "paste";
  if (file instanceof File && file.size > 0) {
    if (file.size > 2 * 1024 * 1024) redirect(`/templates?error=${encodeURIComponent("File is larger than 2 MB.")}`);
    html = Buffer.from(await file.arrayBuffer()).toString("utf8");
    filename = file.name;
    kind = "upload";
  }
  let id: string;
  try {
    const r = await importTemplate(getDb(), {
      name: String(form.get("name") ?? "") || filename || "Pasted template",
      html,
      sourceKind: kind,
      sourceFilename: filename,
      extractSelector: String(form.get("extract") ?? "") || null,
      actor: actorOf(s),
      correlationId: await rid(),
    });
    id = r.template.id;
  } catch (e) {
    redirect(`/templates?error=${encodeURIComponent(e instanceof Error ? e.message : String(e))}`);
  }
  revalidatePath("/templates");
  redirect(`/templates/${id}`);
}

export async function importFixtureAction(form: FormData) {
  const s = await requireStaff();
  const key = String(form.get("fixture")) as keyof typeof FIXTURES;
  const fx = FIXTURES[key];
  if (!fx) redirect("/templates?error=unknown%20fixture");
  const html = await fs.readFile(path.join(process.cwd(), "fixtures", "email-templates", fx.file), "utf8");
  const r = await importTemplate(getDb(), { name: fx.name, html, sourceKind: "fixture", sourceFilename: fx.file, actor: actorOf(s), correlationId: await rid() });
  revalidatePath("/templates");
  redirect(`/templates/${r.template.id}`);
}

export async function saveEditsAction(templateId: string, baseVersionId: string, ops: EditOp[], note?: string): Promise<{ ok: true; versionId: string; versionNo: number } | { ok: false; error: string }> {
  const s = await requireStaff();
  if (!Array.isArray(ops) || ops.length === 0) return { ok: false, error: "Nothing to save." };
  try {
    const v = await saveStructuredEdits(getDb(), { templateId, baseVersionId, ops, note, actor: actorOf(s), correlationId: await rid() });
    revalidatePath(`/templates/${templateId}`);
    return { ok: true, versionId: v.id, versionNo: v.versionNo };
  } catch (e) {
    if (e instanceof EditError || e instanceof Error) return { ok: false, error: e.message };
    throw e;
  }
}

export async function saveGrapesAction(templateId: string, baseVersionId: string, html: string): Promise<{ ok: true; versionId: string; versionNo: number } | { ok: false; error: string }> {
  const s = await requireStaff();
  try {
    const v = await saveGrapesJsVersion(getDb(), { templateId, baseVersionId, html, actor: actorOf(s), correlationId: await rid() });
    revalidatePath(`/templates/${templateId}`);
    return { ok: true, versionId: v.id, versionNo: v.versionNo };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
