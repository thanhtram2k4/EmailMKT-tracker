/**
 * M5 campaign service: create and edit drafts, review, approve + "Send now" (snapshot freeze),
 * pause / resume / cancel, and staff decisions on uncertain sends.
 *
 * Rules (DESIGN §3.4, §4.1; CLAUDE.md invariants):
 *  - Approval freezes an IMMUTABLE snapshot in ONE transaction: content, link table, recipients with
 *    their merge values, and one `pending` message per recipient. Later CRM edits never apply.
 *  - Review blocks on: no subject, unresolved personalization, no unsubscribe link, no recipients,
 *    or a sending-guard refusal. The approver confirms the exact revision and recipient count seen.
 *  - Any edit returns the campaign to draft and increments schedule_revision.
 *  - `unknown` is never retried automatically; staff may resend or mark not sent after 60 minutes.
 */
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { writeAudit } from "../audit";
import { systemClock, type Clock } from "../clock";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";
import { campaignLinks, campaignRecipients, campaigns, campaignSnapshots, messages, templateVersions } from "../db/schema";
import { getLogger } from "../logger";
import { decideSend, type GuardDecision, type SendPurpose } from "../sending/guard";
import { fieldsNeedingValues, scanMergeFields, scanSubject, type MergeField } from "../templates/merge";
import { describeAudience, parseAudience, resolveAudience, type Audience, type ResolvedAudience } from "./audience";
import { contentHash, extractLinks, hasUnsubscribeLink, newTrackingToken, type MergeValues } from "./render";
import { getSendSettings, type SendSettings } from "./settings";
import { CampaignError, finalizeCancel, loadCampaign, transition, type CampaignRow, type Tx } from "./state";

export { CampaignError } from "./state";

export type CampaignConfig = Pick<AppConfig, "APP_ENV" | "SEND_MODE" | "TEST_RECIPIENT_ALLOWLIST" | "SEND_AUTHORIZATION_REF" | "SES_FROM_ADDRESS">;

export type CampaignDeps = {
  cfg: CampaignConfig;
  clock?: Clock;
  /** Queue the dispatcher for a campaign (worker job). Tests inject a recorder. */
  enqueue: (campaignId: string) => Promise<void>;
  /** M6: (re)place the start job for a scheduled campaign (job key per campaign, revision in the payload). */
  scheduleStart?: (campaignId: string, revision: number, runAt: Date) => Promise<void>;
  /** M6: remove the start job (cancel / unschedule). Correctness never depends on it (fenced start). */
  removeStart?: (campaignId: string) => Promise<void>;
};

/** Mock sends need a From for the rendered message; it never leaves the process. */
export const MOCK_FROM = "Email MKT Tracker <campaigns@example.com>";

/** Outside production, campaign messages are integration tests (simulator / allowlist / mock only). */
export const campaignPurpose = (appEnv: AppConfig["APP_ENV"]): SendPurpose => (appEnv === "production" ? "customer_campaign" : "integration_test");

export function campaignGuard(cfg: CampaignConfig, settings: Pick<SendSettings, "liveCampaignsEnabled">, recipients: string[]): GuardDecision {
  return decideSend({
    appEnv: cfg.APP_ENV,
    sendMode: cfg.SEND_MODE,
    purpose: campaignPurpose(cfg.APP_ENV),
    recipients,
    testRecipientAllowlist: cfg.TEST_RECIPIENT_ALLOWLIST,
    authorizationRef: cfg.SEND_AUTHORIZATION_REF,
    liveCampaignsEnabled: settings.liveCampaignsEnabled,
  });
}

