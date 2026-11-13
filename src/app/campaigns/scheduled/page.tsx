import Link from "next/link";
import { CalendarClock } from "lucide-react";
import { requireStaff } from "../../../lib/auth/session";
import { systemClock } from "../../../lib/clock";
import { getConfig } from "../../../lib/config";
import { getDb } from "../../../lib/db/client";
import { checkHealth } from "../../../lib/health";
import { scheduledCampaigns } from "../../../lib/campaigns/queries";
import { formatInZone, formatOffset, formatUtc } from "../../../lib/campaigns/schedule-time";
import { AppShell } from "../../app-shell";
import { Alert, EmptyState, PageHeader } from "../../ui";
import { AlertsBanner } from "../alerts-banner";
import { StatusPill } from "../status-pill";

export const dynamic = "force-dynamic";

/** Scheduled list (DESIGN §4.2 "Visibility"): status, local and UTC time, revision and next action. */
export default async function ScheduledPage() {
  const staff = await requireStaff();
  const db = getDb();
  const cfg = getConfig();
  // The worker-down banner uses a 2-minute threshold (DESIGN §4.2), not the /healthz one.
  const [rows, health] = await Promise.all([
    scheduledCampaigns(db),
    checkHealth(db, { clock: systemClock, build: cfg.BUILD_ID, env: cfg.APP_ENV, sendMode: cfg.SEND_MODE, maxHeartbeatAgeS: 120 }),
  ]);
  const upcoming = rows.filter((r) => r.status === "scheduled").length;

  return (
    <AppShell staff={staff} wide>
      <PageHeader title="Scheduled" sub="One-time scheduled campaigns. Times are shown in the zone chosen when scheduling, and in UTC. Scheduled campaigns are started by the background worker; no browser needs to stay open." />
      {!health.checks.worker.ok && (
        <Alert tone="bad" title="The background worker has not reported for more than 2 minutes." testId="worker-down-banner">
          Scheduled campaigns cannot start until it is back. A campaign that starts more than the grace period late is held, not sent.
        </Alert>
      )}
      <AlertsBanner isAdmin={staff.role === "admin"} back="/campaigns/scheduled" />
      <section className="card table-wrap" tabIndex={0}>
        <h2>
          <CalendarClock className="icon" aria-hidden /> {upcoming} upcoming
        </h2>
        {rows.length === 0 ? (
          <EmptyState>No scheduled campaigns. Schedule one from a campaign’s review page.</EmptyState>
        ) : (
          <table data-testid="scheduled-table">
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Status</th>
                <th>Local time</th>
                <th>UTC</th>
                <th className="num">Revision</th>
                <th className="num">Recipients</th>
                <th>Started / next action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-testid="scheduled-row">
                  <td>
                    <Link href={`/campaigns/${r.id}`}>{r.name}</Link>
                  </td>
                  <td>
                    <StatusPill status={r.status} />
                  </td>
                  <td>
                    {r.schedule_local} <span className="muted small">({r.schedule_tz}, {formatOffset(r.schedule_offset_minutes)})</span>
                  </td>
                  <td className="muted">{formatUtc(new Date(r.scheduled_at_utc))}</td>
                  <td className="num">{r.schedule_revision}</td>
                  <td className="num">{r.status === "scheduled" || r.status === "held_overdue" ? r.recipients : `${r.sent} / ${r.recipients}`}</td>
                  <td className="small">
                    {r.status === "scheduled" ? (
                      <Link href={`/campaigns/${r.id}#schedule`}>Reschedule or cancel</Link>
                    ) : r.status === "held_overdue" ? (
                      <Link href={`/campaigns/${r.id}#schedule`}>Decide: send now, reschedule or cancel</Link>
                    ) : r.processing_started_at ? (
                      <>
                        {formatInZone(new Date(r.processing_started_at), r.schedule_tz)}
                        {r.start_delay_ms !== null && <span className="muted"> · +{Math.round(r.start_delay_ms / 1000)} s</span>}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </AppShell>
  );
}
