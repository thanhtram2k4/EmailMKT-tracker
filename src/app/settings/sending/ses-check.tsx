"use client";
import { useActionState } from "react";
import { LoaderCircle } from "lucide-react";
import { sesAccountCheckAction, type SesCheckState } from "../../test-send-actions";

/** Read-only SES GetAccount, on demand. Disabled unless real test sends are authorized here. */
export function SesCheck({ enabled }: { enabled: boolean }) {
  const [state, action, pending] = useActionState<SesCheckState>(async () => sesAccountCheckAction(), {});
  return (
    <section className="card" data-testid="ses-check">
      <h2>SES account check</h2>
      <p className="muted small mt0">Reads the account status (sandbox or production access, quota). It never sends email. Only available when real test sends are authorized in this environment.</p>
      <form action={action}>
        <button className="btn" type="submit" disabled={!enabled || pending} data-testid="ses-check-run">
          {pending && <LoaderCircle className="icon-sm spin" aria-hidden />} Check SES account
        </button>
      </form>
      {state.error && (
        <p className="field-error" role="alert">
          {state.error}
        </p>
      )}
      {state.info && (
        <dl className="kv mt3">
          <dt>Production access</dt>
          <dd>{state.info.productionAccess ? "yes" : "no (sandbox: only verified recipients and the simulator)"}</dd>
          <dt>Sending enabled</dt>
          <dd>{state.info.sendingEnabled ? "yes" : "no"}</dd>
          <dt>Quota (24 h)</dt>
          <dd>
            {state.info.sentLast24h ?? "?"} / {state.info.max24h ?? "?"} · max {state.info.maxPerSecond ?? "?"}/s
          </dd>
          <dt>Enforcement</dt>
          <dd>{state.info.enforcementStatus ?? "—"}</dd>
        </dl>
      )}
    </section>
  );
}
