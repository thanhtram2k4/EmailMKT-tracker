import { requireStaff } from "../../lib/auth/session";
import { getConfig } from "../../lib/config";
import { loadConnection } from "../../lib/crm/notion-env";
import { syncOverview } from "../../lib/crm/queries";
import type { SyncCounts } from "../../lib/crm/sync";
import { getDb } from "../../lib/db/client";
import { syncNowAction } from "../crm-actions";
import { AppHeader } from "../app-header";
import { Flash, Pill, fmtTime } from "../ui";

export const dynamic = "force-dynamic";

const TONE: Record<string, "ok" | "bad" | "warn" | undefined> = { succeeded: "ok", partial: "warn", failed: "bad", running: undefined, skipped: undefined };

export default async function SyncPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const staff = await requireStaff();
  const sp = await searchParams;
  const db = getDb();
  const cfg = getConfig();
  const [o, conn] = await Promise.all([syncOverview(db), loadConnection(db)]);

  return (
    <main className="shell wide">
      <AppHeader staff={staff} />
      <h1 className="page-title">Notion synchronization</h1>
      <Flash ok={sp.ok} error={sp.error} />
      <section className="card" data-testid="sync-status">
        <table>
          <tbody>
            <tr>
              <th>Mode</th>
              <td>
                <code>NOTION_MODE={cfg.NOTION_MODE}</code> {cfg.NOTION_MODE === "mock" && <Pill tone="warn">local mock server · synthetic data</Pill>}
              </td>
            </tr>
            <tr>
              <th>Connection</th>
              <td>{conn?.status === "connected" ? `${conn.databaseTitle} (data source ${conn.dataSourceId})` : "not connected"}</td>
            </tr>
            <tr>
              <th>Schedule</th>
              <td className="muted">Incremental every 10 minutes (5-minute overlap) · full reconcile nightly 02:00 Asia/Ho_Chi_Minh · outbox every minute</td>
            </tr>
            <tr>
              <th>Last successful sync</th>
              <td>{fmtTime(o.state?.lastSuccessAt)}</td>
            </tr>
            <tr>
              <th>Last full sync</th>
              <td>{fmtTime(o.state?.lastFullSyncAt)}</td>
            </tr>
            <tr>
              <th>Incremental cursor</th>
              <td>
                <code>{o.state?.incrementalCursor?.toISOString() ?? "—"}</code>
              </td>
            </tr>
            <tr>
              <th>Notion write-back (outbox)</th>
              <td data-testid="outbox-counts">
                pending {o.outboxCounts.pending ?? 0} · done {o.outboxCounts.done ?? 0} · failed{" "}
                {o.outboxCounts.failed ? <Pill tone="bad">{o.outboxCounts.failed}</Pill> : 0}
              </td>
            </tr>
          </tbody>
        </table>
        {staff.role === "admin" && (
          <div className="row" style={{ marginTop: 12 }}>
            <form action={syncNowAction}>
              <input type="hidden" name="mode" value="incremental" />
              <button className="btn primary" type="submit" data-testid="sync-now">
                Sync now
              </button>
            </form>
            <form action={syncNowAction}>
              <input type="hidden" name="mode" value="full" />
              <button className="btn" type="submit" data-testid="full-sync-now">
                Full sync now
              </button>
            </form>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Recent runs</h2>
        <div className="table-wrap">
          <table data-testid="sync-runs">
            <thead>
              <tr>
                <th>Started</th>
                <th>Mode</th>
                <th>Trigger</th>
                <th>Status</th>
                <th>Fetched</th>
                <th>Created</th>
                <th>Updated</th>
                <th>Unchanged</th>
                <th>Archived</th>
                <th>Suppr. added</th>
                <th>Issues</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {o.runs.map((r) => {
                const c = (r.counts ?? {}) as Partial<SyncCounts>;
                return (
                  <tr key={r.id} data-testid="sync-run-row">
                    <td className="muted">{fmtTime(r.startedAt)}</td>
                    <td>{r.mode}</td>
                    <td>{r.trigger}</td>
                    <td>
                      <Pill tone={TONE[r.status]}>{r.status}</Pill>
                    </td>
                    <td>{c.fetched ?? 0}</td>
                    <td>{c.created ?? 0}</td>
                    <td>{c.updated ?? 0}</td>
                    <td>{c.unchanged ?? 0}</td>
                    <td>{(c.archived ?? 0) + (c.archivedMissing ?? 0)}</td>
                    <td>{c.suppressionsAdded ?? 0}</td>
                    <td>{(c.dataIssues ?? 0) + (c.pageErrors ?? 0)}</td>
                    <td className="muted">{r.errorCode ? `${r.errorCode}: ${r.errorMessage ?? ""}` : ""}</td>
                  </tr>
                );
              })}
              {o.runs.length === 0 && (
                <tr>
                  <td colSpan={12} className="muted">
                    No runs yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {o.failedOutbox.length > 0 && (
        <section className="card" data-testid="outbox-failed">
          <h2>Failed Notion write-backs</h2>
          <table>
            <tbody>
              {o.failedOutbox.map((f) => (
                <tr key={f.id}>
                  <td>
                    <code>{f.notionPageId}</code>
                  </td>
                  <td>{JSON.stringify(f.payload)}</td>
                  <td className="muted">{f.lastError}</td>
                  <td className="muted">{f.attempts} attempts</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