export function fromAddressFor(cfg: CampaignConfig): string | null {
  if (cfg.SEND_MODE === "mock") return cfg.SES_FROM_ADDRESS ?? MOCK_FROM;
  return cfg.SES_FROM_ADDRESS ?? null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const assertUuid = (id: string, what: string) => {
  if (!UUID.test(id)) throw new CampaignError(`${what} not found.`);
};

// ---------------------------------------------------------------- drafts

export async function createCampaign(db: Db, i: { name: string; templateId: string; templateVersionId?: string; audience: Audience; actor: string; correlationId?: string }) {
  const name = i.name.trim().slice(0, 200);
  if (!name) throw new CampaignError("Give the campaign a name.");
  assertUuid(i.templateId, "Email");
  const audience = parseAudience(i.audience);
  const v = i.templateVersionId
    ? (await db.select().from(templateVersions).where(and(eq(templateVersions.id, i.templateVersionId), eq(templateVersions.templateId, i.templateId))).limit(1))[0]
    : (await db.select().from(templateVersions).where(eq(templateVersions.templateId, i.templateId)).orderBy(sql`${templateVersions.versionNo} desc`).limit(1))[0];
  if (!v) throw new CampaignError("Email not found.");
  const [c] = await db.insert(campaigns).values({ name, templateId: i.templateId, templateVersionId: v.id, audience, createdBy: i.actor }).returning();
  await writeAudit(db, { actor: i.actor, action: "campaign.created", entityType: "campaign", entityId: c.id, after: { name, templateVersionId: v.id, audience }, correlationId: i.correlationId });
  return c;
}

/** Edit a draft. Every edit increments schedule_revision, so a review of the old revision cannot be approved. */
export async function updateDraft(
  db: Db,
  i: { campaignId: string; name?: string; templateVersionId?: string; audience?: Audience; actor: string; correlationId?: string },
) {
  assertUuid(i.campaignId, "Campaign");
  return db.transaction(async (tx) => {
    const c = (await tx.select().from(campaigns).where(eq(campaigns.id, i.campaignId)).for("update"))[0];
    if (!c) throw new CampaignError("Campaign not found.");
    if (c.status !== "draft") throw new CampaignError(`Only a draft can be edited (this campaign is ${c.status}).`);
    const set: Partial<typeof campaigns.$inferInsert> = {};
    if (i.name !== undefined) {
      const n = i.name.trim().slice(0, 200);
      if (!n) throw new CampaignError("Give the campaign a name.");
      set.name = n;
    }
    if (i.templateVersionId !== undefined) {
      const v = (await tx.select().from(templateVersions).where(and(eq(templateVersions.id, i.templateVersionId), eq(templateVersions.templateId, c.templateId))).limit(1))[0];
      if (!v) throw new CampaignError("That version does not belong to this campaign's email.");
      set.templateVersionId = v.id;
    }
    if (i.audience !== undefined) set.audience = parseAudience(i.audience);
    const [u] = await tx
      .update(campaigns)
      .set({ ...set, scheduleRevision: sql`${campaigns.scheduleRevision} + 1`, updatedAt: new Date() })
      .where(and(eq(campaigns.id, c.id), eq(campaigns.status, "draft")))
      .returning();
    await writeAudit(tx as unknown as Db, { actor: i.actor, action: "campaign.edited", entityType: "campaign", entityId: c.id, before: pick(c), after: pick(u), correlationId: i.correlationId });
    return u;
  });
}

const pick = (c: CampaignRow) => ({ name: c.name, templateVersionId: c.templateVersionId, audience: c.audience, scheduleRevision: c.scheduleRevision });

// ---------------------------------------------------------------- review

export type CampaignReview = {
  campaign: CampaignRow;
  version: { id: string; versionNo: number; subject: string | null; html: string; plainText: string };
  audience: Audience;
  audienceLabel: string;
  resolved: ResolvedAudience;
  fromAddress: string | null;
  /** Problems that prevent approval. */
  blocking: string[];
  warnings: string[];
  /** Included recipients missing a value used without fallback (each blocks approval). */
  missingValues: Array<{ contactId: string; name: string; missing: string[] }>;
  guard: GuardDecision;
  settings: SendSettings;
};

export async function reviewCampaign(db: Db, cfg: CampaignConfig, campaignId: string): Promise<CampaignReview> {
  assertUuid(campaignId, "Campaign");
  const c = await loadCampaign(db, campaignId);
  if (!c) throw new CampaignError("Campaign not found.");
  return buildReview(db, cfg, c);
}

async function buildReview(db: Db, cfg: CampaignConfig, c: CampaignRow): Promise<CampaignReview> {
  const v = (await db.select().from(templateVersions).where(eq(templateVersions.id, c.templateVersionId)).limit(1))[0];
  if (!v) throw new CampaignError("The campaign's email version no longer exists.");
  const audience = parseAudience(c.audience);
  const [resolved, settings] = await Promise.all([resolveAudience(db, audience), getSendSettings(db)]);
  const blocking: string[] = [];
  const warnings: string[] = [];

  const subject = v.subject?.trim() ? v.subject : null;
  if (!subject) blocking.push("The email has no subject. Add one in the email editor (it creates a new version), then choose that version.");
  for (const p of scanSubject(subject ?? "")) blocking.push(`Subject: ${p.raw} — ${p.error}`);
  for (const u of scanMergeFields(v.html).uses) if (u.problem) blocking.push(`Body: ${u.raw} — ${u.problem.replace(/_/g, " ")}`);
  for (const u of scanMergeFields(v.plainText).uses) if (u.problem && u.problem !== "missing_fallback_in_href") blocking.push(`Plain text: ${u.raw} — ${u.problem.replace(/_/g, " ")}`);
  if (!hasUnsubscribeLink(v.html)) {
    blocking.push('The email has no unsubscribe link. Add a link whose address is {{ unsubscribe_url }} (for example in the footer) — every campaign email must carry one.');
  }

  const need = fieldsNeedingValues(subject ?? "", v.html, v.plainText) as MergeField[];
  const missingValues: CampaignReview["missingValues"] = [];
  for (const r of resolved.included) {
    const mv: Record<string, string | null> = { full_name: r.fullName, greeting_name: r.greetingName, company: r.company, email: r.emailNormalized };
    const missing = need.filter((f) => !String(mv[f] ?? "").trim());
    if (missing.length) missingValues.push({ contactId: r.id, name: r.fullName ?? r.emailNormalized ?? r.id, missing });
  }
  if (missingValues.length) {
    blocking.push(`${missingValues.length} recipient(s) have no value for a merge field used without a fallback. Add a default (e.g. {{ greeting_name | default: "Quý khách" }}) or fix the data in Notion.`);
  }
  if (resolved.included.length === 0) blocking.push("No eligible recipients: the audience is empty after exclusions.");

  const recipients = resolved.included.map((r) => r.emailNormalized!).filter(Boolean);
  let guard = campaignGuard(cfg, settings, recipients.length ? recipients : ["nobody@example.com"]);
  if (!guard.allowed) blocking.push(`Sending is not allowed here: ${guard.reason}.`);
  const fromAddress = fromAddressFor(cfg);
  if (guard.allowed && guard.transport === "real" && !fromAddress) {
    guard = { allowed: false, reason: "SES_FROM_ADDRESS is not set" };
    blocking.push("Sending is not allowed here: SES_FROM_ADDRESS is not set.");
  }

  if (subject && !/^\s*\[(QC|AD)\]/i.test(subject)) {
    warnings.push("The subject does not start with [QC] or [AD]. Decree 91 reportedly requires this label on advertising emails (pending counsel; docs/COMPLIANCE.md).");
  }
  if (cfg.SEND_MODE === "mock") warnings.push("SEND_MODE=mock: messages are recorded in this process only. Nothing is emailed.");
  if (resolved.excludedByReason.consent_unknown) {
    warnings.push(`${resolved.excludedByReason.consent_unknown} contact(s) are excluded because no marketing consent is recorded (crm.require_marketing_consent).`);
  }

  return {
    campaign: c,
    version: { id: v.id, versionNo: v.versionNo, subject, html: v.html, plainText: v.plainText },
    audience,
    audienceLabel: describeAudience(audience),
    resolved,
    fromAddress,
    blocking,
    warnings,
    missingValues,
    guard,
    settings,
  };
}

// ---------------------------------------------------------------- approve + send now

export async function approveAndSendNow(
  db: Db,
  deps: CampaignDeps,
  i: { campaignId: string; expectedRevision: number; expectedRecipients: number; actor: string; correlationId?: string },
) {
  const r = await approveCampaign(db, deps, i, { status: "queued", reason: "approved: send now", auditAction: "campaign.approved_send_now" });
  await deps.enqueue(i.campaignId);
  return r;
}

export type ApprovalTarget = {
  status: "queued" | "scheduled";
  reason: string;
  auditAction: string;
  /** Extra campaign columns set in the same fenced update (the schedule). */
  set?: Partial<typeof campaigns.$inferInsert>;
  auditExtra?: Record<string, unknown>;
};

/**
 * Freeze an immutable snapshot (content, link table, recipients with merge values, one pending message
 * each) and move the campaign out of draft — all in ONE transaction. Used by "Send now" (→ queued) and
 * "Schedule" (→ scheduled). The approver must confirm the revision and recipient count they reviewed.
 */
export async function approveCampaign(
  db: Db,
  deps: Pick<CampaignDeps, "cfg" | "clock">,
  i: { campaignId: string; expectedRevision: number; expectedRecipients: number; actor: string; correlationId?: string },
  target: ApprovalTarget,
) {
  assertUuid(i.campaignId, "Campaign");
  const clock = deps.clock ?? systemClock;
  const log = getLogger().child({ campaign_id: i.campaignId, request_id: i.correlationId });

  const result = await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const c = (await tx.select().from(campaigns).where(eq(campaigns.id, i.campaignId)).for("update"))[0];
    if (!c) throw new CampaignError("Campaign not found.");
    if (c.status !== "draft") throw new CampaignError(`This campaign is ${c.status}; only a draft can be approved.`);
    if (c.scheduleRevision !== i.expectedRevision) throw new CampaignError("The campaign was edited after you reviewed it. Review it again before sending.");

    const r = await buildReview(t, deps.cfg, c);
    if (r.blocking.length) throw new CampaignError("This campaign cannot be sent yet.", r.blocking);
    if (r.resolved.included.length !== i.expectedRecipients) {
      throw new CampaignError(`The audience changed since your review (now ${r.resolved.included.length} recipients, you confirmed ${i.expectedRecipients}). Review it again.`);
    }

    const now = clock.now();
    const subject = r.version.subject!;
    const [snap] = await tx
      .insert(campaignSnapshots)
      .values({
        campaignId: c.id,
        scheduleRevision: c.scheduleRevision,
        templateVersionId: r.version.id,
        subjectTemplate: subject,
        html: r.version.html,
        plainText: r.version.plainText,
        fromAddress: r.fromAddress!,
        contentHash: contentHash(subject, r.version.html, r.version.plainText),
        audience: r.audience,
        counts: { matched: r.resolved.matched, included: r.resolved.included.length, excluded: r.resolved.excludedTotal, excludedByReason: r.resolved.excludedByReason },
        approvedBy: i.actor,
        approvedAt: now,
      })
      .returning();

    const links = extractLinks(r.version.html);
    if (links.length) await tx.insert(campaignLinks).values(links.map((l) => ({ snapshotId: snap.id, ...l })));

    for (let k = 0; k < r.resolved.included.length; k += 500) {
      const chunk = r.resolved.included.slice(k, k + 500);
      const recs = await tx
        .insert(campaignRecipients)
        .values(
          chunk.map((ct) => ({
            snapshotId: snap.id,
            contactId: ct.id,
            emailNormalized: ct.emailNormalized!,
            mergeValues: { full_name: ct.fullName, greeting_name: ct.greetingName, company: ct.company, email: ct.emailNormalized! } satisfies MergeValues,
          })),
        )
        .returning({ id: campaignRecipients.id, email: campaignRecipients.emailNormalized });
      await tx.insert(messages).values(
        recs.map((x) => ({ campaignId: c.id, snapshotId: snap.id, recipientId: x.id, emailNormalized: x.email, trackingToken: newTrackingToken(), nextAttemptAt: now, createdAt: now, updatedAt: now })),
      );
    }

    const ok = await transition(tx, c, target.status, i.actor, target.reason, {
      set: { snapshotId: snap.id, approvedBy: i.actor, approvedAt: now, ...target.set },
      detail: { snapshotId: snap.id, recipients: r.resolved.included.length, excluded: r.resolved.excludedByReason, ...target.auditExtra },
      correlationId: i.correlationId,
      now,
    });
    if (!ok) throw new CampaignError("The campaign changed while it was being approved. Review it again.");
    await writeAudit(t, {
      actor: i.actor,
      action: target.auditAction,
      entityType: "campaign",
      entityId: c.id,
      after: { snapshotId: snap.id, revision: c.scheduleRevision, recipients: r.resolved.included.length, contentHash: snap.contentHash, sendMode: deps.cfg.SEND_MODE, ...target.auditExtra },
      correlationId: i.correlationId,
    });
    return { snapshotId: snap.id, recipients: r.resolved.included.length, revision: c.scheduleRevision };
  });

  log.info({ snapshot_id: result.snapshotId, recipients: result.recipients, status: target.status }, "campaign approved");
  return result;
}

