/**
 * M4 test sends: one email to 1–3 staff-typed test addresses, rendered as one chosen recipient.
 *
 * Rules (CLAUDE.md "Sending rules" and "Invariants"; docs/PLAN.md M4):
 *  - Every address must be on TEST_RECIPIENT_ALLOWLIST (or be an SES simulator address), in EVERY
 *    send mode — even mock — and the list itself is never revealed in a refusal.
 *  - A suppressed address is refused even when it is allowlisted.
 *  - The sending guard still decides whether anything may leave the process (disabled → refused).
 *  - Merge problems (unknown field, syntax, missing value without fallback, no subject) refuse the send.
 *  - A row is committed as `claimed` BEFORE the provider is called. The same idempotency key and
 *    address never call the provider twice. An uncertain outcome is stored as `unknown` and is
 *    never retried automatically; a staff member may explicitly "send again" (a new row).
 *  - Test sends have no campaign id and are never part of campaign metrics.
 */
import { and, count, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { writeAudit } from "../audit";
import { systemClock, type Clock } from "../clock";
import type { AppConfig } from "../config";
import { checkEmail } from "../crm/contact-validation";
import type { Db } from "../db/client";
import { suppressions, templateVersions, testSends } from "../db/schema";
import { getLogger } from "../logger";
import { maskEmail } from "../redact";
import { renderForRecipient, renderSubject, renderText } from "../templates/merge";
import { findRecipient } from "../templates/recipients";
import { decideSend, isSimulatorAddress } from "./guard";
import type { SesClientLike } from "./ses-transport";
import { createTransport, MockTransport, TransportUnavailableError, type MailTransport, type SendResult } from "./transport";

export const MAX_TEST_RECIPIENTS = 3;
export const TEST_SUBJECT_PREFIX = "[TEST] ";
export const STALE_CLAIM_MS = 10 * 60 * 1000;

export type TestSendConfig = Pick<
  AppConfig,
  | "APP_ENV"
  | "SEND_MODE"
  | "TEST_RECIPIENT_ALLOWLIST"
  | "SEND_AUTHORIZATION_REF"
  | "SES_REGION"
  | "SES_FROM_ADDRESS"
  | "SES_CONFIGURATION_SET"
  | "SES_TIMEOUT_MS"
  | "TEST_SEND_MAX_PER_HOUR"
  | "TEST_SEND_MAX_PER_DAY"
>;

export type TestSendDeps = {
  cfg: TestSendConfig;
  /** In-process transport used when SEND_MODE=mock (tests may inject one with scripted outcomes). */
  mock?: MockTransport;
  /** SES client override (tests inject a fake; never used with mock). */
  sesClient?: SesClientLike;
  clock?: Clock;
};

export type TestSendInput = {
  templateId: string;
  versionId: string;
  /** Raw text typed by staff: addresses separated by commas, semicolons, spaces or new lines. */
  recipients: string;
  mergeSource: string;
  idempotencyKey: string;
  actor: string;
  correlationId?: string;
  resendOf?: string;
};

export type TestSendOutcome = {
  id: string;
  recipient: string; // masked
  status: "accepted" | "rejected" | "retryable" | "unknown" | "refused" | "claimed";
  message: string;
  providerMessageId?: string | null;
  duplicate?: boolean;
};

export class TestSendError extends Error {
  constructor(
    message: string,
    public readonly details: string[] = [],
  ) {
    super(message);
    this.name = "TestSendError";
  }
}

/** One shared in-process mock, so local mock sends are inspectable in the same process. */
export const sharedMockTransport = new MockTransport();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Split and validate staff-typed addresses (normalized, de-duplicated). */
export function parseTestRecipients(raw: string): { ok: string[]; invalid: string[] } {
  const parts = raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const ok: string[] = [];
  const invalid: string[] = [];
  for (const p of parts) {
    const c = checkEmail(p);
    if (c.status === "valid" && c.normalized) {
      if (!ok.includes(c.normalized)) ok.push(c.normalized);
    } else invalid.push(p);
  }
  return { ok, invalid };
}

export function isAllowedTestRecipient(cfg: Pick<TestSendConfig, "TEST_RECIPIENT_ALLOWLIST">, email: string): boolean {
  return cfg.TEST_RECIPIENT_ALLOWLIST.includes(email) || isSimulatorAddress(email);
}

/** Can a test send be attempted at all in this environment? (Used to enable the button.) */
export function testSendAvailability(cfg: TestSendConfig): { available: boolean; reason: string } {
  const probe = cfg.TEST_RECIPIENT_ALLOWLIST[0] ?? "success@simulator.amazonses.com";
  const d = decideSend({
    appEnv: cfg.APP_ENV,
    sendMode: cfg.SEND_MODE,
    purpose: "test_send",
    recipients: [probe],
    testRecipientAllowlist: cfg.TEST_RECIPIENT_ALLOWLIST,
    authorizationRef: cfg.SEND_AUTHORIZATION_REF,
    liveCampaignsEnabled: false,
  });
  if (!d.allowed) return { available: false, reason: d.reason };
  if (d.transport === "real" && !cfg.SES_FROM_ADDRESS) return { available: false, reason: "SES_FROM_ADDRESS is not set" };
  if (cfg.TEST_RECIPIENT_ALLOWLIST.length === 0 && cfg.SEND_MODE !== "simulator") {
    return { available: false, reason: "TEST_RECIPIENT_ALLOWLIST is empty" };
  }
  return { available: true, reason: d.transport === "mock" ? "mock transport: nothing leaves this machine" : `real SES send (SEND_MODE=${cfg.SEND_MODE})` };
}

const STATUS_TEXT: Record<SendResult["kind"], string> = {
  accepted: "SES accepted the message (not proof that it reached the inbox).",
  rejected: "The provider refused the message.",
  retryable: "The provider did not accept the message (e.g. throttling). It was NOT retried automatically.",
  unknown: "Outcome uncertain: the message may or may not have been sent. It was NOT retried automatically.",
};

export async function sendTestEmail(db: Db, deps: TestSendDeps, i: TestSendInput): Promise<TestSendOutcome[]> {
  const { cfg } = deps;
  const clock = deps.clock ?? systemClock;
  const log = getLogger().child({ request_id: i.correlationId, task: "test_send" });

  if (!UUID.test(i.idempotencyKey)) throw new TestSendError("Invalid form token; reload the page and try again.");
  const { ok: recipients, invalid } = parseTestRecipients(i.recipients);
  if (invalid.length) throw new TestSendError(`Not a valid email address: ${invalid.map((x) => x.slice(0, 80)).join(", ")}`);
  if (recipients.length === 0) throw new TestSendError("Enter at least one test address.");
  if (recipients.length > MAX_TEST_RECIPIENTS) throw new TestSendError(`At most ${MAX_TEST_RECIPIENTS} test addresses per send.`);

  const v = (await db.select().from(templateVersions).where(and(eq(templateVersions.id, i.versionId), eq(templateVersions.templateId, i.templateId))).limit(1))[0];
  if (!v) throw new TestSendError("Email version not found.");
  if (!v.subject?.trim()) throw new TestSendError("Add a subject to this email before sending a test.");

  const who = await findRecipient(db, i.mergeSource);
  if (!who) throw new TestSendError("Choose whose data fills the merge fields.");

  // ---- Render and block on any unresolved personalization (M4: unresolved fields block).
  const subj = renderSubject(v.subject, who.data);
  const body = renderForRecipient(v.html, who.data);
  const text = renderText(v.plainText, who.data);
  const problems = [
    ...subj.errors.map((e) => `subject: ${e.raw} — ${e.error}`),
    ...body.errors.map((e) => `body: ${e.raw} — ${e.error}`),
    ...text.errors.map((e) => `plain text: ${e.raw} — ${e.error}`),
    ...[...new Set([...subj.missingWithoutFallback, ...body.missingWithoutFallback])].map((f) => `${f}: no value for ${who.label} and no default`),
  ];
  if (problems.length) throw new TestSendError("Personalization problems must be fixed before a test send.", problems);

  // ---- Rate limits (attempts that reached the provider stage count; refusals do not).
  const now = clock.now();
  const hourAgo = new Date(now.getTime() - 3600_000);
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const [mine] = await db.select({ n: count() }).from(testSends).where(and(eq(testSends.requestedBy, i.actor), gte(testSends.createdAt, hourAgo), ne(testSends.status, "refused")));
  const [all] = await db.select({ n: count() }).from(testSends).where(and(gte(testSends.createdAt, dayAgo), ne(testSends.status, "refused")));
  if (mine.n + recipients.length > cfg.TEST_SEND_MAX_PER_HOUR) throw new TestSendError(`Rate limit: at most ${cfg.TEST_SEND_MAX_PER_HOUR} test emails per person per hour.`);
  if (all.n + recipients.length > cfg.TEST_SEND_MAX_PER_DAY) throw new TestSendError(`Rate limit: at most ${cfg.TEST_SEND_MAX_PER_DAY} test emails per day for the whole app.`);

  const suppressed = new Set(
    (await db.select({ e: suppressions.emailNormalized }).from(suppressions).where(inArray(suppressions.emailNormalized, recipients))).map((r) => r.e),
  );

  const subject = TEST_SUBJECT_PREFIX + subj.subject;
  const out: TestSendOutcome[] = [];

  for (const to of recipients) {
    const base = {
      idempotencyKey: i.idempotencyKey,
      templateId: i.templateId,
      templateVersionId: v.id,
      requestedBy: i.actor,
      recipientEmail: to,
      mergeSource: i.mergeSource,
      renderedSubject: subject,
      sendMode: cfg.SEND_MODE,
      authorizationRef: cfg.SEND_AUTHORIZATION_REF ?? null,
      requestId: i.correlationId ?? null,
      resendOf: i.resendOf ?? null,
    };

    // Our own refusals (no provider call). Messages never reveal the allowlist.
    let refusal: string | null = null;
    if (!isAllowedTestRecipient(cfg, to)) refusal = "This address is not on the list of permitted test recipients.";
    else if (suppressed.has(to)) refusal = "This address is suppressed (unsubscribed, bounced or complained) and cannot receive email.";
    else {
      const d = decideSend({
        appEnv: cfg.APP_ENV,
        sendMode: cfg.SEND_MODE,
        purpose: "test_send",
        recipients: [to],
        testRecipientAllowlist: cfg.TEST_RECIPIENT_ALLOWLIST,
        authorizationRef: cfg.SEND_AUTHORIZATION_REF,
        liveCampaignsEnabled: false,
      });
      if (!d.allowed) refusal = `Sending refused: ${d.reason}.`;
    }

    if (refusal) {
      const [row] = await db
        .insert(testSends)
        .values({ ...base, status: "refused", errorMessage: refusal, completedAt: now })
        .onConflictDoNothing({ target: [testSends.idempotencyKey, testSends.recipientEmail] })
        .returning();
      const id = row?.id ?? (await existingId(db, i.idempotencyKey, to));
      await audit(db, i, to, "refused", { reason: refusal, id });
      out.push({ id, recipient: maskEmail(to), status: "refused", message: refusal, duplicate: !row });
      continue;
    }

    // Write-ahead claim. A double submit (same key + address) finds the existing row and stops here.
    const [claimed] = await db
      .insert(testSends)
      .values({ ...base, status: "claimed", claimedAt: now })
      .onConflictDoNothing({ target: [testSends.idempotencyKey, testSends.recipientEmail] })
      .returning();
    if (!claimed) {
      const prev = (await db.select().from(testSends).where(and(eq(testSends.idempotencyKey, i.idempotencyKey), eq(testSends.recipientEmail, to))).limit(1))[0];
      out.push({ id: prev.id, recipient: maskEmail(to), status: prev.status, message: "Already submitted; not sent again.", providerMessageId: prev.providerMessageId, duplicate: true });
      continue;
    }

    let transport: MailTransport;
    try {
      transport = createTransport(
        {
          appEnv: cfg.APP_ENV,
          sendMode: cfg.SEND_MODE,
          purpose: "test_send",
          recipients: [to],
          testRecipientAllowlist: cfg.TEST_RECIPIENT_ALLOWLIST,
          authorizationRef: cfg.SEND_AUTHORIZATION_REF,
          liveCampaignsEnabled: false,
        },
        {
          mock: deps.mock ?? sharedMockTransport,
          ses: cfg.SES_FROM_ADDRESS
            ? { region: cfg.SES_REGION, from: cfg.SES_FROM_ADDRESS, configurationSet: cfg.SES_CONFIGURATION_SET, timeoutMs: cfg.SES_TIMEOUT_MS, client: deps.sesClient }
            : null,
        },
      );
    } catch (e) {
      // Nothing was sent: the transport could not be built. Record it as rejected (not retried).
      const msg = e instanceof TransportUnavailableError ? e.message : String(e);
      await finish(db, claimed.id, { kind: "rejected", code: "transport_unavailable", message: msg }, transportName(null), clock);
      await audit(db, i, to, "rejected", { id: claimed.id, reason: msg });
      out.push({ id: claimed.id, recipient: maskEmail(to), status: "rejected", message: msg });
      continue;
    }

    let result: SendResult;
    try {
      result = await transport.send({
        messageId: claimed.id,
        from: cfg.SES_FROM_ADDRESS ?? "test-sender@example.com",
        to,
        subject,
        html: body.html,
        text: text.text,
        headers: { "X-EMT-Purpose": "test-send" },
        tags: { purpose: "test_send", template: i.templateId },
      });
    } catch (e) {
      // An unexpected throw after the call started: we cannot know whether it was sent.
      result = { kind: "unknown", message: e instanceof Error ? e.message : String(e) };
    }
    await finish(db, claimed.id, result, transport.name, clock);
    await audit(db, i, to, result.kind, { id: claimed.id, transport: transport.name, code: "code" in result ? result.code : undefined });
    log.info({ test_send_id: claimed.id, status: result.kind, transport: transport.name, to: maskEmail(to) }, "test send attempted");
    out.push({
      id: claimed.id,
      recipient: maskEmail(to),
      status: result.kind,
      message: result.kind === "accepted" ? STATUS_TEXT.accepted : `${STATUS_TEXT[result.kind]} ${"message" in result ? redactMsg(result.message) : ""}`.trim(),
      providerMessageId: result.kind === "accepted" ? result.providerMessageId : null,
    });
  }
  return out;
}

const transportName = (n: string | null) => n ?? "none";
const redactMsg = (m: string) => maskEmailsIn(m).slice(0, 300);
const maskEmailsIn = (m: string) => m.replace(/[^\s<>"'(),;:]+@[^\s<>"'(),;:]+/g, (x) => maskEmail(x));

async function existingId(db: Db, key: string, to: string): Promise<string> {
  return (await db.select({ id: testSends.id }).from(testSends).where(and(eq(testSends.idempotencyKey, key), eq(testSends.recipientEmail, to))).limit(1))[0].id;
}

/** Fenced update: only a row that is still `claimed` changes (the DB trigger enforces the rest). */
async function finish(db: Db, id: string, r: SendResult, transport: string, clock: Clock) {
  await db
    .update(testSends)
    .set({
      status: r.kind,
      transport,
      providerMessageId: r.kind === "accepted" ? r.providerMessageId : null,
      errorCode: r.kind === "rejected" || r.kind === "retryable" ? r.code : r.kind === "unknown" ? "uncertain" : null,
      errorMessage: r.kind === "accepted" ? null : redactMsg(r.message),
      completedAt: clock.now(),
    })
    .where(and(eq(testSends.id, id), eq(testSends.status, "claimed")));
}

async function audit(db: Db, i: TestSendInput, to: string, status: string, extra: Record<string, unknown>) {
  await writeAudit(db, {
    actor: i.actor,
    action: `test_send.${status}`,
    entityType: "template",
    entityId: i.templateId,
    after: { recipient: maskEmail(to), versionId: i.versionId, mergeSource: i.mergeSource, resendOf: i.resendOf ?? null, ...extra },
    correlationId: i.correlationId,
  });
}

/**
 * Reaper: a claim that never finished (crash or kill between claim and result) becomes `unknown`.
 * It is never moved back to a sendable state and never retried automatically.
 */
export async function reapStaleTestSends(db: Db, clock: Clock = systemClock, olderThanMs = STALE_CLAIM_MS): Promise<number> {
  const cutoff = new Date(clock.now().getTime() - olderThanMs);
  const r = await db
    .update(testSends)
    .set({ status: "unknown", errorCode: "stale_claim", errorMessage: "The send was interrupted; the outcome is unknown. Not retried automatically.", completedAt: clock.now() })
    .where(and(eq(testSends.status, "claimed"), sql`${testSends.claimedAt} < ${cutoff}`))
    .returning({ id: testSends.id });
  return r.length;
}

export async function listTestSends(db: Db, templateId: string, limit = 20) {
  return db
    .select()
    .from(testSends)
    .where(eq(testSends.templateId, templateId))
    .orderBy(sql`${testSends.createdAt} desc`)
    .limit(limit);
}
