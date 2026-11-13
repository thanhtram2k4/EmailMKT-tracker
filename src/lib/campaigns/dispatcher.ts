/**
 * M5 dispatcher (DESIGN §4.1). One run of `dispatchCampaign`:
 *  1. takes a session advisory lock for the campaign (a second dispatcher is a no-op);
 *  2. fenced start queued → sending;
 *  3. execution-time account check (sending enabled, credentials, daily quota with a reserve);
 *  4. claims a batch with FOR UPDATE SKIP LOCKED and COMMITS `claimed` before any provider call;
 *  5. per message, immediately before the call: campaign still sending, address not suppressed,
 *     marketing consent still valid, sending guard still allows it, rate limiter slot;
 *  6. maps the outcome: accepted → sent; definitive refusal → failed_permanent; throttling → back to
 *     pending with backoff; account/credential problems → back to pending and campaign `blocked`;
 *     timeout / anything uncertain → `unknown` (never retried automatically);
 *  7. stops after a time budget so the job can be re-queued (long sends survive worker restarts).
 * A crash between claim and result leaves `claimed` rows; the reaper turns them into `unknown`.
 */
import { and, eq, sql } from "drizzle-orm";
import { writeAudit } from "../audit";
import { systemClock, type Clock } from "../clock";
import type { AppConfig } from "../config";
import { getRequireConsent } from "../crm/queries";
import type { Db } from "../db/client";
import { campaignRecipients, campaignSnapshots, contacts, messages } from "../db/schema";
import { getLogger } from "../logger";
import { maskEmail } from "../redact";
import { makeSesClient, type SesClientLike } from "../sending/ses-transport";
import { createTransport, MockTransport, TransportUnavailableError, type AccountCheck, type MailTransport, type SendResult } from "../sending/transport";
import { renderMessage, unsubscribeHeaders, type MergeValues } from "./render";
import { campaignGuard, campaignPurpose } from "./service";
import { getSendSettings } from "./settings";
import { createAlert } from "./alerts";
import { finalizeCancel, loadCampaign, maybeComplete, transition, type CampaignRow } from "./state";

export type DispatchConfig = Pick<
  AppConfig,
  | "APP_ENV"
  | "SEND_MODE"
  | "TEST_RECIPIENT_ALLOWLIST"
  | "SEND_AUTHORIZATION_REF"
  | "SES_REGION"
  | "SES_FROM_ADDRESS"
  | "SES_CONFIGURATION_SET"
  | "SES_TIMEOUT_MS"
> & { trackingBaseUrl: string };

export type DispatchDeps = {
  cfg: DispatchConfig;
  workerId: string;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  /** Transport used when the guard selects mock (tests inject scripted outcomes). */
  mock?: MockTransport;
  /** SES client override (tests inject a fake; no network). */
  sesClient?: SesClientLike;
  limiter?: RateLimiter;
};

export type DispatchResult = {
  result: "locked" | "inactive" | "completed" | "cancelled" | "paused" | "blocked" | "continue" | "waiting";
  /** For "waiting": when pending work becomes due (throttle backoff, or claims held elsewhere). */
  nextRunAt?: Date;
  attempted: number;
};

export const STALE_CLAIM_MS = 10 * 60 * 1000;
export const QUOTA_RECHECK_EVERY = 100;
const MAX_THROTTLE_BACKOFF_MS = 60_000;

/**
 * Process-wide send pacing: at most `rate` provider calls per second (burst 1). Shared by every
 * campaign dispatched in this process. A throttling response pushes the next slot back (`penalize`).
 */
export class RateLimiter {
  private next = 0;
  constructor(
    private rate: number,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}
  setRate(rate: number) {
    this.rate = rate;
  }
  get ratePerSecond() {
    return this.rate;
  }
  async take(): Promise<void> {
    const t = this.now();
    const at = Math.max(t, this.next);
    this.next = at + 1000 / this.rate;
    if (at > t) await this.sleep(at - t);
  }
  penalize(ms: number) {
    this.next = Math.max(this.next, this.now() + ms);
  }
}

const sharedLimiter = new RateLimiter(5);

/** Account / configuration problems that stop the whole campaign (message not sent, campaign blocked). */
const BLOCKING_CODES = new Set(["credentials", "SendingPausedException", "AccountSuspendedException", "MailFromDomainNotVerifiedException", "transport_unavailable", "send_refused"]);

