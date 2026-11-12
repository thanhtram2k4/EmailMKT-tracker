import { Send } from "lucide-react";
import { requireRole } from "../../../lib/auth/session";
import { getConfig } from "../../../lib/config";
import { testSendAvailability } from "../../../lib/sending/test-send";
import { AppShell } from "../../app-shell";
import { Alert, PageHeader, Pill } from "../../ui";
import { SesCheck } from "./ses-check";

export const dynamic = "force-dynamic";

/** Read-only view of the sending configuration. Settings are changed in the environment, not here. */
export default async function SendingSettings() {
  const staff = await requireRole("admin");
  const cfg = getConfig();
  const a = testSendAvailability(cfg);
  const real = a.available && (cfg.SEND_MODE === "simulator" || cfg.SEND_MODE === "allowlist" || cfg.SEND_MODE === "live");

  return (
    <AppShell staff={staff}>
      <PageHeader title="Sending" sub="How this environment may send email. These values come from the server environment and are read-only here." />

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
          <dd>
            <Pill tone="warn">not available</Pill> <span className="muted">send engine arrives in M5; needs production, SEND_MODE=live and separate approval</span>
          </dd>
        </dl>
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
