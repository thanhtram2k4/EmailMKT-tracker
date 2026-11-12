"use server";
/**
 * M4 Server Functions: subject editing, test sends and the (admin) SES account check.
 * Every function re-checks the signed-in staff member; Server Functions are reachable by direct POST,
 * so every rule (allowlist, suppression, guard, rate limit) is enforced in the service, not the UI.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireRole, requireStaff } from "../lib/auth/session";
import { getConfig } from "../lib/config";
import { getDb } from "../lib/db/client";
import { testSends } from "../lib/db/schema";
import { getSesAccount, makeSesClient, type SesAccountInfo } from "../lib/sending/ses-transport";
import { sendTestEmail, testSendAvailability, TestSendError, type TestSendOutcome } from "../lib/sending/test-send";
import { saveSubject } from "../lib/templates/service";

const actorOf = (s: { userId: string }) => `user:${s.userId}`;
const rid = async () => (await headers()).get("x-request-id") ?? undefined;

export async function saveSubjectAction(form: FormData) {
  const s = await requireStaff();
  const templateId = String(form.get("templateId") ?? "");
  const baseVersionId = String(form.get("baseVersionId") ?? "");
  let target: string;
  try {
    const v = await saveSubject(getDb(), { templateId, baseVersionId, subject: String(form.get("subject") ?? ""), actor: actorOf(s), correlationId: await rid() });
    target = `/templates/${templateId}?v=${v.id}&ok=${encodeURIComponent(`Subject saved as version ${v.versionNo}.`)}`;
  } catch (e) {
    target = `/templates/${templateId}?v=${baseVersionId}&error=${encodeURIComponent(e instanceof Error ? e.message : String(e))}`;
  }
  revalidatePath(`/templates/${templateId}`);
  redirect(target);
}

export type TestSendState = {
  /** Fresh idempotency key for the next submit (a double click reuses the current one). */
  key: string;
  error?: string;
  details?: string[];
  results?: TestSendOutcome[];
};

export async function sendTestAction(prev: TestSendState, form: FormData): Promise<TestSendState> {
  const s = await requireStaff();
  const templateId = String(form.get("templateId") ?? "");
  const key = String(form.get("idempotencyKey") ?? prev.key);
  try {
    const results = await sendTestEmail(
      getDb(),
      { cfg: getConfig() },
      {
        templateId,
        versionId: String(form.get("versionId") ?? ""),
        recipients: String(form.get("recipients") ?? ""),
        mergeSource: String(form.get("mergeSource") ?? ""),
        idempotencyKey: key,
        resendOf: String(form.get("resendOf") ?? "") || undefined,
        actor: actorOf(s),
        correlationId: await rid(),
      },
    );
    revalidatePath(`/templates/${templateId}`);
    return { key: randomUUID(), results };
  } catch (e) {
    if (e instanceof TestSendError) return { key, error: e.message, details: e.details };
    throw e;
  }
}

/** "Send again" after an uncertain/failed attempt: an explicit, new, audited attempt (new row). */
export async function resendTestAction(prev: TestSendState, form: FormData): Promise<TestSendState> {
  await requireStaff();
  const id = String(form.get("resendOf") ?? "");
  const row = /^[0-9a-f-]{36}$/i.test(id) ? (await getDb().select().from(testSends).where(eq(testSends.id, id)).limit(1))[0] : undefined;
  if (!row) return { key: prev.key, error: "Test send not found." };
  const f = new FormData();
  f.set("templateId", row.templateId);
  f.set("versionId", row.templateVersionId);
  f.set("recipients", row.recipientEmail);
  f.set("mergeSource", row.mergeSource);
  f.set("resendOf", row.id);
  f.set("idempotencyKey", String(form.get("idempotencyKey") ?? randomUUID()));
  return sendTestAction(prev, f);
}

export type SesCheckState = { info?: SesAccountInfo; error?: string };

/** Admin-only, read-only SES GetAccount. Refused unless a real test transport is authorized here. */
export async function sesAccountCheckAction(): Promise<SesCheckState> {
  await requireRole("admin");
  const cfg = getConfig();
  const a = testSendAvailability(cfg);
  if (cfg.SEND_MODE === "mock" || cfg.SEND_MODE === "disabled" || !a.available) {
    return { error: `Not available: SES calls are only made when real test sends are authorized (SEND_MODE=${cfg.SEND_MODE}).` };
  }
  try {
    return { info: await getSesAccount(makeSesClient(cfg.SES_REGION), cfg.SES_TIMEOUT_MS) };
  } catch (e) {
    const err = e as { name?: string; message?: string };
    return { error: `${err.name ?? "Error"}: ${(err.message ?? "").slice(0, 200)}` };
  }
}