// ---------------------------------------------------------------- pause / resume / cancel

async function lockCampaign(tx: Tx, id: string) {
  assertUuid(id, "Campaign");
  const c = (await (tx as Db).select().from(campaigns).where(eq(campaigns.id, id)).for("update"))[0];
  if (!c) throw new CampaignError("Campaign not found.");
  return c;
}

export async function pauseCampaign(db: Db, i: { campaignId: string; actor: string; correlationId?: string }) {
  await db.transaction(async (tx) => {
    const c = await lockCampaign(tx, i.campaignId);
    if (c.status !== "sending" && c.status !== "queued") throw new CampaignError(`Only a queued or sending campaign can be paused (this one is ${c.status}).`);
    await transition(tx, c, "paused", i.actor, "paused by staff", { correlationId: i.correlationId });
    await writeAudit(tx as unknown as Db, { actor: i.actor, action: "campaign.paused", entityType: "campaign", entityId: c.id, correlationId: i.correlationId });
  });
}

export async function resumeCampaign(db: Db, deps: Pick<CampaignDeps, "enqueue">, i: { campaignId: string; actor: string; correlationId?: string }) {
  await db.transaction(async (tx) => {
    const c = await lockCampaign(tx, i.campaignId);
    if (c.status !== "paused" && c.status !== "blocked") throw new CampaignError(`Only a paused or blocked campaign can be resumed (this one is ${c.status}).`);
    await transition(tx, c, "sending", i.actor, c.status === "blocked" ? `resumed after block (${c.blockCode})` : "resumed by staff", {
      set: { blockCode: null, blockMessage: null },
      correlationId: i.correlationId,
    });
    await writeAudit(tx as unknown as Db, { actor: i.actor, action: "campaign.resumed", entityType: "campaign", entityId: c.id, before: { status: c.status, blockCode: c.blockCode }, correlationId: i.correlationId });
  });
  await deps.enqueue(i.campaignId);
}

