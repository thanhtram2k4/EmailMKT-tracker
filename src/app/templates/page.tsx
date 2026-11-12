import Link from "next/link";
import { requireStaff } from "../../lib/auth/session";
import { getDb } from "../../lib/db/client";
import { listTemplates } from "../../lib/templates/service";
import { importTemplateAction } from "../templates-actions";
import { AppHeader } from "../app-header";
import { Flash, fmtTime } from "../ui";

export const dynamic = "force-dynamic";

export default async function EmailsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const staff = await requireStaff();
  const sp = await searchParams;
  const rows = await listTemplates(getDb());
  return (
    <main className="shell wide">
      <AppHeader staff={staff} />
      <h1 className="page-title">Emails</h1>
      <Flash ok={sp.ok} error={sp.error} />

      <section className="card paste-card">
        <h2 style={{ marginTop: 0 }}>Paste HTML</h2>
        <form action={importTemplateAction} className="stack">
          <label htmlFor="paste-html" className="muted small">
            Paste the complete HTML of your email (for example the export or “view source” of your builder), then click Import.
          </label>
          <textarea id="paste-html" name="html" rows={14} className="paste-box" placeholder="<!DOCTYPE html>&#10;<html>…</html>" spellCheck={false} data-testid="import-html" />
          <div className="row">
            <label className="small">
              Name (optional, defaults to the email’s title)
              <input name="name" placeholder="e.g. Bản tin tháng 11" data-testid="import-name" />
            </label>
            <button className="btn primary big" type="submit" data-testid="import-submit">
              Import
            </button>
          </div>
          <details className="small" data-testid="import-more">
            <summary>More import options</summary>
            <div className="stack" style={{ marginTop: 8 }}>
              <label>
                Upload an .html file instead (max 2 MB; used only when the box above is empty)
                <input type="file" name="file" accept=".html,.htm,text/html" data-testid="import-file" />
              </label>
              <label>
                Import only part of a web page (CSS selector). Not needed for a normal email; only for an email embedded in another page.
                <input name="extract" placeholder="e.g. #email" data-testid="import-extract" />
              </label>
            </div>
          </details>
          <p className="muted small" style={{ margin: 0 }}>
            On import the HTML is checked for safety: scripts, forms, iframes, event handlers and javascript: links are removed. Layout, styles, Outlook conditional comments and merge fields such as{" "}
            <code>{'{{ greeting_name | default: "Quý khách" }}'}</code> are kept. Nothing is sent.
          </p>
        </form>
      </section>

      <section className="card table-wrap">
        <h2 style={{ marginTop: 0 }}>Your emails</h2>
        <table data-testid="templates-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Versions</th>
              <th>Last saved</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}>
                <td>
                  <Link href={`/templates/${t.id}`} data-testid="open-email">
                    {t.name}
                  </Link>
                </td>
                <td>{t.latest_version}</td>
                <td className="muted">{fmtTime(t.updated_at)}</td>
                <td className="muted small">
                  {t.source_kind === "paste" ? "pasted" : t.source_kind === "upload" ? `file ${t.source_filename ?? ""}` : t.source_kind}
                  {t.extract_selector ? ` · part ${t.extract_selector}` : ""}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  No emails yet. Paste your HTML above to start.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}
