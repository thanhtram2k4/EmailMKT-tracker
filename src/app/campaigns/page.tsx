import Link from "next/link";
import { Megaphone } from "lucide-react";
import { requireStaff } from "../../lib/auth/session";
import { allTags } from "../../lib/crm/queries";
import { getDb } from "../../lib/db/client";
import { listCampaigns, templateChoices } from "../../lib/campaigns/queries";
import { createCampaignAction } from "../campaign-actions";
import { AppShell } from "../app-shell";
import { EmptyState, Flash, PageHeader, fmtTime } from "../ui";
import { AudienceFields } from "./audience-fields";
import { StatusPill } from "./status-pill";

export const dynamic = "force-dynamic";

export default async function CampaignsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const staff = await requireStaff();
  const sp = await searchParams;
  const db = getDb();
  const [rows, templates, tags] = await Promise.all([listCampaigns(db), templateChoices(db), allTags(db)]);

  return (
    <AppShell staff={staff} wide>
      <PageHeader title="Campaigns" sub="Choose an email and an audience, review the exclusions, then an admin sends it. Scheduling arrives in a later milestone." />
      <Flash ok={sp.ok} error={sp.error} />

      <section className="card" data-testid="new-campaign">
        <h2>
          <Megaphone className="icon" aria-hidden /> New campaign
        </h2>
        {templates.length === 0 ? (
          <p className="muted m0">
            No emails yet. <Link href="/templates">Paste an email</Link> first.
          </p>
        ) : (
          <form action={createCampaignAction} className="stack">
            <div className="grid2">
              <label>
                Campaign name
                <input name="name" required maxLength={200} placeholder="e.g. Ưu đãi tháng 11" data-testid="campaign-name" />
              </label>
              <label>
                Email
                <select name="templateId" required data-testid="campaign-template">
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} (v{t.version_no}
                      {t.subject ? "" : ", no subject yet"})
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <AudienceFields tags={tags} />
            <div className="row">
              <button className="btn primary" type="submit" data-testid="campaign-create">
                Create draft
              </button>
              <span className="muted small">Nothing is sent when you create a draft.</span>
            </div>
          </form>
        )}
      </section>

      <section className="card table-wrap" tabIndex={0}>
        <h2>All campaigns</h2>
        {rows.length === 0 ? (
          <EmptyState>No campaigns yet.</EmptyState>
        ) : (
          <table data-testid="campaigns-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Email</th>
                <th className="num">Sent / recipients</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link href={`/campaigns/${c.id}`} data-testid="open-campaign">
                      {c.name}
                    </Link>
                  </td>
                  <td>
                    <StatusPill status={c.status} />
                  </td>
                  <td className="muted">{c.template_name}</td>
                  <td className="num">{c.status === "draft" ? "—" : `${c.sent} / ${c.total}`}</td>
                  <td className="muted">{fmtTime(c.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </AppShell>
  );
}
