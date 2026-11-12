"use client";
import { useActionState } from "react";
import { CircleCheck, CircleX, LoaderCircle, Send, TriangleExclamationPoint } from "lucide-react";
import { resendTestAction, sendTestAction, type TestSendState } from "../../test-send-actions";

export type TestSendRow = {
  id: string;
  recipient: string; // masked
  status: string;
  subject: string | null;
  mergeSource: string;
  versionNo: number | null;
  providerMessageId: string | null;
  error: string | null;
  createdAt: string;
  transport: string | null;
  resendOf: string | null;
};

const TONE: Record<string, "ok" | "bad" | "warn" | "info"> = { accepted: "ok", rejected: "bad", refused: "bad", retryable: "warn", unknown: "warn", claimed: "info" };
const LABEL: Record<string, string> = {
  accepted: "accepted by provider",
  rejected: "rejected",
  refused: "refused (not sent)",
  retryable: "not accepted (not retried)",
  unknown: "uncertain — may or may not have been sent",
  claimed: "in progress",
};

function StatusPill({ status }: { status: string }) {
  const tone = TONE[status] ?? "info";
  const Icon = tone === "ok" ? CircleCheck : tone === "bad" ? CircleX : TriangleExclamationPoint;
  return (
    <span className={`pill ${tone}`} data-status={status}>
      <Icon className="icon-sm" aria-hidden />
      {LABEL[status] ?? status}
    </span>
  );
}

export function TestSendPanel(props: {
  templateId: string;
  versionId: string;
  versionNo: number;
  hasSubject: boolean;
  recipients: Array<{ id: string; label: string }>;
  defaultMergeSource: string;
  availability: { available: boolean; reason: string };
  sendMode: string;
  allowlistCount: number;
  initialKey: string;
  resendKey: string;
  history: TestSendRow[];
}) {
  const [state, action, pending] = useActionState<TestSendState, FormData>(sendTestAction, { key: props.initialKey });
  const [rState, resend, rPending] = useActionState<TestSendState, FormData>(resendTestAction, { key: props.resendKey });
  const disabled = !props.availability.available || !props.hasSubject || pending;
  const shown = rState.results || rState.error ? rState : state;

  return (
    <section className="card test-send-form" data-testid="test-send-panel" aria-labelledby="test-send-title">
      <div className="card-head">
        <h2 id="test-send-title">
          <Send className="icon" aria-hidden /> Gửi thử (test send)
        </h2>
        <span className={`pill ${props.availability.available ? "info" : "warn"}`} data-testid="test-send-mode">
          SEND_MODE={props.sendMode}
        </span>
      </div>
      <p className="muted small mt0" data-testid="test-send-availability">
        {props.availability.available ? `Available: ${props.availability.reason}.` : `Test sends are off here: ${props.availability.reason}.`} Only addresses on the permitted test list ({props.allowlistCount} configured) are accepted; the
        subject gets a <code>[TEST]</code> prefix and test sends never count in campaign metrics.
      </p>
      {!props.hasSubject && (
        <div className="banner warn small" data-testid="test-send-needs-subject">
          Add a subject above before sending a test.
        </div>
      )}

      <form action={action} className="stack">
        <input type="hidden" name="templateId" value={props.templateId} />
        <input type="hidden" name="versionId" value={props.versionId} />
        <input type="hidden" name="idempotencyKey" value={state.key} />
        <label className="recipients">
          Test address(es) — up to 3, separated by commas
          <input name="recipients" type="text" inputMode="email" autoComplete="off" required placeholder="qa-inbox@company.com" data-testid="test-send-recipients" />
          <span className="field-hint">Typed addresses must be on the permitted test list (TEST_RECIPIENT_ALLOWLIST) or be SES simulator addresses.</span>
        </label>
        <label>
          Fill merge fields as
          <select name="mergeSource" defaultValue={props.defaultMergeSource} data-testid="test-send-merge-source">
            {props.recipients.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          <button className="btn primary" type="submit" disabled={disabled} aria-disabled={disabled} data-testid="test-send-submit">
            {pending ? <LoaderCircle className="icon-sm spin" aria-hidden /> : <Send className="icon-sm" aria-hidden />}
            {pending ? "Sending…" : `Send test of v${props.versionNo}`}
          </button>
        </div>
      </form>

      <div aria-live="polite">
        {shown.error && (
          <div className="banner bad small" role="alert" data-testid="test-send-error">
            <strong>{shown.error}</strong>
            {shown.details && shown.details.length > 0 && (
              <ul className="plain">
                {shown.details.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {shown.results && (
          <ul className="plain mt2" data-testid="test-send-results">
            {shown.results.map((r) => (
              <li key={r.id} data-testid="test-send-result" data-status={r.status}>
                <code>{r.recipient}</code> <StatusPill status={r.status} /> <span className="small">{r.message}</span>
                {r.providerMessageId && <div className="muted small">Provider message id: <code>{r.providerMessageId}</code></div>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <h3>History</h3>
      {props.history.length === 0 ? (
        <p className="muted small">No test sends for this email yet.</p>
      ) : (
        <div className="table-wrap" tabIndex={0}>
          <table data-testid="test-send-history">
            <thead>
              <tr>
                <th>When</th>
                <th>To</th>
                <th>Status</th>
                <th>Subject</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {props.history.map((h) => (
                <tr key={h.id} data-testid="test-send-row" data-status={h.status}>
                  <td className="muted small">{h.createdAt}</td>
                  <td>
                    <code>{h.recipient}</code>
                    {h.versionNo !== null && <div className="muted small">v{h.versionNo} · {h.transport ?? "—"}</div>}
                  </td>
                  <td>
                    <StatusPill status={h.status} />
                    {h.error && <div className="muted small">{h.error}</div>}
                    {h.providerMessageId && <div className="muted small">id {h.providerMessageId}</div>}
                    {h.resendOf && <div className="muted small">resend</div>}
                  </td>
                  <td className="small">{h.subject ?? "—"}</td>
                  <td>
                    {(h.status === "unknown" || h.status === "retryable" || h.status === "rejected") && props.availability.available && (
                      <form
                        action={resend}
                        onSubmit={(e) => {
                          if (h.status === "unknown" && !window.confirm("The earlier attempt may already have been delivered. Send another copy?")) e.preventDefault();
                        }}
                      >
                        <input type="hidden" name="resendOf" value={h.id} />
                        <input type="hidden" name="idempotencyKey" value={rState.key} />
                        <button className="btn small-btn" type="submit" disabled={rPending} data-testid="test-send-again">
                          Send again
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
