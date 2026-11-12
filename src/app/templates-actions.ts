"use server";
/**
 * Server Functions for importing and editing the user's own emails. Every function re-checks the
 * signed-in staff member (Server Functions are reachable by direct POST). Nothing here sends email.
 * Internal test tooling (fixtures, GrapesJS comparison) lives in app/internal/editor-lab.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireStaff } from "../lib/auth/session";
import { getDb } from "../lib/db/client";
import { EditError, type EditOp } from "../lib/templates/editable";
import { importTemplate, saveStructuredEdits } from "../lib/templates/service";

const actorOf = (s: { userId: string }) => `user:${s.userId}`;
const rid = async () => (await headers()).get("x-request-id") ?? undefined;

export async function importTemplateAction(form: FormData) {
  const s = await requireStaff();
  const file = form.get("file");
  const pasted = String(form.get("html") ?? "");
  let html = pasted;
  let filename: string | null = null;
  let kind: "upload" | "paste" = "paste";
  if (!pasted.trim() && file instanceof File && file.size > 0) {
    if (file.size > 2 * 1024 * 1024) redirect(`/templates?error=${encodeURIComponent("File is larger than 2 MB.")}`);
    html = Buffer.from(await file.arrayBuffer()).toString("utf8");
    filename = file.name;
    kind = "upload";
  }
  // Browsers submit textarea text with CRLF line breaks; store LF like the original file.
  html = html.replace(/\x0d\x0a?/g, "\x0a");
  if (!html.trim()) redirect(`/templates?error=${encodeURIComponent("Paste your email HTML first (or choose an .html file).")}`);
  let id: string;
  try {
    const r = await importTemplate(getDb(), {
      // Empty name: the service uses the email's <title> (or first heading).
      name: String(form.get("name") ?? "").trim() || (filename ? filename.replace(/\.html?$/i, "") : ""),
      html,
      sourceKind: kind,
      sourceFilename: filename,
      extractSelector: String(form.get("extract") ?? "").trim() || null,
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

export async function saveEditsAction(
  templateId: string,
  baseVersionId: string,
  ops: EditOp[],
  note?: string,
): Promise<{ ok: true; versionId: string; versionNo: number } | { ok: false; error: string }> {
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
