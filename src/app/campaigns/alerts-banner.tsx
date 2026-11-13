import Link from "next/link";
import { getDb } from "../../lib/db/client";
import { openAlerts } from "../../lib/campaigns/alerts";
import { acknowledgeAlertAction } from "../campaign-actions";
import { Alert, fmtTime } from "../ui";

/** Open admin alerts (held / blocked campaigns). Admins can acknowledge them; members only see them. */
export async function AlertsBanner({ isAdmin, back }: { isAdmin: boolean; back: string }) {
  const alerts = await openAlerts(getDb());
  if (!alerts.length) return null;
  return (
    <Alert tone="bad" title={`${alerts.length} campaign alert(s) need attention:`} testId="admin-alerts">
      <ul className="plain">
        {alerts.map((a) => (
          <li key={a.id} className="row">
            <span>
              {fmtTime(a.created_at)} · {a.campaign_id ? <Link href={`/campaigns/${a.campaign_id}`}>{a.campaign_name ?? "campaign"}</Link> : "—"} · {a.message}{" "}
              <span className="muted small">(email: {a.email_status.replace(/_/g, " ")})</span>
            </span>
            {isAdmin && (
              <form action={acknowledgeAlertAction}>
                <input type="hidden" name="alertId" value={a.id} />
                <input type="hidden" name="back" value={back} />
                <button className="btn small-btn" type="submit" data-testid="alert-ack">
                  Acknowledge
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </Alert>
  );
}
