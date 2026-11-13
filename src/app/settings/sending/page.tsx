import { Gauge, Send } from "lucide-react";
import { requireRole } from "../../../lib/auth/session";
import { getConfig } from "../../../lib/config";
import { getDb } from "../../../lib/db/client";
import { GRACE_MAX, GRACE_MIN, getSendSettings, RATE_MAX, RATE_MIN, RESERVE_MAX, TRACKING_MODES } from "../../../lib/campaigns/settings";
import { testSendAvailability } from "../../../lib/sending/test-send";
import { updateSendingSettingsAction } from "../../campaign-actions";
import { AppShell } from "../../app-shell";
import { Alert, Flash, PageHeader, Pill } from "../../ui";
import { SesCheck } from "./ses-check";

export const dynamic = "force-dynamic";

/** Sending configuration (environment, read-only) and the M5 runtime settings (rate, quota reserve, live toggle). */
export default async function SendingSettings({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const staff = await requireRole("admin");
  const sp = await searchParams;
  const cfg = getConfig();
  const settings = await getSendSettings(getDb());
  const a = testSendAvailability(cfg);
  const real = a.available && (cfg.SEND_MODE === "simulator" || cfg.SEND_MODE === "allowlist" || cfg.SEND_MODE === "live");

  return (
    <AppShell staff={staff}>
      <PageHeader title="Sending" sub="How this environment may send email. The configuration comes from the server environment; the campaign rate and quota reserve can be changed below." />
      <Flash ok={sp.ok} error={sp.error} />

      <Alert tone={a.available ? "info" : "warn"} testId="sending-availability" title={a.available ? "Test sends available." : "Test sends are off."}>
        {a.reason}.
      </Alert>

      <section className="card" data-testid="sending-config">
        <h2>
          <Send className="icon" aria-hidden /> Configuration
        </h2>
        <dl className="kv">
          <dt>APP_ENV</dt>
          <dd>
            <code>{cfg.APP_ENV}</code>
          </dd>
          <dt>SEND_MODE</dt>
          <dd>
            <code>{cfg.SEND_MODE}</code>
          </dd>
          <dt>Provider</dt>
          <dd>Amazon SES v2 · region <code>{cfg.SES_REGION}</code></dd>
          <dt>From (verified identity)</dt>
          <dd>{cfg.SES_FROM_ADDRESS ? <code>{cfg.SES_FROM_ADDRESS}</code> : <Pill tone="warn">not set</Pill>}</dd>
          <dt>Configuration set</dt>
          <dd>{cfg.SES_CONFIGURATION_SET ? <code>{cfg.SES_CONFIGURATION_SET}</code> : <span className="muted">none (no Delivery/Bounce events)</span>}</dd>
          <dt>Authorization reference</dt>
          <dd>{cfg.SEND_AUTHORIZATION_REF ? <Pill tone="ok">recorded</Pill> : <Pill tone="warn">none</Pill>}</dd>
          <dt>Permitted test recipients</dt>
          <dd data-testid="allowlist-count">
            {cfg.TEST_RECIPIENT_ALLOWLIST.length} address(es) <span className="muted">(not shown)</span>
          </dd>
          <dt>Test-send limits</dt>
          <dd>
            {cfg.TEST_SEND_MAX_PER_HOUR} per person per hour · {cfg.TEST_SEND_MAX_PER_DAY} per day · provider timeout {cfg.SES_TIMEOUT_MS} ms
          </dd>
          <dt>Customer campaigns</dt>
          <dd data-testid="live-campaigns">
            {cfg.APP_ENV === "production" && cfg.SEND_MODE === "live" && settings.liveCampaignsEnabled ? (
              <Pill tone="bad">enabled</Pill>
            ) : (
              <Pill tone="warn">not enabled</Pill>
            )}{" "}
            <span className="muted">
              need APP_ENV=production, SEND_MODE=live, this admin switch and the compliance gate (docs/COMPLIANCE.md). Outside production, campaigns can only go to the mock transport, the SES simulator or allowlisted test inboxes.
            </span>
          </dd>
          <dt>Unsubscribe links</dt>
          <dd>
            <code>{cfg.trackingBaseUrl}/u/…</code>
          </dd>
          <dt>SES events (SNS)</dt>
          <dd>{cfg.SES_EVENTS_TOPIC_ARN ? <Pill tone="ok">topic configured</Pill> : <Pill tone="warn">not configured: the event endpoint refuses everything</Pill>}</dd>
        </dl>
      </section>

      <section className="card" data-testid="campaign-settings">
        <h2>
          <Gauge className="icon" aria-hidden /> Campaign sending
        </h2>
        <form action={updateSendingSettingsAction} className="stack">
          <div className="grid2">
            <label>
              Messages per second
              <input name="ratePerSecond" type="number" min={RATE_MIN} max={RATE_MAX} step="0.1" defaultValue={settings.ratePerSecond} required data-testid="setting-rate" />
              <span className="field-hint">Capped at 80% of the SES account’s maximum rate when sending.</span>
            </label>
            <label>
              Daily quota reserve (%)
              <input name="quotaReservePct" type="number" min={0} max={RESERVE_MAX} step="1" defaultValue={settings.quotaReservePct} required data-testid="setting-reserve" />
              <span className="field-hint">Share of the SES 24-hour quota campaigns never use. When the rest is used up the campaign is blocked until an admin resumes it.</span>
            </label>
            <label>
              Open/click tracking
              <select name="trackingMode" defaultValue={settings.trackingMode} data-testid="setting-tracking">
                {TRACKING_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m === "consented_only" ? "Only addresses with tracking consent (default)" : m === "all" ? "All recipients" : "Off"}
                  </option>
                ))}
              </select>
              <span className="field-hint">Pending counsel (docs/COMPLIANCE.md §3.3). Decided per message at send time; untracked messages have direct links and no open pixel.</span>
            </label>
            <label>
              Late-start grace period (minutes)
              <input name="graceMinutes" type="number" min={GRACE_MIN} max={GRACE_MAX} step="1" defaultValue={settings.graceMinutes} required data-testid="setting-grace" />
              <span className="field-hint">A scheduled campaign that starts later than this (for example after the worker was down) is held for an admin instead of being sent.</span>
            </label>
          </div>
          <label className="check">
            <input type="checkbox" name="liveCampaignsEnabled" defaultChecked={settings.liveCampaignsEnabled} disabled={cfg.APP_ENV !== "production"} data-testid="setting-live" /> Allow live customer campaigns{" "}
            {cfg.APP_ENV !== "production" && <span className="muted">(only possible in production)</span>}
          </label>
          <div className="row">
            <button className="btn primary" type="submit" data-testid="settings-save">
              Save
            </button>
          </div>
        </form>
      </section>

      <section className="card">
        <h2>What “accepted” means</h2>
        <ul className="plain small">
          <li>SES accepting a message is not proof that it reached the inbox.</li>
          <li>Delivery, bounce and complaint events need a configuration set with SNS and a public HTTPS endpoint, so they are not available on a local machine.</li>
          <li>A timeout is recorded as <strong>uncertain</strong> and is never retried automatically. Staff can explicitly send again.</li>
        </ul>
      </section>

      <SesCheck enabled={real} />
    </AppShell>
  );
}
