"use server";
/**
 * M5 Server Functions: campaigns, suppressions and sending settings.
 * Roles: members create, edit, review and pause campaigns. Approving ("Send now"), resuming,
 * cancelling, resolving uncertain sends, adding suppressions and changing settings need an admin.
 * Every rule is enforced in the service layer too (Server Functions are reachable by direct POST).
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { requireRole, requireStaff } from "../lib/auth/session";
import { getConfig } from "../lib/config";
import { getDb, type Db } from "../lib/db/client";
import { checkEmail } from "../lib/crm/contact-validation";
import { enqueueDispatch, removeStartJob, scheduleStartJob } from "../lib/jobs";
import { acknowledgeAlert } from "../lib/campaigns/alerts";
import { rescheduleCampaign, scheduleCampaign, sendOverdueNow, unscheduleToDraft } from "../lib/campaigns/schedule";
import { writeAudit } from "../lib/audit";
import { maskEmail } from "../lib/redact";
import type { Audience } from "../lib/campaigns/audience";
import {
  approveAndSendNow,
  CampaignError,
  cancelCampaign,
  createCampaign,
  pauseCampaign,
  resolveUncertain,
  resumeCampaign,
  updateDraft,
} from "../lib/campaigns/service";
import { SettingsError, updateSendSettings, type TrackingMode } from "../lib/campaigns/settings";
import { suppressAddress } from "../lib/campaigns/suppression";

const actorOf = (s: { userId: string }) => `user:${s.userId}`;
const rid = async () => (await headers()).get("x-request-id") ?? undefined;
const enqueue = (id: string) => enqueueDispatch(id, getConfig().DATABASE_URL);
const scheduleStart = (id: string, rev: number, at: Date) => scheduleStartJob(id, rev, at, getConfig().DATABASE_URL);
const removeStart = (id: string) => removeStartJob(id, getConfig().DATABASE_URL);
const campaignDeps = () => ({ cfg: getConfig(), enqueue, scheduleStart, removeStart });

function messageOf(e: unknown): string {
  if (e instanceof CampaignError) return [e.message, ...e.details.slice(0, 5)].join(" · ");
  if (e instanceof SettingsError) return e.message;
  if (e instanceof ZodError) return "Invalid input: " + e.issues.map((i) => i.message).join("; ");
  throw e;
}

const back = (path: string, kind: "ok" | "error", msg: string) => `${path}${path.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(msg.slice(0, 600))}`;

function audienceFrom(form: FormData): Audience {
  if (String(form.get("audienceKind") ?? "all_eligible") === "tags") {
    const tags = form.getAll("tags").map(String).map((t) => t.trim()).filter(Boolean);
    return { kind: "tags", tags };
  }
  return { kind: "all_eligible" };
}

export async function createCampaignAction(form: FormData) {
  const s = await requireStaff();
  let target: string;
  try {
    const c = await createCampaign(getDb(), {
      name: String(form.get("name") ?? ""),
      templateId: String(form.get("templateId") ?? ""),
      audience: audienceFrom(form),
      actor: actorOf(s),
      correlationId: await rid(),
    });
    target = `/campaigns/${c.id}?ok=${encodeURIComponent("Draft created. Review it below.")}`;
  } catch (e) {
    target = back("/campaigns", "error", messageOf(e));
  }
  revalidatePath("/campaigns");
  redirect(target);
}

export async function updateCampaignAction(form: FormData) {
  const s = await requireStaff();
  const id = String(form.get("campaignId") ?? "");
  let target: string;
  try {
    await updateDraft(getDb(), {
      campaignId: id,
      name: String(form.get("name") ?? ""),
      templateVersionId: String(form.get("versionId") ?? "") || undefined,
      audience: audienceFrom(form),
      actor: actorOf(s),
      correlationId: await rid(),
    });
    target = back(`/campaigns/${id}`, "ok", "Draft saved. Review the numbers again before sending.");
  } catch (e) {
    target = back(`/campaigns/${id}`, "error", messageOf(e));
  }
  revalidatePath(`/campaigns/${id}`);
  redirect(target);
}

export async function sendNowAction(form: FormData) {
  const s = await requireRole("admin");
  const id = String(form.get("campaignId") ?? "");
  let target: string;
  try {
    if (form.get("confirm") !== "yes") throw new CampaignError("Tick the confirmation box to send.");
    const r = await approveAndSendNow(getDb(), { cfg: getConfig(), enqueue }, {
      campaignId: id,
      expectedRevision: Number(form.get("expectedRevision")),
      expectedRecipients: Number(form.get("expectedRecipients")),
      actor: actorOf(s),
      correlationId: await rid(),
    });
    target = back(`/campaigns/${id}`, "ok", `Approved. ${r.recipients} message(s) queued for sending.`);
  } catch (e) {
    target = back(`/campaigns/${id}`, "error", messageOf(e));
  }
  revalidatePath(`/campaigns/${id}`);
  redirect(target);
}

async function simple(id: string, fn: () => Promise<string>) {
  let target: string;
  try {
    target = back(`/campaigns/${id}`, "ok", await fn());
  } catch (e) {
    target = back(`/campaigns/${id}`, "error", messageOf(e));
  }
  revalidatePath(`/campaigns/${id}`);
  redirect(target);
}

export async function pauseAction(form: FormData) {
  const s = await requireStaff();
  const id = String(form.get("campaignId") ?? "");
  const correlationId = await rid();
  await simple(id, async () => {
    await pauseCampaign(getDb(), { campaignId: id, actor: actorOf(s), correlationId });
    return "Paused. A message already being sent finishes; nothing else is sent until you resume.";
  });
}

export async function resumeAction(form: FormData) {
  const s = await requireRole("admin");
  const id = String(form.get("campaignId") ?? "");
  const correlationId = await rid();
  await simple(id, async () => {
    await resumeCampaign(getDb(), { enqueue }, { campaignId: id, actor: actorOf(s), correlationId });
    return "Resumed.";
  });
}

export async function cancelAction(form: FormData) {
  const s = await requireRole("admin");
  const id = String(form.get("campaignId") ?? "");
  const correlationId = await rid();
  await simple(id, async () => {
    if (form.get("confirm") !== "yes") throw new CampaignError("Tick the confirmation box to cancel.");
    const r = await cancelCampaign(getDb(), { enqueue, removeStart }, { campaignId: id, actor: actorOf(s), correlationId });
    return r.finished ? "Cancelled." : "Cancelling: messages already being sent finish; nothing else is sent.";
  });
}

export async function resolveUncertainAction(form: FormData) {
  const s = await requireRole("admin");
  const id = String(form.get("campaignId") ?? "");
  const action = form.get("action") === "resend" ? "resend" : "mark_not_sent";
  const correlationId = await rid();
  await simple(id, async () => {
    if (action === "resend" && form.get("ackDuplicateRisk") !== "yes") throw new CampaignError("Confirm that you accept the risk of a duplicate email before resending.");
    const r = await resolveUncertain(getDb(), { enqueue }, { campaignId: id, action, actor: actorOf(s), correlationId });
    return action === "resend" ? `${r.count} uncertain message(s) queued to send again.` : `${r.count} uncertain message(s) marked as not sent.`;
  });
}

export async function suppressAddressAction(form: FormData) {
  const s = await requireRole("admin");
  const raw = String(form.get("email") ?? "");
  const note = String(form.get("note") ?? "").trim().slice(0, 500);
  let target: string;
  const c = checkEmail(raw);
  if (c.status !== "valid" || !c.normalized) target = back("/suppressions", "error", "Enter a valid email address.");
  else if (!note) target = back("/suppressions", "error", "Add a note saying why (for example the request or ticket).");
  else {
    const db = getDb();
    const correlationId = await rid();
    const r = await db.transaction((tx) => suppressAddress(tx, { email: c.normalized!, reason: "manual", source: "staff", createdBy: actorOf(s), note }));
    await writeAudit(db as Db, { actor: actorOf(s), action: "suppression.added_manual", entityType: "suppression", entityId: maskEmail(c.normalized), after: { added: r.added, note }, correlationId });
    target = back("/suppressions", "ok", r.added ? `${maskEmail(c.normalized)} is now suppressed.` : `${maskEmail(c.normalized)} was already suppressed.`);
  }
  revalidatePath("/suppressions");
  redirect(target);
}

export async function updateSendingSettingsAction(form: FormData) {
  const s = await requireRole("admin");
  const cfg = getConfig();
  let target: string;
  try {
    await updateSendSettings(getDb(), {
      ratePerSecond: Number(form.get("ratePerSecond")),
      quotaReservePct: Number(form.get("quotaReservePct")),
      graceMinutes: form.get("graceMinutes") === null ? undefined : Number(form.get("graceMinutes")),
      trackingMode: form.get("trackingMode") === null ? undefined : (String(form.get("trackingMode")) as TrackingMode),
      liveCampaignsEnabled: form.get("liveCampaignsEnabled") === "on" ? true : cfg.APP_ENV === "production" ? false : undefined,
      actor: actorOf(s),
      appEnv: cfg.APP_ENV,
      correlationId: await rid(),
    });
    target = back("/settings/sending", "ok", "Sending settings saved.");
  } catch (e) {
    target = back("/settings/sending", "error", messageOf(e));
  }
  revalidatePath("/settings/sending");
  redirect(target);
}

// ---------------------------------------------------------------- M6 scheduling (admin)

function scheduleFields(form: FormData) {
  const so = String(form.get("offsetMinutes") ?? "");
  return {
    date: String(form.get("date") ?? ""),
    time: String(form.get("time") ?? ""),
    zone: String(form.get("zone") ?? ""),
    offsetMinutes: /^-?\d{1,4}$/.test(so) ? Number(so) : null,
  };
}

export async function scheduleCampaignAction(form: FormData) {
  const s = await requireRole("admin");
  const id = String(form.get("campaignId") ?? "");
  const correlationId = await rid();
  await simple(id, async () => {
    if (form.get("confirm") !== "yes") throw new CampaignError("Tick the confirmation box to schedule.");
    const r = await scheduleCampaign(getDb(), campaignDeps(), {
      campaignId: id,
      expectedRevision: Number(form.get("expectedRevision")),
      expectedRecipients: Number(form.get("expectedRecipients")),
      actor: actorOf(s),
      correlationId,
      ...scheduleFields(form),
    });
    return `Scheduled: ${r.recipients} message(s) for ${r.label}.`;
  });
}

export async function rescheduleCampaignAction(form: FormData) {
  const s = await requireRole("admin");
  const id = String(form.get("campaignId") ?? "");
  const correlationId = await rid();
  await simple(id, async () => {
    if (form.get("confirm") !== "yes") throw new CampaignError("Tick the confirmation box to reschedule.");
    const r = await rescheduleCampaign(getDb(), campaignDeps(), { campaignId: id, actor: actorOf(s), correlationId, ...scheduleFields(form) });
    return `Rescheduled for ${r.label} (revision ${r.revision}).`;
  });
}

export async function unscheduleAction(form: FormData) {
  const s = await requireRole("admin");
  const id = String(form.get("campaignId") ?? "");
  const correlationId = await rid();
  await simple(id, async () => {
    await unscheduleToDraft(getDb(), campaignDeps(), { campaignId: id, actor: actorOf(s), correlationId });
    return "Schedule removed — review and confirm again. The campaign is a draft you can edit.";
  });
}

export async function sendOverdueNowAction(form: FormData) {
  const s = await requireRole("admin");
  const id = String(form.get("campaignId") ?? "");
  const correlationId = await rid();
  await simple(id, async () => {
    if (form.get("confirm") !== "yes") throw new CampaignError("Tick the confirmation box to send the held campaign now.");
    await sendOverdueNow(getDb(), campaignDeps(), { campaignId: id, actor: actorOf(s), correlationId });
    return "Released: the held campaign is queued for sending now.";
  });
}

export async function acknowledgeAlertAction(form: FormData) {
  const s = await requireRole("admin");
  const alertId = Number(form.get("alertId"));
  if (Number.isInteger(alertId) && alertId > 0) await acknowledgeAlert(getDb(), alertId, actorOf(s), await rid());
  const back = String(form.get("back") ?? "/");
  revalidatePath(back.startsWith("/") ? back : "/");
  redirect(back.startsWith("/") && !back.startsWith("//") ? back : "/");
}