export async function cancelCampaign(db: Db, deps: Pick<CampaignDeps, "enqueue" | "clock" | "removeStart">, i: { campaignId: string; actor: string; correlationId?: string }) {
  const now = (deps.clock ?? systemClock).now();
  const finished = await db.transaction(async (tx) => {
    const c = await lockCampaign(tx, i.campaignId);
    await writeAudit(tx as unknown as Db, { actor: i.actor, action: "campaign.cancel_requested", entityType: "campaign", entityId: c.id, before: { status: c.status }, correlationId: i.correlationId });
    if (c.status === "draft") {
      await transition(tx, c, "cancelled", i.actor, "draft cancelled", { set: { finishedAt: now }, correlationId: i.correlationId, now });
      return true;
    }
    if (!["scheduled", "held_overdue", "queued", "sending", "paused", "blocked"].includes(c.status)) throw new CampaignError(`This campaign is ${c.status} and cannot be cancelled.`);
    await transition(tx, c, "cancelling", i.actor, "cancel requested", { correlationId: i.correlationId, now });
    const fresh = (await loadCampaign(tx, c.id))!;
    return finalizeCancel(tx, fresh, i.actor, now);
  });
  // A scheduled start job is removed (a stale one would fail the fenced start anyway).
  await deps.removeStart?.(i.campaignId);
  // A dispatcher may still hold claims in flight; it finalizes the cancel when they are done.
  if (!finished) await deps.enqueue(i.campaignId);
  return { finished };
}

