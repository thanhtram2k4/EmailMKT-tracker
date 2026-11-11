"use server";
/**
 * Server Functions for the CRM screens. Each one re-checks authentication and role itself
 * (Server Functions are reachable by direct POST — Next.js data-security guidance).
 * The Notion token is only ever passed from the form to the encrypting connect function; it is
 * never logged, echoed back, or placed in a redirect URL.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireRole, requireStaff } from "../lib/auth/session";
import { getConfig } from "../lib/config";
import { connectExistingDatabase, createCrmDatabase, disconnectNotion, saveMapping } from "../lib/crm/connection";
import { recordConsentByStaff, ConsentRuleError, type ConsentPurpose, type ConsentStatus } from "../lib/crm/consent";
import { choosePrimary, clearPrimary } from "../lib/crm/duplicates";
import { APP_FIELDS, type AppField, type FieldMapping } from "../lib/crm/mapping";
import { NotionDisabledError, notionEnvFromConfig } from "../lib/crm/notion-env";
import { getDb } from "../lib/db/client";
import { getWorkerUtils } from "../lib/jobs";

const actorOf = (s: { userId: string }) => `user:${s.userId}`;
const rid = async () => (await headers()).get("x-request-id") ?? undefined;
const back = (path: string, params: Record<string, string>): never => redirect(`${path}?${new URLSearchParams(params).toString()}`);

function env() {
  try {
    return notionEnvFromConfig(getConfig());
  } catch (e) {
    if (e instanceof NotionDisabledError) back("/settings/notion", { error: e.message });
    throw e;
  }
}

export async function connectNotionAction(form: FormData) {
  const s = await requireRole("admin");
  const r = await connectExistingDatabase(getDb(), env(), {
    token: String(form.get("token") ?? ""),
    databaseIdOrUrl: String(form.get("database") ?? ""),
    actor: actorOf(s),
    correlationId: await rid(),
  });
  revalidatePath("/settings/notion");
  if (!r.ok) back("/settings/notion", { error: r.error });
  back("/settings/notion", { ok: `Connected to "${(r as { databaseTitle: string }).databaseTitle}". Review the suggested mapping below, then save it.` });
}

export async function createDatabaseAction(form: FormData) {
  const s = await requireRole("admin");
  const r = await createCrmDatabase(getDb(), env(), {
    token: String(form.get("token") ?? ""),
    parentPageIdOrUrl: String(form.get("parent") ?? ""),
    title: String(form.get("title") ?? ""),
    actor: actorOf(s),
    correlationId: await rid(),
  });
  revalidatePath("/settings/notion");
  if (!r.ok) back("/settings/notion", { error: r.error });
  back("/settings/notion", { ok: "CRM database created and connected." });
}

export async function saveMappingAction(form: FormData) {
  const s = await requireRole("admin");
  const mapping: FieldMapping = {};
  for (const f of Object.keys(APP_FIELDS) as AppField[]) {
    const v = String(form.get(`map_${f}`) ?? "");
    if (v) mapping[f] = v;
  }
  const r = await saveMapping(getDb(), env(), { mapping, actor: actorOf(s), correlationId: await rid() });
  revalidatePath("/settings/notion");
  if (!r.ok) back("/settings/notion", { error: r.error });
  back("/settings/notion", { ok: "Mapping saved." });
}

export async function disconnectNotionAction() {
  const s = await requireRole("admin");
  await disconnectNotion(getDb(), { actor: actorOf(s), correlationId: await rid() });
  revalidatePath("/settings/notion");
  back("/settings/notion", { ok: "Disconnected. The token was deleted; contacts, suppressions and consent history were kept." });
}

export async function syncNowAction(form: FormData) {
  const s = await requireRole("admin");
  const mode = form.get("mode") === "full" ? "full" : "incremental";
  const cfg = getConfig();
  if (cfg.NOTION_MODE === "disabled") back("/sync", { error: "Notion access is disabled (NOTION_MODE=disabled)." });
  const requestId = await rid();
  const utils = await getWorkerUtils(cfg.DATABASE_URL);
  // jobKey coalesces repeated clicks; the sync's advisory lock prevents overlap with scheduled runs.
  await utils.addJob("crm_sync", { mode, trigger: "manual", actor: actorOf(s), requestId }, { jobKey: `crm_sync_manual_${mode}`, maxAttempts: 1 });
  revalidatePath("/sync");
  back("/sync", { ok: `${mode === "full" ? "Full" : "Incremental"} sync queued. Refresh in a few seconds to see the result.` });
}

export async function recordConsentAction(form: FormData) {
  const s = await requireRole("admin");
  const contactId = String(form.get("contactId") ?? "");
  const email = String(form.get("email") ?? "");
  const path = `/contacts/${contactId}`;
  const effective = String(form.get("effectiveAt") ?? "");
  try {
    await recordConsentByStaff(getDb(), {
      emailNormalized: email,
      contactId,
      purpose: String(form.get("purpose")) as ConsentPurpose,
      status: String(form.get("status")) as ConsentStatus,
      effectiveAt: effective ? new Date(`${effective}T00:00:00+07:00`) : null,
      evidenceRef: String(form.get("evidenceRef") ?? ""),
      evidenceNote: String(form.get("evidenceNote") ?? ""),
      consentTextVersion: String(form.get("consentTextVersion") ?? ""),
      recordedBy: actorOf(s),
      actor: actorOf(s),
      correlationId: await rid(),
    });
  } catch (e) {
    if (e instanceof ConsentRuleError) back(path, { error: e.message });
    throw e;
  }
  revalidatePath(path);
  back(path, { ok: "Consent record added." });
}

export async function choosePrimaryAction(form: FormData) {
  const s = await requireRole("admin");
  await choosePrimary(getDb(), { contactId: String(form.get("contactId")), actor: actorOf(s), correlationId: await rid() });
  revalidatePath("/contacts/issues");
  back("/contacts/issues", { ok: "Primary contact chosen. The other pages stay in Notion and are excluded from audiences." });
}

export async function clearPrimaryAction(form: FormData) {
  const s = await requireRole("admin");
  await clearPrimary(getDb(), { emailNormalized: String(form.get("email")), actor: actorOf(s), correlationId: await rid() });
  revalidatePath("/contacts/issues");
  back("/contacts/issues", { ok: "Primary choice cleared." });
}

/** Members can read contacts; this exists so pages can assert access in one place. */
export async function assertCanReadContacts() {
  await requireStaff();
}
