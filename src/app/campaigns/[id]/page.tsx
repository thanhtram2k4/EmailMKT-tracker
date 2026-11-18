import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarClock, CircleCheck, CirclePause, CirclePlay, CircleX, History, ListChecks, Send, ShieldAlert, Users } from "lucide-react";
import { requireStaff } from "../../../lib/auth/session";
import { getConfig } from "../../../lib/config";
import { getDb } from "../../../lib/db/client";
import { REASON_LABELS, type IneligibleReason } from "../../../lib/crm/eligibility";
import { allTags } from "../../../lib/crm/queries";
import { describeAudience, parseAudience } from "../../../lib/campaigns/audience";
import { campaignDetail, versionsOf, type RecipientFilter } from "../../../lib/campaigns/queries";
import { reviewCampaign } from "../../../lib/campaigns/service";
import { renderSubject } from "../../../lib/templates/merge";
import { formatInZone, formatUtc } from "../../../lib/campaigns/schedule-time";
import { getSendSettings } from "../../../lib/campaigns/settings";
import { cancelAction, pauseAction, resolveUncertainAction, resumeAction, sendNowAction, sendOverdueNowAction, unscheduleAction, updateCampaignAction } from "../../campaign-actions";
import { AppShell } from "../../app-shell";
import { Alert, EmptyState, Flash, Kpi, PageHeader, Pill, fmtTime } from "../../ui";
import { AudienceFields } from "../audience-fields";
import { StatusPill } from "../status-pill";
import { AutoRefresh } from "./auto-refresh";
import { ScheduleTimeForm, SchedulePreview, type SchedParams } from "./schedule-ui";
import { AnalyticsSection } from "./analytics-section";
import { summaryStatus } from "../../../lib/crm/campaign-summaries";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILTERS: Array<[RecipientFilter, string]> = [
  ["all", "All"],
  ["sent", "Sent"],
  ["pending", "Waiting"],
  ["unknown", "Uncertain"],
  ["skipped", "Skipped"],
  ["failed_permanent", "Failed"],
  ["cancelled", "Cancelled"],
  ["delivered", "Delivered"],
  ["bounced", "Bounced"],
  ["complained", "Complaints"],
];
const reasonLabel = (r: string) => (r in REASON_LABELS ? REASON_LABELS[r as IneligibleReason] : r === "duplicate_address" ? "Same address twice in the audience" : r);

export default async function CampaignPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string; show?: string; activity?: string } & SchedParams> }) {
  const staff = await requireStaff();
  const { id } = await params;
  const sp = await searchParams;
  if (!UUID.test(id)) notFound();
  const db = getDb();
  const cfg = getConfig();
  const filter = (FILTERS.find(([k]) => k === sp.show)?.[0] ?? "all") as RecipientFilter;
  const d = await campaignDetail(db, id, { filter });
  if (!d) notFound();
  const c = d.campaign;
  const isAdmin = staff.role === "admin";
  const isDraft = c.status === "draft";
  const settings = await getSendSettings(db);
  const notionSummary = await summaryStatus(db, id);

  return (
    <AppShell staff={staff} wide>
      <PageHeader
        back={{ href: "/campaigns", label: "Campaigns" }}
        title={c.name}
        titleTestId="campaign-title"
        sub={
          <>
            <StatusPill status={c.status} testId="campaign-status" /> · Email <strong>{d.templateName}</strong> · {describeAudience(parseAudience(c.audience))} · revision {c.scheduleRevision}
          </>
        }
      />
      <Flash ok={sp.ok} error={sp.error} />
      {isDraft ? <DraftView id={id} isAdmin={isAdmin} sendMode={cfg.SEND_MODE} sp={sp} /> : <SendingView
          d={d}
          isAdmin={isAdmin}
          filter={filter}
          sp={sp}
          ratePerSecond={settings.ratePerSecond}
          activity={sp.activity === "recorded" ? "recorded" : "filtered"}
          notionSummary={notionSummary}
        />}
    </AppShell>
  );
}