type Claimed = { id: string; recipient_id: string; email_normalized: string; tracking_token: string; attempt_no: number; throttle_count: number };

export async function dispatchCampaign(db: Db, deps: DispatchDeps, campaignId: string, opts: { budgetMs?: number; batchSize?: number } = {}): Promise<DispatchResult> {
  const clock = deps.clock ?? systemClock;
  const log = getLogger().child({ campaign_id: campaignId, worker_id: deps.workerId, task: "dispatch_campaign" });
  const budgetMs = opts.budgetMs ?? 50_000;
  const batchSize = opts.batchSize ?? 25;
  const startedAt = Date.now();

  const client = await db.$client.connect();
  let locked = false;
  try {
    locked = Boolean((await client.query("select pg_try_advisory_lock(hashtextextended($1, 0)) as ok", [`dispatch:${campaignId}`])).rows[0]?.ok);
    if (!locked) {
      log.debug("another dispatcher holds this campaign; no-op");
      return { result: "locked", attempted: 0 };
    }
    return await runLocked(db, deps, campaignId, { clock, log, budgetMs, batchSize, startedAt });
  } finally {
    if (locked) await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [`dispatch:${campaignId}`]).catch(() => undefined);
    client.release();
  }
}

type RunCtx = { clock: Clock; log: ReturnType<typeof getLogger>; budgetMs: number; batchSize: number; startedAt: number };

