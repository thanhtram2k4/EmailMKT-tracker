/**
 * Admin alerts (DESIGN §4.2 "Visibility"): created when a scheduled campaign is held (started later
 * than the grace period) or a campaign is blocked at execution time. Shown in the app until an admin
 * acknowledges them; emailed to active admins by the worker, through the sending guard:
 *  - SEND_MODE=disabled → not emailed (recorded as not_sent, still shown in the app);
 *  - mock → the in-process mock transport (nothing leaves the machine);
 *  - simulator/allowlist/live → only addresses the guard allows for a test send (allowlist).
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { writeAudit } from "../audit";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";
import { adminAlerts, campaigns, staffAllowlist } from "../db/schema";
import { getLogger } from "../logger";
import { maskEmail } from "../redact";
import { decideSend } from "../sending/guard";
import { makeSesClient, type SesClientLike } from "../sending/ses-transport";
import { createTransport, MockTransport, type SendResult } from "../sending/transport";

type Tx = Pick<Db, "insert">;

export type AlertKind = "held_overdue" | "blocked";

export async function createAlert(tx: Tx, a: { kind: AlertKind; campaignId: string; message: string }) {
  await tx.insert(adminAlerts).values({ kind: a.kind, campaignId: a.campaignId, message: a.message.slice(0, 1000) });
}

export async function openAlerts(db: Db) {
  const r = await db.execute(sql`
    select a.id, a.kind, a.message, a.created_at, a.email_status, a.campaign_id, c.name as campaign_name, c.status::text as campaign_status
    from admin_alerts a left join campaigns c on c.id = a.campaign_id
    where a.acknowledged_at is null order by a.created_at desc limit 20`);
  return r.rows as Array<{ id: number; kind: string; message: string; created_at: string; email_status: string; campaign_id: string | null; campaign_name: string | null; campaign_status: string | null }>;
}

export async function acknowledgeAlert(db: Db, id: number, actor: string, correlationId?: string) {
  const r = await db
    .update(adminAlerts)
    .set({ acknowledgedBy: actor, acknowledgedAt: new Date() })
    .where(and(eq(adminAlerts.id, id), isNull(adminAlerts.acknowledgedAt)))
    .returning({ id: adminAlerts.id });
  if (r.length) await writeAudit(db, { actor, action: "alert.acknowledged", entityType: "admin_alert", entityId: String(id), correlationId });
  return r.length > 0;
}

export type AlertMailConfig = Pick<AppConfig, "APP_ENV" | "SEND_MODE" | "TEST_RECIPIENT_ALLOWLIST" | "SEND_AUTHORIZATION_REF" | "SES_REGION" | "SES_FROM_ADDRESS" | "SES_CONFIGURATION_SET" | "SES_TIMEOUT_MS"> & {
  APP_BASE_URL: string;
};

/** Email pending alerts to active admins (worker cron). Each alert is processed once. */
export async function emailPendingAlerts(db: Db, deps: { cfg: AlertMailConfig; mock?: MockTransport; sesClient?: SesClientLike }): Promise<number> {
  const log = getLogger().child({ task: "admin_alert_email" });
  const pending = await db.select().from(adminAlerts).where(eq(adminAlerts.emailStatus, "pending")).orderBy(asc(adminAlerts.id)).limit(20);
  if (!pending.length) return 0;
  const admins = (await db.select({ email: staffAllowlist.email }).from(staffAllowlist).where(and(eq(staffAllowlist.role, "admin"), isNull(staffAllowlist.disabledAt)))).map((r) => r.email);
  let sesClient = deps.sesClient;
  for (const a of pending) {
    // Claim the alert first (pending → sending) so two workers never email it twice.
    const claimed = await db.update(adminAlerts).set({ emailStatus: "sending" }).where(and(eq(adminAlerts.id, a.id), eq(adminAlerts.emailStatus, "pending"))).returning({ id: adminAlerts.id });
    if (!claimed.length) continue;
    const c = a.campaignId ? (await db.select({ name: campaigns.name }).from(campaigns).where(eq(campaigns.id, a.campaignId)).limit(1))[0] : undefined;
    const outcomes: string[] = [];
    let sent = 0;
    for (const to of admins) {
      const guardInput = {
        appEnv: deps.cfg.APP_ENV,
        sendMode: deps.cfg.SEND_MODE,
        purpose: "test_send" as const,
        recipients: [to],
        testRecipientAllowlist: deps.cfg.TEST_RECIPIENT_ALLOWLIST,
        authorizationRef: deps.cfg.SEND_AUTHORIZATION_REF,
        liveCampaignsEnabled: false,
      };
      const d = decideSend(guardInput);
      if (!d.allowed) {
        outcomes.push(`${maskEmail(to)}: not sent (${d.reason})`);
        continue;
      }
      let r: SendResult;
      try {
        const t = createTransport(guardInput, {
          mock: deps.mock ?? new MockTransport(),
          ses: deps.cfg.SES_FROM_ADDRESS
            ? { region: deps.cfg.SES_REGION, from: deps.cfg.SES_FROM_ADDRESS, configurationSet: deps.cfg.SES_CONFIGURATION_SET, timeoutMs: deps.cfg.SES_TIMEOUT_MS, client: (sesClient ??= makeSesClient(deps.cfg.SES_REGION)) }
            : null,
        });
        const link = a.campaignId ? `${deps.cfg.APP_BASE_URL}/campaigns/${a.campaignId}` : deps.cfg.APP_BASE_URL;
        r = await t.send({
          messageId: `alert-${a.id}`,
          from: deps.cfg.SES_FROM_ADDRESS ?? "Email MKT Tracker <alerts@example.com>",
          to,
          subject: `[Email MKT Tracker] ${a.kind === "held_overdue" ? "Campaign held" : "Campaign blocked"}: ${c?.name ?? "campaign"}`.replace(/[\r\n]/g, " ").slice(0, 200),
          html: `<p>${escapeHtml(a.message)}</p><p><a href="${escapeHtml(link)}">Open the campaign</a></p>`,
          text: `${a.message}\n\nOpen the campaign: ${link}`,
          headers: { "X-EMT-Purpose": "admin-alert" },
          tags: { purpose: "admin_alert" },
        });
      } catch (e) {
        r = { kind: "rejected", code: "transport_unavailable", message: e instanceof Error ? e.message : String(e) };
      }
      if (r.kind === "accepted") sent++;
      outcomes.push(`${maskEmail(to)}: ${r.kind}`);
    }
    const status = sent > 0 ? "sent" : outcomes.some((o) => /: (rejected|retryable|unknown)$/.test(o)) ? "failed" : "not_sent";
    await db
      .update(adminAlerts)
      .set({ emailStatus: status, emailDetail: (outcomes.join("; ") || "no active admin").slice(0, 1000), emailedAt: new Date() })
      .where(eq(adminAlerts.id, a.id));
    log.info({ alert_id: a.id, status }, "admin alert email processed");
  }
  return pending.length;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