async function DraftView({ id, isAdmin, sendMode, sp }: { id: string; isAdmin: boolean; sendMode: string; sp: SchedParams }) {
  const db = getDb();
  const r = await reviewCampaign(db, getConfig(), id);
  const [versions, tags] = await Promise.all([versionsOf(db, r.campaign.templateId), allTags(db)]);
  const first = r.resolved.included[0];
  const sample = r.version.subject && first ? renderSubject(r.version.subject, { full_name: first.fullName, greeting_name: first.greetingName, company: first.company, email: first.emailNormalized }) : null;
  const n = r.resolved.included.length;

  return (
    <>
      <section className="card" data-testid="campaign-review">
        <h2>
          <ListChecks className="icon" aria-hidden /> Review
        </h2>
        <div className="kpis">
          <Kpi label="Matched by the audience" value={r.resolved.matched} icon={<Users className="icon-sm" aria-hidden />} />
          <Kpi label="Will receive" value={<span data-testid="review-included">{n}</span>} icon={<Send className="icon-sm" aria-hidden />} />
          <Kpi label="Excluded" value={<span data-testid="review-excluded">{r.resolved.excludedTotal}</span>} icon={<ShieldAlert className="icon-sm" aria-hidden />} />
        </div>
        {Object.keys(r.resolved.excludedByReason).length > 0 && (
          <ul className="plain small review-exclusions" data-testid="review-exclusions">
            {Object.entries(r.resolved.excludedByReason).map(([k, v]) => (
              <li key={k}>
                <strong className="num">{v}</strong> — {reasonLabel(k)}
              </li>
            ))}
          </ul>
        )}
        <dl className="kv">
          <dt>Email version</dt>
          <dd>
            v{r.version.versionNo} · <Link href={`/templates/${r.campaign.templateId}?v=${r.version.id}`}>open in editor</Link>
          </dd>
          <dt>From</dt>
          <dd>{r.fromAddress ? <code>{r.fromAddress}</code> : <Pill tone="warn">not set</Pill>}</dd>
          <dt>Subject</dt>
          <dd>{r.version.subject ? <code>{r.version.subject}</code> : <Pill tone="bad">missing</Pill>}</dd>
          {sample && (
            <>
              <dt>Subject for {first.fullName ?? "first recipient"}</dt>
              <dd data-testid="review-sample-subject">{sample.subject}</dd>
            </>
          )}
          <dt>Sending</dt>
          <dd>
            {r.guard.allowed ? <Pill tone={r.guard.transport === "mock" ? "info" : "warn"}>{r.guard.transport === "mock" ? "mock (nothing leaves this machine)" : "real SES"}</Pill> : <Pill tone="bad">refused</Pill>}{" "}
            <span className="muted small">SEND_MODE={sendMode} · {r.settings.ratePerSecond}/s</span>
          </dd>
        </dl>
        {r.blocking.length > 0 && (
          <Alert tone="bad" title="Cannot be sent yet:" testId="review-blocking">
            <ul className="plain">
              {r.blocking.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </Alert>
        )}
        {r.warnings.length > 0 && (
          <Alert tone="warn" testId="review-warnings">
            <ul className="plain">
              {r.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Alert>
        )}
        {r.missingValues.length > 0 && (
          <div className="table-wrap" tabIndex={0}>
            <table data-testid="review-missing">
              <thead>
                <tr>
                  <th>Recipient</th>
                  <th>Missing value (no fallback)</th>
                </tr>
              </thead>
              <tbody>
                {r.missingValues.slice(0, 50).map((m) => (
                  <tr key={m.contactId}>
                    <td>
                      <Link href={`/contacts/${m.contactId}`}>{m.name}</Link>
                    </td>
                    <td>{m.missing.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" data-testid="send-now-card">
        <h2>
          <Send className="icon" aria-hidden /> Send now
        </h2>
        {isAdmin ? (
          <form action={sendNowAction} className="stack">
            <input type="hidden" name="campaignId" value={id} />
            <input type="hidden" name="expectedRevision" value={r.campaign.scheduleRevision} />
            <input type="hidden" name="expectedRecipients" value={n} />
            <p className="small m0">
              Approving freezes this exact content and recipient list (later edits in Notion or the editor do not change it). Suppression and consent are checked again immediately before each message.
            </p>
            <label className="check">
              <input type="checkbox" name="confirm" value="yes" required disabled={r.blocking.length > 0} data-testid="send-now-confirm" />
              <span>
                I have reviewed this campaign. Send it now to <strong>{n}</strong> recipient(s).
              </span>
            </label>
            <div className="row">
              <button className="btn primary" type="submit" disabled={r.blocking.length > 0} data-testid="send-now">
                <Send className="icon-sm" aria-hidden /> Send now
              </button>
            </div>
          </form>
        ) : (
          <Alert tone="info">An administrator reviews and sends campaigns. You can still edit this draft.</Alert>
        )}
      </section>

      {isAdmin && (
        <section className="card" id="schedule" data-testid="schedule-card">
          <h2>
            <CalendarClock className="icon" aria-hidden /> Schedule for later
          </h2>
          {r.blocking.length > 0 ? (
            <p className="muted small m0">Fix the problems listed in the review first.</p>
          ) : (
            <div className="stack">
              <ScheduleTimeForm id={id} sp={sp} mode="schedule" />
              <SchedulePreview id={id} sp={sp} mode="schedule" recipients={n} revision={r.campaign.scheduleRevision} fromAddress={r.fromAddress} subject={r.version.subject} ratePerSecond={r.settings.ratePerSecond} />
            </div>
          )}
        </section>
      )}

      <section className="card" data-testid="campaign-edit">
        <h2>Edit draft</h2>
        <form action={updateCampaignAction} className="stack">
          <input type="hidden" name="campaignId" value={id} />
          <div className="grid2">
            <label>
              Name
              <input name="name" defaultValue={r.campaign.name} required maxLength={200} />
            </label>
            <label>
              Email version
              <select name="versionId" defaultValue={r.version.id} data-testid="campaign-version">
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.versionNo}
                    {v.subject ? ` — ${v.subject.slice(0, 60)}` : " — no subject"}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <AudienceFields tags={tags} value={r.audience} />
          <div className="row">
            <button className="btn" type="submit" data-testid="campaign-save">
              Save draft
            </button>
            <span className="muted small">Saving starts a new revision; review again before sending.</span>
          </div>
        </form>
        {isAdmin && (
          <form action={cancelAction} className="row mt3">
            <input type="hidden" name="campaignId" value={id} />
            <input type="hidden" name="confirm" value="yes" />
            <button className="btn small-btn" type="submit" data-testid="campaign-discard">
              <CircleX className="icon-sm" aria-hidden /> Cancel this draft
            </button>
          </form>
        )}
      </section>
    </>
  );
}

function SendingView({
  d,
  isAdmin,
  filter,
  sp,
  ratePerSecond,
  activity,
  notionSummary,
}: {
  d: NonNullable<Awaited<ReturnType<typeof campaignDetail>>>;
  isAdmin: boolean;
  filter: RecipientFilter;
  sp: SchedParams;
  ratePerSecond: number;
  activity: "filtered" | "recorded";
  notionSummary: Awaited<ReturnType<typeof summaryStatus>>;
}) {
  const c = d.campaign;
  const m = d.counts;
  const active = ["queued", "sending", "cancelling"].includes(c.status);
  const canCancel = ["scheduled", "held_overdue", "queued", "sending", "paused", "blocked"].includes(c.status);
  const scheduledOrHeld = c.status === "scheduled" || c.status === "held_overdue";
  const snap = d.snapshot;

  return (
    <>
      {active && <AutoRefresh />}
      {c.scheduledAtUtc && (
        <section className="card" id="schedule" data-testid="schedule-status">
          <h2>
            <CalendarClock className="icon" aria-hidden /> Schedule
          </h2>
          {c.status === "held_overdue" && (
            <Alert tone="bad" title="Held: not sent." testId="campaign-held">
              {c.holdReason}
            </Alert>
          )}
          <dl className="kv">
            <dt>Scheduled for</dt>
            <dd data-testid="schedule-when">
              <strong>{formatInZone(c.scheduledAtUtc, c.scheduleTz ?? "UTC")}</strong> = {formatUtc(c.scheduledAtUtc)}
            </dd>
            <dt>Revision</dt>
            <dd data-testid="schedule-revision">{c.scheduleRevision}</dd>
            <dt>Scheduled by</dt>
            <dd>
              <code>{c.scheduledBy ?? "—"}</code>
            </dd>
            <dt>Actual start</dt>
            <dd data-testid="schedule-actual">
              {c.processingStartedAt ? (
                <>
                  {formatInZone(c.processingStartedAt, c.scheduleTz ?? "UTC")} {c.startDelayMs !== null && <span className="muted">({Math.round(c.startDelayMs / 1000)} s after the scheduled time)</span>}
                </>
              ) : (
                <span className="muted">not started</span>
              )}
            </dd>
          </dl>
          {isAdmin && scheduledOrHeld && (
            <div className="stack mt3">
              {c.status === "held_overdue" && (
                <form action={sendOverdueNowAction} className="row">
                  <input type="hidden" name="campaignId" value={c.id} />
                  <label className="check">
                    <input type="checkbox" name="confirm" value="yes" required data-testid="overdue-confirm" />
                    <span>Send it now, later than planned.</span>
                  </label>
                  <button className="btn primary" type="submit" data-testid="overdue-send-now">
                    <Send className="icon-sm" aria-hidden /> Send now
                  </button>
                </form>
              )}
              <p className="small m0">Reschedule (the old time is cancelled; the revision increases):</p>
              <ScheduleTimeForm id={c.id} sp={sp} mode="reschedule" />
              <SchedulePreview id={c.id} sp={sp} mode="reschedule" recipients={m.total} revision={c.scheduleRevision} fromAddress={snap?.fromAddress ?? null} subject={snap?.subjectTemplate ?? null} ratePerSecond={ratePerSecond} />
              <form action={unscheduleAction} className="row">
                <input type="hidden" name="campaignId" value={c.id} />
                <button className="btn" type="submit" data-testid="campaign-unschedule">
                  Unschedule and edit
                </button>
                <span className="muted small">Returns the campaign to draft; it must be reviewed and confirmed again.</span>
              </form>
            </div>
          )}
        </section>
      )}
      {c.status === "blocked" && (
        <Alert tone="bad" title={`Blocked: ${c.blockCode}.`} testId="campaign-blocked">
          {c.blockMessage} Nothing is sent while blocked. Fix the cause, then an administrator resumes the campaign.
        </Alert>
      )}
      {c.status === "completed_with_issues" && (
        <Alert tone="warn" testId="campaign-issues">
          Finished with issues: some messages were uncertain, failed, bounced or complained. This campaign is not a clean success; see the counts and the recipients below.
        </Alert>
      )}

      <section className="card" data-testid="campaign-progress">
        <h2>Progress</h2>
        <div className="kpis">
          <Kpi label="Recipients" value={m.total} testId="kpi-total" />
          <Kpi label="Sent (SES accepted)" value={m.sent} testId="kpi-sent" />
          <Kpi label="Delivered" value={m.delivered} note="recipient server accepted" testId="kpi-delivered" />
          <Kpi label="Bounced" value={m.bounced_hard + m.bounced_soft} note={`${m.bounced_hard} hard · ${m.bounced_soft} soft`} testId="kpi-bounced" />
          <Kpi label="Complaints" value={m.complained} testId="kpi-complaints" />
          <Kpi label="Skipped" value={m.skipped} note="suppressed or no consent at send time" testId="kpi-skipped" />
          <Kpi label="Uncertain" value={m.unknown} note="never retried automatically" testId="kpi-unknown" />
          <Kpi label="Failed" value={m.failed_permanent} testId="kpi-failed" />
          <Kpi label="Waiting" value={m.pending + m.claimed} testId="kpi-waiting" />
          <Kpi label="Cancelled" value={m.cancelled + m.marked_not_sent} testId="kpi-cancelled" />
        </div>
        <p className="muted small m0">
          “Sent” means SES accepted the message. “Delivered” means the recipient’s mail server accepted it, not that it reached the inbox. Delivery, bounce and complaint counts arrive as SES events, which need the deployed HTTPS endpoint.
        </p>
        <div className="row mt3" data-testid="campaign-controls">
          {(c.status === "sending" || c.status === "queued") && (
            <form action={pauseAction}>
              <input type="hidden" name="campaignId" value={c.id} />
              <button className="btn" type="submit" data-testid="campaign-pause">
                <CirclePause className="icon-sm" aria-hidden /> Pause
              </button>
            </form>
          )}
          {isAdmin && (c.status === "paused" || c.status === "blocked") && (
            <form action={resumeAction}>
              <input type="hidden" name="campaignId" value={c.id} />
              <button className="btn primary" type="submit" data-testid="campaign-resume">
                <CirclePlay className="icon-sm" aria-hidden /> Resume
              </button>
            </form>
          )}
          {isAdmin && canCancel && (
            <form action={cancelAction} className="row">
              <input type="hidden" name="campaignId" value={c.id} />
              <label className="check">
                <input type="checkbox" name="confirm" value="yes" required data-testid="campaign-cancel-confirm" /> Stop sending the rest
              </label>
              <button className="btn" type="submit" data-testid="campaign-cancel">
                <CircleX className="icon-sm" aria-hidden /> Cancel campaign
              </button>
            </form>
          )}
        </div>
      </section>

      {m.sent + m.unknown + m.marked_not_sent > 0 && <AnalyticsSection campaignId={c.id} activity={activity} />}

      {m.unknown > 0 && (
        <section className="card" data-testid="uncertain-card">
          <h2>Uncertain sends ({m.unknown})</h2>
          <p className="small">
            For these messages the outcome is unknown (for example the provider did not answer in time, or the worker stopped). They may or may not have been sent, so they are <strong>never retried automatically</strong>. SES events
            resolve them when they arrive. After 60 minutes an administrator may decide.
          </p>
          {isAdmin && d.uncertainReady > 0 ? (
            <div className="stack">
              <form action={resolveUncertainAction} className="row">
                <input type="hidden" name="campaignId" value={c.id} />
                <input type="hidden" name="action" value="resend" />
                <label className="check">
                  <input type="checkbox" name="ackDuplicateRisk" value="yes" required data-testid="uncertain-ack" /> I accept that some recipients may get the email twice.
                </label>
                <button className="btn" type="submit" data-testid="uncertain-resend">
                  Resend {d.uncertainReady} uncertain
                </button>
              </form>
              <form action={resolveUncertainAction}>
                <input type="hidden" name="campaignId" value={c.id} />
                <input type="hidden" name="action" value="mark_not_sent" />
                <button className="btn" type="submit" data-testid="uncertain-mark">
                  Mark {d.uncertainReady} as not sent
                </button>
              </form>
            </div>
          ) : (
            <p className="muted small m0">{isAdmin ? "None is ready yet (60-minute wait)." : "An administrator decides after 60 minutes."}</p>
          )}
        </section>
      )}

      {snap && (
        <section className="card" data-testid="snapshot-card">
          <h2>
            <CircleCheck className="icon" aria-hidden /> Approved snapshot
          </h2>
          <dl className="kv">
            <dt>Approved</dt>
            <dd>
              {fmtTime(snap.approvedAt)} by <code>{snap.approvedBy}</code>
            </dd>
            <dt>Subject</dt>
            <dd>
              <code>{snap.subjectTemplate}</code>
            </dd>
            <dt>From</dt>
            <dd>
              <code>{snap.fromAddress}</code>
            </dd>
            <dt>Content hash</dt>
            <dd>
              <code>{snap.contentHash.slice(0, 16)}…</code>
            </dd>
            <dt>Started / finished</dt>
            <dd>
              {fmtTime(c.processingStartedAt)} / {fmtTime(c.finishedAt)}
            </dd>
            <dt>Notion summary</dt>
            <dd data-testid="notion-summary">
              {notionSummary?.lastWrittenAt ? (
                <>
                  written ({notionSummary.stagesDone.join(", ")}) · {fmtTime(notionSummary.lastWrittenAt)}
                </>
              ) : (
                <span className="muted">not written yet</span>
              )}
              {notionSummary?.lastError && <span className="muted small"> · last error: {notionSummary.lastError}</span>}
            </dd>
          </dl>
        </section>
      )}

      <section className="card" data-testid="recipients-card">
        <h2>Recipients</h2>
        <nav className="row small" aria-label="Filter recipients">
          {FILTERS.map(([k, label]) => (
            <Link key={k} href={`/campaigns/${c.id}?show=${k}`} aria-current={filter === k ? "page" : undefined} className={filter === k ? "pill info" : "pill"}>
              {label}
            </Link>
          ))}
        </nav>
        {d.recipients.length === 0 ? (
          <EmptyState>No recipients in this view.</EmptyState>
        ) : (
          <div className="table-wrap" tabIndex={0}>
            <table data-testid="recipients-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Send</th>
                  <th>Delivery</th>
                  <th>Sent at</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {d.recipients.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/campaigns/${c.id}/messages/${r.id}`} data-testid="open-timeline">
                        {r.full_name ?? r.email_normalized}
                      </Link>
                    </td>
                    <td>{r.email_normalized}</td>
                    <td>
                      <Pill tone={r.send_status === "sent" ? "ok" : r.send_status === "unknown" || r.send_status === "failed_permanent" ? "bad" : r.send_status === "skipped" ? "warn" : undefined}>{r.send_status.replace(/_/g, " ")}</Pill>
                      {r.attempt_no > 1 && <span className="muted small"> attempt {r.attempt_no}</span>}
                    </td>
                    <td>{r.delivery_status === "none" ? <span className="muted">—</span> : <Pill tone={r.delivery_status === "delivered" ? "ok" : r.delivery_status === "delayed" ? "warn" : "bad"}>{r.delivery_status.replace(/_/g, " ")}</Pill>}</td>
                    <td className="muted">{fmtTime(r.sent_at)}</td>
                    <td className="muted small">{r.skip_reason ?? r.error_code ?? r.resolution ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {d.recipients.length === 200 && <p className="muted small">Showing the first 200.</p>}
      </section>

      <section className="card table-wrap" tabIndex={0}>
        <h2>
          <History className="icon" aria-hidden /> History
        </h2>
        <table data-testid="transitions-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Change</th>
              <th>By</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {d.transitions.map((t) => (
              <tr key={t.id}>
                <td className="muted">{fmtTime(t.at)}</td>
                <td>
                  {t.fromStatus ?? "—"} → <strong>{t.toStatus}</strong>
                </td>
                <td>
                  <code>{t.actor}</code>
                </td>
                <td className="small">{t.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