async function runLocked(db: Db, deps: DispatchDeps, campaignId: string, ctx: RunCtx): Promise<DispatchResult> {
  const { clock, log } = ctx;
  let c = await loadCampaign(db, campaignId);
  if (!c) return { result: "inactive", attempted: 0 };

  if (c.status === "cancelling") {
    const done = await db.transaction((tx) => finalizeCancel(tx, c!, "system", clock.now()));
    return done ? { result: "cancelled", attempted: 0 } : { result: "waiting", nextRunAt: new Date(clock.now().getTime() + 30_000), attempted: 0 };
  }
  if (c.status === "queued") {
    // Keep the fenced-start time of a scheduled campaign as "processing started" (M6).
    await transition(db, c, "sending", "system", "dispatcher started", { set: { processingStartedAt: c.processingStartedAt ?? clock.now() }, now: clock.now() });
    c = (await loadCampaign(db, campaignId))!;
  }
  if (c.status !== "sending") return { result: c.status === "paused" ? "paused" : c.status === "blocked" ? "blocked" : "inactive", attempted: 0 };

  const snap = (await db.select().from(campaignSnapshots).where(eq(campaignSnapshots.id, c.snapshotId!)).limit(1))[0];
  if (!snap) {
    await transition(db, c, "failed", "system", "approved snapshot missing", { now: clock.now() });
    return { result: "inactive", attempted: 0 };
  }

  const settings = await getSendSettings(db);
  const requireConsent = await getRequireConsent(db);
  const limiter = deps.limiter ?? sharedLimiter;
  let sesClient: SesClientLike | undefined = deps.sesClient;
  const transportFor = (to: string): MailTransport =>
    createTransport(
      {
        appEnv: deps.cfg.APP_ENV,
        sendMode: deps.cfg.SEND_MODE,
        purpose: campaignPurpose(deps.cfg.APP_ENV),
        recipients: [to],
        testRecipientAllowlist: deps.cfg.TEST_RECIPIENT_ALLOWLIST,
        authorizationRef: deps.cfg.SEND_AUTHORIZATION_REF,
        liveCampaignsEnabled: settings.liveCampaignsEnabled,
      },
      {
        mock: deps.mock ?? defaultMock,
        ses: deps.cfg.SES_FROM_ADDRESS
          ? { region: deps.cfg.SES_REGION, from: deps.cfg.SES_FROM_ADDRESS, configurationSet: deps.cfg.SES_CONFIGURATION_SET, timeoutMs: deps.cfg.SES_TIMEOUT_MS, client: (sesClient ??= makeSesClient(deps.cfg.SES_REGION)) }
          : null,
      },
    );

  let attempted = 0;
  let sinceQuotaCheck = Infinity; // forces a check before the first send
  let budget = Infinity;

  const block = async (code: string, message: string) => {
    const cur = (await loadCampaign(db, campaignId))!;
    const ok = await transition(db, cur, "blocked", "system", `${code}: ${message}`, { set: { blockCode: code, blockMessage: message.slice(0, 500) }, now: clock.now() });
    if (ok) {
      await createAlert(db, { kind: "blocked", campaignId, message: `Campaign “${cur.name}” is blocked (${code}): ${message.slice(0, 400)} Nothing more is sent until an administrator resumes it.` });
      await writeAudit(db, { actor: "system", action: "campaign.blocked", entityType: "campaign", entityId: campaignId, after: { code, message: message.slice(0, 500) } });
      log.warn({ block_code: code }, "campaign blocked");
    }
  };

  /** Return a claim to pending: known NOT sent (trigger requires a reason and a cleared claim). */
  const release = async (m: Claimed, reason: string, nextAt?: Date, extra: Partial<typeof messages.$inferInsert> = {}) => {
    await db
      .update(messages)
      .set({ sendStatus: "pending", claimedAt: null, claimedBy: null, releaseReason: reason, nextAttemptAt: nextAt ?? clock.now(), updatedAt: clock.now(), ...extra })
      .where(and(eq(messages.id, m.id), eq(messages.sendStatus, "claimed")));
  };

  while (Date.now() - ctx.startedAt < ctx.budgetMs) {
    const cur = (await loadCampaign(db, campaignId))!;
    if (cur.status === "cancelling") {
      const done = await db.transaction((tx) => finalizeCancel(tx, cur, "system", clock.now()));
      return done ? { result: "cancelled", attempted } : { result: "waiting", nextRunAt: new Date(clock.now().getTime() + 30_000), attempted };
    }
    if (cur.status !== "sending") return { result: cur.status === "paused" ? "paused" : cur.status === "blocked" ? "blocked" : "inactive", attempted };

    const now = clock.now();
    // Write-ahead claim, committed before any provider call.
    const claimed = (
      await db.execute(sql`
        update messages set send_status = 'claimed', claimed_by = ${deps.workerId}, claimed_at = ${now.toISOString()}::timestamptz,
               release_reason = null, updated_at = ${now.toISOString()}::timestamptz
        where id in (
          select id from messages
          where campaign_id = ${campaignId} and send_status = 'pending' and next_attempt_at <= ${now.toISOString()}::timestamptz
          order by next_attempt_at, id
          for update skip locked
          limit ${ctx.batchSize})
        returning id, recipient_id, email_normalized, tracking_token, attempt_no, throttle_count`)
    ).rows as Claimed[];

    if (!claimed.length) {
      const done = await maybeComplete(db, cur, clock.now());
      if (done) {
        log.info({ status: done }, "campaign finished");
        return { result: "completed", attempted };
      }
      const nxt = (
        await db.execute(sql`select min(next_attempt_at) filter (where send_status = 'pending') as at
                             from messages where campaign_id = ${campaignId} and send_status in ('pending', 'claimed')`)
      ).rows[0] as { at: string | null };
      // Pending work later (throttle backoff), or only claims held elsewhere: those finish, or the
      // reaper turns them into `unknown` after 10 minutes; check back in 30 s.
      return { result: "waiting", nextRunAt: nxt.at ? new Date(nxt.at) : new Date(clock.now().getTime() + 30_000), attempted };
    }

    for (let k = 0; k < claimed.length; k++) {
      const m = claimed[k];
      const rest = () => claimed.slice(k);
      // ---- pre-checks immediately before the send
      const status = (await loadCampaign(db, campaignId))!.status;
      if (status === "cancelling") {
        for (const r of rest()) await db.update(messages).set({ sendStatus: "cancelled", updatedAt: clock.now() }).where(and(eq(messages.id, r.id), eq(messages.sendStatus, "claimed")));
        break;
      }
      if (status !== "sending") {
        for (const r of rest()) await release(r, `campaign ${status}`);
        break;
      }
      const pre = await preSendCheck(db, m.email_normalized, requireConsent);
      const skip = pre.skip;
      // M7: open/click tracking only as the setting and the address's tracking consent allow (decided now, recorded on the message).
      const track = settings.trackingMode === "all" || (settings.trackingMode === "consented_only" && pre.trackingGranted);
      if (skip) {
        await db.update(messages).set({ sendStatus: "skipped", skipReason: skip, updatedAt: clock.now() }).where(and(eq(messages.id, m.id), eq(messages.sendStatus, "claimed")));
        continue;
      }
      const g = campaignGuard(deps.cfg, settings, [m.email_normalized]);
      if (!g.allowed) {
        for (const r of rest()) await release(r, "send_refused");
        await block("send_refused", `the sending guard refused: ${g.reason}`);
        return { result: "blocked", attempted };
      }
      let transport: MailTransport;
      try {
        transport = transportFor(m.email_normalized);
      } catch (e) {
        for (const r of rest()) await release(r, "transport_unavailable");
        await block("transport_unavailable", e instanceof TransportUnavailableError ? e.message : String(e));
        return { result: "blocked", attempted };
      }

      // ---- execution-time account check: at start and every 100 sends
      if (sinceQuotaCheck >= QUOTA_RECHECK_EVERY) {
        const acct: AccountCheck = transport.account ? await transport.account() : { ok: true, sendingEnabled: true, max24h: null, sentLast24h: 0, maxPerSecond: null };
        sinceQuotaCheck = 0;
        if (!acct.ok) {
          for (const r of rest()) await release(r, `account_${acct.code}`);
          await block(acct.code === "credentials" ? "credentials" : "account_check_failed", acct.message);
          return { result: "blocked", attempted };
        }
        if (!acct.sendingEnabled) {
          for (const r of rest()) await release(r, "account_paused");
          await block("account_paused", "Sending is disabled on the SES account (paused or under review).");
          return { result: "blocked", attempted };
        }
        budget = acct.max24h === null ? Infinity : Math.floor(acct.max24h * (1 - settings.quotaReservePct / 100)) - acct.sentLast24h;
        const cap = acct.maxPerSecond ? Math.max(0.1, acct.maxPerSecond * 0.8) : Infinity;
        limiter.setRate(Math.min(settings.ratePerSecond, cap));
      }
      if (budget <= 0) {
        for (const r of rest()) await release(r, "quota");
        await block("quota", `The daily sending quota is used up (a ${settings.quotaReservePct}% reserve is kept). SES quotas are a rolling 24-hour window: resume later.`);
        return { result: "blocked", attempted };
      }

      // ---- render from the frozen snapshot
      const rec = (await db.select().from(campaignRecipients).where(eq(campaignRecipients.id, m.recipient_id)).limit(1))[0];
      const msg = renderMessage(snap, rec.mergeValues as MergeValues, m.tracking_token, deps.cfg.trackingBaseUrl, { track });
      if (msg.problems.length) {
        await finish(db, m, { kind: "rejected", code: "render_error", message: msg.problems.join("; ") }, clock);
        continue;
      }

      await limiter.take();
      await db.update(messages).set({ sendStartedAt: clock.now(), trackingEnabled: track, updatedAt: clock.now() }).where(and(eq(messages.id, m.id), eq(messages.sendStatus, "claimed")));
      let result: SendResult;
      try {
        result = await transport.send({
          messageId: m.id,
          from: snap.fromAddress,
          to: m.email_normalized,
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
          headers: { ...unsubscribeHeaders(msg.unsubscribeUrl), "X-EMT-Purpose": "campaign" },
          tags: { purpose: "campaign", campaign: campaignId, attempt: String(m.attempt_no) },
        });
      } catch (e) {
        result = { kind: "unknown", message: e instanceof Error ? e.message : String(e) };
      }
      attempted++;
      sinceQuotaCheck++;

      if (result.kind === "accepted") {
        budget--;
        await finish(db, m, result, clock);
        if (rec.contactId) await db.update(contacts).set({ lastEmailedAt: clock.now() }).where(eq(contacts.id, rec.contactId));
      } else if (result.kind === "retryable") {
        const backoff = Math.min(MAX_THROTTLE_BACKOFF_MS, result.retryAfterMs ?? 1000 * 2 ** Math.min(m.throttle_count, 6));
        limiter.penalize(backoff);
        await release(m, `retryable: ${result.code}`, new Date(clock.now().getTime() + backoff), { throttleCount: m.throttle_count + 1, errorCode: result.code, lastError: result.message.slice(0, 300) });
        log.warn({ message_id: m.id, code: result.code, backoff_ms: backoff }, "provider did not accept (retryable); backing off");
      } else if (result.kind === "rejected" && BLOCKING_CODES.has(result.code)) {
        // Nothing was sent: the account or configuration is at fault, not this recipient.
        await release(m, `blocked: ${result.code}`, undefined, { errorCode: result.code, lastError: result.message.slice(0, 300) });
        for (const r of claimed.slice(k + 1)) await release(r, `blocked: ${result.code}`);
        await block(result.code, result.message);
        return { result: "blocked", attempted };
      } else {
        await finish(db, m, result, clock);
        if (result.kind === "unknown") log.warn({ message_id: m.id, to: maskEmail(m.email_normalized) }, "send outcome unknown; not retried automatically");
      }
    }
  }
  return { result: "continue", attempted };
}

