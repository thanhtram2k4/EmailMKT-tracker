import Link from "next/link";
import { Ban } from "lucide-react";
import { requireStaff } from "../../lib/auth/session";
import { getDb } from "../../lib/db/client";
import { listSuppressions } from "../../lib/campaigns/queries";
import { suppressAddressAction } from "../campaign-actions";
import { AppShell } from "../app-shell";
import { EmptyState, Flash, Kpi, PageHeader, Pill, fmtTime, type Tone } from "../ui";

export const dynamic = "force-dynamic";

const REASONS: Record<string, { label: string; tone: Tone }> = {
  unsubscribe: { label: "unsubscribed", tone: "warn" },
  hard_bounce: { label: "hard bounce", tone: "bad" },
  complaint: { label: "complaint", tone: "bad" },
  manual: { label: "manual", tone: "info" },
  notion_unsubscribed: { label: "Notion", tone: "warn" },
};

export default async function SuppressionsPage({ searchParams }: { searchParams: Promise<{ q?: string; reason?: string; ok?: string; error?: string }> }) {
  const staff = await requireStaff();
  const sp = await searchParams;
  const reason = sp.reason && sp.reason in REASONS ? sp.reason : undefined;
  const { rows, byReason } = await listSuppressions(getDb(), { q: sp.q, reason });
  const total = byReason.reduce((a, r) => a + r.n, 0);

  return (
    <AppShell staff={staff} wide>
      <PageHeader
        title="Suppressions"
        sub="Addresses that never receive marketing email: unsubscribes, hard bounces, complaints, Notion opt-outs and manual entries. Suppressions are never removed automatically, and Notion “Subscribed” does not lift them."
      />
      <Flash ok={sp.ok} error={sp.error} />

      <div className="kpis">
        <Kpi label="Suppressed addresses" value={<span data-testid="suppressions-total">{total}</span>} icon={<Ban className="icon-sm" aria-hidden />} />
        {Object.entries(REASONS).map(([k, v]) => (
          <Kpi key={k} label={v.label} value={byReason.find((r) => r.reason === k)?.n ?? 0} />
        ))}
      </div>

      {staff.role === "admin" && (
        <section className="card" data-testid="suppress-form">
          <h2>Suppress an address</h2>
          <form action={suppressAddressAction} className="row">
            <label>
              Email
              <input name="email" type="email" required placeholder="name@example.com" data-testid="suppress-email" />
            </label>
            <label>
              Why (request, ticket…)
              <input name="note" required maxLength={500} data-testid="suppress-note" />
            </label>
            <button className="btn" type="submit" data-testid="suppress-submit">
              Suppress
            </button>
          </form>
          <p className="muted small m0">This cannot be undone from the app. It also writes “Unsubscribed” back to the matching Notion contacts.</p>
        </section>
      )}

      <section className="card table-wrap" tabIndex={0}>
        <form className="filters row" method="get">
          <label>
            Search
            <input name="q" defaultValue={sp.q ?? ""} placeholder="part of an address" data-testid="suppressions-search" />
          </label>
          <label>
            Reason
            <select name="reason" defaultValue={reason ?? ""}>
              <option value="">any</option>
              {Object.entries(REASONS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
          <button className="btn" type="submit">
            Filter
          </button>
        </form>
        {rows.length === 0 ? (
          <EmptyState>No suppressed addresses match.</EmptyState>
        ) : (
          <table data-testid="suppressions-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Reason</th>
                <th>Source</th>
                <th>Campaign</th>
                <th>Added</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.email_normalized}>
                  <td>{r.email_normalized}</td>
                  <td>
                    <Pill tone={REASONS[r.reason]?.tone}>{REASONS[r.reason]?.label ?? r.reason}</Pill>
                  </td>
                  <td className="muted small">{r.source}</td>
                  <td className="small">{r.campaign_id ? <Link href={`/campaigns/${r.campaign_id}`}>{r.campaign_name ?? "campaign"}</Link> : "—"}</td>
                  <td className="muted">{fmtTime(r.created_at)}</td>
                  <td className="small">{r.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {rows.length === 500 && <p className="muted small">Showing the latest 500; use search to narrow.</p>}
      </section>
    </AppShell>
  );
}
