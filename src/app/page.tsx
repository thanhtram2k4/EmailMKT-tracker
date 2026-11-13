import Link from "next/link";
import { Activity, ClipboardPaste, Database, RefreshCw, Server, Users } from "lucide-react";
import { requireStaff } from "../lib/auth/session";
import { systemClock } from "../lib/clock";
import { getConfig } from "../lib/config";
import { getDb } from "../lib/db/client";
import { checkHealth } from "../lib/health";
import { contactStats, syncOverview } from "../lib/crm/queries";
import { AppShell } from "./app-shell";
import { AlertsBanner } from "./campaigns/alerts-banner";
import { StatusPill } from "./campaigns/status-pill";
import { scheduledCampaigns } from "../lib/campaigns/queries";
import { formatInZone } from "../lib/campaigns/schedule-time";
import { Alert, Kpi, PageHeader, Pill } from "./ui";

export const dynamic = "force-dynamic";

const SEND_MODE_TEXT: Record<string, string> = {
  disabled: "Sending is disabled. No email can leave this environment.",
  mock: "Mock sending: messages are recorded in-process only and never leave this machine.",
  simulator: "Real test sends to the SES mailbox simulator only (authorized test mode).",
  allowlist: "Real test sends to allowlisted test recipients only (authorized test mode).",
  live: "Live sending (production). Customer campaigns still need admin enablement and per-campaign approval.",
};

export default async function Dashboard() {
  const staff = await requireStaff();
  const cfg = getConfig();
  const [stats, sync, sched] = await Promise.all([contactStats(getDb()), syncOverview(getDb()), scheduledCampaigns(getDb())]);
  const upcoming = sched.filter((r) => r.status === "scheduled" || r.status === "held_overdue").slice(0, 5);
  const health = await checkHealth(getDb(), {
    clock: systemClock,
    build: cfg.BUILD_ID,
    env: cfg.APP_ENV,
    sendMode: cfg.SEND_MODE,
    maxHeartbeatAgeS: cfg.HEALTH_MAX_HEARTBEAT_AGE_S,
  });
  const db = health.checks.database;
  const worker = health.checks.worker;

  return (
    <AppShell staff={staff}>
      <PageHeader
        title="Dashboard"
        sub={<>Welcome, {staff.name || staff.email}. Contacts are synchronized from the Notion CRM; emails are pasted and edited here, and sent as campaigns, now or at a scheduled time. Analytics arrive in a later milestone.</>}
        actions={
          <>
            <Link className="btn primary" href="/templates">
              <ClipboardPaste className="icon-sm" aria-hidden /> Paste HTML
            </Link>
            <Link className="btn" href="/sync">
              <RefreshCw className="icon-sm" aria-hidden /> Sync
            </Link>
          </>
        }
      />

      <Alert tone={cfg.SEND_MODE === "live" ? "bad" : cfg.SEND_MODE === "disabled" ? "warn" : "info"} testId="send-mode-banner">
        <strong>SEND_MODE={cfg.SEND_MODE}</strong> · APP_ENV={cfg.APP_ENV}. {SEND_MODE_TEXT[cfg.SEND_MODE]}
      </Alert>

      {!worker.ok && (
        <Alert tone="bad" testId="worker-banner" title="Background worker not running.">
          Scheduled and queued work will not run until it is back. <span className="muted">({worker.error})</span>
        </Alert>
      )}

      <AlertsBanner isAdmin={staff.role === "admin"} back="/" />

      {upcoming.length > 0 && (
        <section className="card" data-testid="upcoming-card">
          <h2>
            Upcoming scheduled campaigns · <Link href="/campaigns/scheduled">all</Link>
          </h2>
          <ul className="plain">
            {upcoming.map((r) => (
              <li key={r.id}>
                <Link href={`/campaigns/${r.id}`}>{r.name}</Link> — {formatInZone(new Date(r.scheduled_at_utc), r.schedule_tz)} · {r.recipients} recipient(s) <StatusPill status={r.status} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="kpis" data-testid="crm-card">
        <Kpi label="Active contacts" icon={<Users className="icon-sm" aria-hidden />} value={stats.active} note={<Link href="/contacts">Open contacts</Link>} />
        <Kpi
          label="Need attention"
          icon={<Activity className="icon-sm" aria-hidden />}
          value={stats.duplicates + stats.invalid + stats.missing}
          note={
            <>
              {stats.duplicates} duplicates · {stats.invalid + stats.missing} invalid/missing email · <Link href="/contacts/issues">Data issues</Link>
            </>
          }
        />
        <Kpi label="Suppressed addresses" value={stats.suppressions} note="Never re-subscribed automatically" />
        <Kpi
          label="Last Notion sync"
          icon={<Database className="icon-sm" aria-hidden />}
          value={sync.latestRun ? <Pill tone={sync.latestRun.status === "succeeded" ? "ok" : sync.latestRun.status === "failed" ? "bad" : "warn"}>{sync.latestRun.status}</Pill> : "never"}
          note={<>NOTION_MODE={cfg.NOTION_MODE}{sync.latestRun ? ` · ${sync.latestRun.mode}` : ""}</>}
        />
      </div>

      <section className="card" data-testid="health-card">
        <h2>
          <Server className="icon" aria-hidden /> System health
        </h2>
        <table>
          <tbody>
            <tr>
              <th>Database</th>
              <td>
                <Pill tone={db.ok ? "ok" : "bad"}>{db.ok ? "ok" : "unreachable"}</Pill> {db.latencyMs !== undefined && <span className="muted">{db.latencyMs} ms</span>}
              </td>
            </tr>
            <tr>
              <th>Worker</th>
              <td>
                <Pill tone={worker.ok ? "ok" : "bad"}>{worker.ok ? "running" : "not running"}</Pill>{" "}
                {worker.ageSeconds !== undefined && <span className="muted">last heartbeat {worker.ageSeconds}s ago</span>}
              </td>
            </tr>
            <tr>
              <th>Build</th>
              <td>
                <code>{health.build}</code>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </AppShell>
  );
}