const defaultMock = new MockTransport();

/** Configure the process-wide mock (worker): test-only log file and delay from config. */
export function makeRuntimeMock(cfg: Pick<AppConfig, "MOCK_TRANSPORT_LOG" | "MOCK_SEND_DELAY_MS">): MockTransport {
  return new MockTransport(undefined, { logFile: cfg.MOCK_TRANSPORT_LOG, delayMs: cfg.MOCK_SEND_DELAY_MS });
}

/** Immediately before a send: suppression and marketing consent (skip), and tracking consent (M7). */
async function preSendCheck(db: Db, email: string, requireConsent: boolean): Promise<{ skip: string | null; trackingGranted: boolean }> {
  const r = (
    await db.execute(sql`
      select exists(select 1 from suppressions where email_normalized = ${email}) as suppressed,
             coalesce((select status::text from consent_records where email_normalized = ${email} and purpose = 'marketing_email'
                       order by id desc limit 1), 'unknown') as consent,
             coalesce((select status::text from consent_records where email_normalized = ${email} and purpose = 'email_tracking'
                       order by id desc limit 1), 'unknown') as tracking`)
  ).rows[0] as { suppressed: boolean; consent: string; tracking: string };
  const trackingGranted = r.tracking === "granted";
  if (r.suppressed) return { skip: "suppressed", trackingGranted };
  if (r.consent === "withdrawn" || r.consent === "refused") return { skip: `consent_${r.consent}`, trackingGranted };
  if (r.consent === "unknown" && requireConsent) return { skip: "consent_missing", trackingGranted };
  return { skip: null, trackingGranted };
}

