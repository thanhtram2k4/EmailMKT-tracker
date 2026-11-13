import Link from "next/link";
import { BarChart3 } from "lucide-react";
import { getDb } from "../../../lib/db/client";
import { campaignAnalytics, linkAnalytics, rate } from "../../../lib/campaigns/analytics";
import { getSendSettings } from "../../../lib/campaigns/settings";
import { EmptyState, Kpi, fmtTime } from "../../ui";

/**
 * Campaign analytics (DESIGN §4.3). Headline tiles follow the toggle (filtered = automated activity
 * removed, the default; recorded = every event); the comparison table always shows both.
 */
export async function AnalyticsSection({ campaignId, activity }: { campaignId: string; activity: "filtered" | "recorded" }) {
  const db = getDb();
  const [a, links, settings] = await Promise.all([campaignAnalytics(db, campaignId), linkAnalytics(db, campaignId), getSendSettings(db)]);
  const e = activity === "filtered" ? a.filtered : a.recorded;
  const sent = a.counts.sent;
  const delivered = a.counts.delivered;
  const toggle = (k: "filtered" | "recorded", label: string) => (
    <Link href={`/campaigns/${campaignId}?activity=${k}#analytics`} aria-current={activity === k ? "page" : undefined} className={activity === k ? "pill info" : "pill"} data-testid={`activity-${k}`}>
      {label}
    </Link>
  );
  const rows: Array<[string, (x: typeof a.recorded) => string]> = [
    ["Unique openers", (x) => String(x.uniqueOpeners)],
    ["Opens (recorded)", (x) => String(x.totalOpens)],
    ["Unique clickers", (x) => String(x.uniqueClickers)],
    ["Clicks (recorded)", (x) => String(x.totalClicks)],
    ["Open rate of Delivered", (x) => rate(x.uniqueOpeners, delivered)],
    ["Open rate of Sent", (x) => rate(x.uniqueOpeners, sent)],
    ["Click rate of Delivered", (x) => rate(x.uniqueClickers, delivered)],
    ["Click rate of Sent", (x) => rate(x.uniqueClickers, sent)],
    ["Click-to-open (CTOR)", (x) => rate(x.uniqueClickers, x.uniqueOpeners)],
  ];

  return (
    <section className="card" id="analytics" data-testid="analytics-card">
      <h2>
        <BarChart3 className="icon" aria-hidden /> Analytics
      </h2>
      <nav className="row small" aria-label="Activity shown">
        {toggle("filtered", "Automated activity filtered out")}
        {toggle("recorded", "All recorded events")}
      </nav>
      <div className="kpis">
        <Kpi label="Unique openers" value={<span data-testid="an-openers">{e.uniqueOpeners}</span>} note={`${e.totalOpens} opens · ${rate(e.uniqueOpeners, delivered)} of Delivered · ${rate(e.uniqueOpeners, sent)} of Sent`} />
        <Kpi label="Unique clickers" value={<span data-testid="an-clickers">{e.uniqueClickers}</span>} note={`${e.totalClicks} clicks · ${rate(e.uniqueClickers, delivered)} of Delivered · ${rate(e.uniqueClickers, sent)} of Sent`} />
        <Kpi label="Click-to-open (CTOR)" value={rate(e.uniqueClickers, e.uniqueOpeners)} />
        <Kpi label="Unsubscribes" value={a.unsubscribes} />
      </div>
      <p className="muted small m0">
        Tracked: {a.tracked} of {sent} sent message(s) (tracking mode <code>{settings.trackingMode}</code>). First activity {fmtTime(a.firstActivity)} · latest {fmtTime(a.latestActivity)} · {a.automatedEvents} event(s)
        flagged as automated.
      </p>

      <div className="table-wrap" tabIndex={0}>
        <table data-testid="analytics-compare">
          <thead>
            <tr>
              <th>Metric</th>
              <th className="num">All recorded</th>
              <th className="num">Automated filtered out</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, f]) => (
              <tr key={label}>
                <td>{label}</td>
                <td className="num">{f(a.recorded)}</td>
                <td className="num">{f(a.filtered)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Links</h3>
      {links.length === 0 ? (
        <EmptyState>This email has no tracked links.</EmptyState>
      ) : (
        <div className="table-wrap" tabIndex={0}>
          <table data-testid="analytics-links">
            <thead>
              <tr>
                <th>#</th>
                <th>Link</th>
                <th className="num">Unique clickers</th>
                <th className="num">Clicks</th>
                <th>First / latest</th>
              </tr>
            </thead>
            <tbody>
              {links.map((l) => (
                <tr key={l.idx}>
                  <td className="num">{l.idx}</td>
                  <td className="break-all">
                    {l.label && <strong>{l.label}</strong>} <span className="muted small">{l.url}</span>
                  </td>
                  <td className="num">{activity === "filtered" ? l.uniqueFiltered : l.uniqueAll}</td>
                  <td className="num">{activity === "filtered" ? l.totalFiltered : l.totalAll}</td>
                  <td className="muted small">
                    {fmtTime(l.first)} / {fmtTime(l.latest)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <details className="small mt3">
        <summary>What these numbers can and cannot show</summary>
        <ul className="plain">
          <li>Unique openers include recipients who clicked without a recorded open (their images were blocked): a click implies the email was opened. “Opens (recorded)” counts pixel loads only.</li>
          <li>Opens depend on images loading: image blocking hides opens; Gmail’s image proxy caches images, so repeat opens are unreliable; Apple Mail Privacy Protection may load images without anyone reading.</li>
          <li>Security scanners open and click links automatically. Flagged events (scanner user agents, HEAD requests, clicks under 10 s after delivery, several links within 2 s) are removed in the filtered view; detection is heuristic.</li>
          <li>Forwarded emails count for the original recipient. “Delivered” means the recipient’s server accepted the message, not that it reached the inbox.</li>
          <li>Only messages sent with tracking (setting and tracking consent at send time) can be counted. Test sends are never counted.</li>
        </ul>
      </details>
    </section>
  );
}