// ---------------------------------------------------------------- uncertain sends

/** Wait this long after a send became uncertain before staff may resolve it (events reconcile first). */
export const UNKNOWN_RESOLVE_AFTER_MS = 60 * 60 * 1000;

export async function resolveUncertain(
  db: Db,
  deps: Pick<CampaignDeps, "enqueue" | "clock">,
  i: { campaignId: string; action: "resend" | "mark_not_sent"; actor: string; correlationId?: string },
): Promise<{ count: number }> {
  const now = (deps.clock ?? systemClock).now();
  const cutoff = new Date(now.getTime() - UNKNOWN_RESOLVE_AFTER_MS);
  const res = await db.transaction(async (tx) => {
    const c = await lockCampaign(tx, i.campaignId);
    if (i.action === "resend" && !["sending", "paused", "blocked", "completed", "completed_with_issues"].includes(c.status)) {
      throw new CampaignError(`Uncertain messages cannot be resent while the campaign is ${c.status}.`);
    }
    const ready = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.campaignId, c.id), eq(messages.sendStatus, "unknown"), lt(messages.claimedAt, cutoff)));
    if (!ready.length) throw new CampaignError("No uncertain message is ready to resolve (they become available 60 minutes after the attempt, so provider events can reconcile them first).");
    const ids = ready.map((r) => r.id);
    if (i.action === "resend") {
      await tx
        .update(messages)
        .set({
          sendStatus: "pending",
          attemptNo: sql`${messages.attemptNo} + 1`,
          resolution: "resend_approved",
          resolvedBy: i.actor,
          resolvedAt: now,
          claimedAt: null,
          claimedBy: null,
          nextAttemptAt: now,
          updatedAt: now,
        })
        .where(and(inArray(messages.id, ids), eq(messages.sendStatus, "unknown")));
      if (c.status === "completed" || c.status === "completed_with_issues") {
        await transition(tx, c, "sending", i.actor, `resend of ${ids.length} uncertain message(s) approved`, { set: { finishedAt: null }, correlationId: i.correlationId, now });
      }
    } else {
      await tx
        .update(messages)
        .set({ sendStatus: "marked_not_sent", resolution: "marked_not_sent", resolvedBy: i.actor, resolvedAt: now, updatedAt: now })
        .where(and(inArray(messages.id, ids), eq(messages.sendStatus, "unknown")));
    }
    await writeAudit(tx as unknown as Db, {
      actor: i.actor,
      action: i.action === "resend" ? "campaign.uncertain_resend_approved" : "campaign.uncertain_marked_not_sent",
      entityType: "campaign",
      entityId: c.id,
      after: { count: ids.length, duplicateRiskAcknowledged: i.action === "resend" },
      correlationId: i.correlationId,
    });
    return { count: ids.length, requeue: i.action === "resend" };
  });
  if (res.requeue) await deps.enqueue(i.campaignId);
  return { count: res.count };
}
