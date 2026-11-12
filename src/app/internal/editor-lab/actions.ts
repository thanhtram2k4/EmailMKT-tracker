"use server";
/**
 * INTERNAL editor-lab actions (APP_ENV local/test, admins only): import a labelled internal
 * fixture, and save a version from the GrapesJS comparison editor. Not part of the user workflow.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "../../../lib/db/client";
import { requireInternalTools } from "../../../lib/internal-tools";
import { FIXTURES } from "../../../lib/templates/fixtures";
import { importTemplate, saveGrapesJsVersion } from "../../../lib/templates/service";

const actorOf = (s: { userId: string }) => `user:${s.userId}`;
const rid = async () => (await headers()).get("x-request-id") ?? undefined;

export async function importFixtureAction(form: FormData) {
  const s = await requireInternalTools();
  const key = String(form.get("fixture")) as keyof typeof FIXTURES;
  const fx = FIXTURES[key];
  if (!fx) redirect("/internal/editor-lab?error=unknown%20fixture");
  const html = await fs.readFile(path.join(process.cwd(), "fixtures", "email-templates", fx.file), "utf8");
  const r = await importTemplate(getDb(), { name: fx.name, html, sourceKind: "fixture", sourceFilename: fx.file, actor: actorOf(s), correlationId: await rid() });
  revalidatePath("/templates");
  redirect(`/templates/${r.template.id}`);
}

export async function saveGrapesAction(templateId: string, baseVersionId: string, html: string): Promise<{ ok: true; versionId: string; versionNo: number } | { ok: false; error: string }> {
  const s = await requireInternalTools();
  try {
    const v = await saveGrapesJsVersion(getDb(), { templateId, baseVersionId, html, actor: actorOf(s), correlationId: await rid() });
    revalidatePath(`/templates/${templateId}`);
    return { ok: true, versionId: v.id, versionNo: v.versionNo };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
