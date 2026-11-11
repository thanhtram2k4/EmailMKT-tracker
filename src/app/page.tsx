import { requireStaff } from "../lib/auth/session";
import { systemClock } from "../lib/clock";
import { getConfig } from "../lib/config";
import { getDb } from "../lib/db/client";
import { checkHealth } from "../lib/health";
import { AppHeader } from "./app-header";

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
  const health = await checkHealth(getDb(), {
    clock: systemClock,
    build: cfg.BUILD_ID,
    env: cfg.APP_ENV,
    sendMode: cfg.SEND_MODE,
    maxHeartbeatAgeS: cfg.HEALTH_MAX_HEARTBEAT_AGE_S,
  });

  return (
    <main className="shell">
      <AppHeader staff={staff} />

      <div className={`banner ${cfg.SEND_MODE === "live" ? "" : "warn"}`} data-testid="send-mode-banner">
        <strong>SEND_MODE={cfg.SEND_MODE}</strong> · APP_ENV={cfg.APP_ENV}. {SEND_MODE_TEXT[cfg.SEND_MODE]}
      </div>

      {!health.checks.worker.ok && (
        <div className="banner bad" data-testid="worker-banner">
          <strong>Background worker not running.</strong> Scheduled and queued work will not run until it is back.{" "}
          <span className="muted">({health.checks.worker.error})</span>
        </div>
      )}

      <section className="card">
        <h2>Welcome, {staff.name || staff.email}</h2>
        <p className="muted" style={{ margin: 0 }}>
          Foundation build (M1). Contacts, templates, campaigns, scheduling and analytics arrive in later milestones.
        </p>
      </section>

      <section className="card" data-testid="health-card">
        <h2>System health</h2>
        <table>
          <tbody>
            <tr>
              <th>Database</th>
              <td>
                <span className={`pill ${health.checks.database.ok ? "ok" : "bad"}`}>
                  {health.checks.database.ok ? "ok" : "unreachable"}
                </span>{" "}
                {health.checks.database.latencyMs !== undefined && (
                  <span className="muted">{health.checks.database.latencyMs} ms</span>
                )}
              </td>
            </tr>
            <tr>
              <th>Worker</th>
              <td>
                <span className={`pill ${health.checks.worker.ok ? "ok" : "bad"}`}>
                  {health.checks.worker.ok ? "running" : "not running"}
                </span>{" "}
                {health.checks.worker.ageSeconds !== undefined && (
                  <span className="muted">last heartbeat {health.checks.worker.ageSeconds}s ago</span>
                )}
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
    </main>
  );
}
