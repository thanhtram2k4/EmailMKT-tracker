import { notFound } from "next/navigation";
import { requireStaff } from "../../../../../lib/auth/session";
import { getDb } from "../../../../../lib/db/client";
import { recipientTimeline } from "../../../../../lib/campaigns/analytics";
import { AppShell } from "../../../../app-shell";
import { EmptyState, PageHeader, Pill, fmtTime } from "../../../../ui";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One recipient's timeline for one campaign (DESIGN §4.3 "Views"). */
export default async function RecipientTimelinePage({ params }: { params: Promise<{ id: string; messageId: string }> }) {
  const staff = await requireStaff();
  const { id, messageId } = await params;
  if (!UUID.test(id) || !UUID.test(messageId)) notFound();
  const t = await recipientTimeline(getDb(), id, messageId);
  if (!t) notFound();
  const m = t.message;
  return (
    <AppShell staff={staff}>
      <PageHeader
        back={{ href: `/campaigns/${id}`, label: "Campaign" }}
        title={String(m.full_name ?? m.email_normalized)}
        titleTestId="timeline-title"
        sub={
          <>
            {String(m.email_normalized)} · send <Pill>{String(m.send_status).replace(/_/g, " ")}</Pill> · delivery <Pill>{String(m.delivery_status).replace(/_/g, " ")}</Pill> · tracking{" "}
            {m.tracking_enabled === true ? "on" : m.tracking_enabled === false ? "off" : "—"}
          </>
        }
      />
      <section className="card">
        <p className="small m0" data-testid="timeline-activity">
          First activity: {fmtTime(t.firstActivity)} · latest activity: {fmtTime(t.latestActivity)}
        </p>
      </section>
      <section className="card table-wrap" tabIndex={0}>
        <h2>Timeline</h2>
        {t.events.length === 0 ? (
          <EmptyState>Nothing yet.</EmptyState>
        ) : (
          <table data-testid="timeline-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Event</th>
                <th>Detail</th>
                <th>Automated?</th>
              </tr>
            </thead>
            <tbody>
              {t.events.map((e, k) => (
                <tr key={k}>
                  <td className="muted">{fmtTime(e.at)}</td>
                  <td>{e.type.replace(/_/g, " ")}</td>
                  <td className="small break-all">{e.detail}</td>
                  <td className="small">{e.flags.length ? <Pill tone={e.automated ? "warn" : undefined}>{e.flags.join(", ").replace(/_/g, " ")}</Pill> : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </AppShell>
  );
}