/** Fenced: only a row that is still `claimed` changes. */
async function finish(db: Db, m: Claimed, r: SendResult, clock: Clock) {
  const now = clock.now();
  const set: Partial<typeof messages.$inferInsert> =
    r.kind === "accepted"
      ? { sendStatus: "sent", providerMessageId: r.providerMessageId, sentAt: now, errorCode: null, lastError: null }
      : r.kind === "unknown"
        ? { sendStatus: "unknown", errorCode: "uncertain", lastError: r.message.slice(0, 300) }
        : { sendStatus: "failed_permanent", errorCode: r.code, lastError: r.message.slice(0, 300) };
  await db
    .update(messages)
    .set({ ...set, updatedAt: now })
    .where(and(eq(messages.id, m.id), eq(messages.sendStatus, "claimed")));
}

// ---------------------------------------------------------------- maintenance (worker cron)

/** Claims older than 10 minutes (crash or kill between claim and result) become `unknown`, never `pending`. */
export async function reapStaleMessageClaims(db: Db, clock: Clock = systemClock, olderThanMs = STALE_CLAIM_MS): Promise<number> {
  const cutoff = new Date(clock.now().getTime() - olderThanMs);
  const r = await db.execute(sql`
    update messages set send_status = 'unknown', error_code = 'stale_claim',
      last_error = 'The send was interrupted (worker stopped); the outcome is unknown. Not retried automatically.',
      updated_at = ${clock.now().toISOString()}::timestamptz
    where send_status = 'claimed' and claimed_at < ${cutoff.toISOString()}::timestamptz
    returning id`);
  return r.rows.length;
}

/** Campaigns that should have a dispatcher (queued, sending, cancelling). */
export async function campaignsNeedingDispatch(db: Db): Promise<string[]> {
  const r = await db.execute(sql`select id from campaigns where status in ('queued', 'sending', 'cancelling') order by updated_at`);
  return (r.rows as Array<{ id: string }>).map((x) => x.id);
}

export type { CampaignRow };
