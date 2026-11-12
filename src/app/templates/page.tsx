import Link from "next/link";
import { requireStaff } from "../../lib/auth/session";
import { getDb } from "../../lib/db/client";
import { FIXTURES } from "../../lib/templates/fixtures";
import { listTemplates } from "../../lib/templates/service";
import { importFixtureAction, importTemplateAction } from "../templates-actions";
import { AppHeader } from "../app-header";
import { Flash, fmtTime } from "../ui";

export const dynamic = "force-dynamic";

export default async function TemplatesPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const staff = await requireStaff();
  const sp = await searchParams;
  const rows = await listTemplates(getDb());
  return (
    <main className="shell wide">
      <AppHeader staff={staff} />
      <h1 className="page-title">Templates (M3 editor trial)</h1>
      <Flash ok={sp.ok} error={sp.error} />
      <div className="banner warn" data-testid="trial-banner">
        Editor trial. Previews are rendered by <strong>this browser</strong> only — they are not Gmail, Outlook or mobile email-client results. Sending is
        disabled.
      </div>

      <section className="card">
        <h2>Import an HTML template</h2>
        <form action={importTemplateAction} className="stack">
          <label>
            Name
            <input name="name" placeholder="e.g. Bản tin tháng 11" data-testid="import-name" />
          </label>
          <label>
            HTML file (.html, max 2 MB)
            <input type="file" name="file" accept=".html,.htm,text/html" data-testid="import-file" />
          </label>
          <label>
            …or paste HTML
            <textarea name="html" rows={5} style={{ width: "100%", maxWidth: 720, fontFamily: "monospace" }} data-testid="import-html" />
          </label>
          <label>
            Only import part of the page (optional CSS selector, e.g. <code>#email</code> for a tool page that wraps the email)
            <input name="extract" placeholder="#email" data-testid="import-extract" />
          </label>
          <div>
            <button className="btn primary" type="submit" data-testid="import-submit">
              Import
            </button>
          </div>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            The HTML is sanitized on import (scripts, forms, iframes, event handlers and javascript: links are removed; Outlook conditional comments are kept).
          </p>
        </form>
      </section>

      <section className="card">
        <h2>Synthetic fixtures</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          Clearly labelled SYNTHETIC templates used when real templates are not available.
        </p>
        <div className="row">
          {Object.entries(FIXTURES).map(([k, f]) => (
            <form key={k} action={importFixtureAction}>
              <input type="hidden" name="fixture" value={k} />
              <button className="btn" type="submit" data-testid={`fixture-${k}`}>
                Import {f.name}
              </button>
            </form>
          ))}
        </div>
      </section>

      <section className="card table-wrap">
        <table data-testid="templates-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Source</th>
              <th>Versions</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}>
                <td>
                  <Link href={`/templates/${t.id}`}>{t.name}</Link>
                </td>
                <td className="muted">
                  {t.source_kind}
                  {t.source_filename ? ` · ${t.source_filename}` : ""}
                  {t.extract_selector ? ` · ${t.extract_selector}` : ""}
                  {t.source_sha256 ? ` · sha256 ${t.source_sha256.slice(0, 12)}…` : ""}
                </td>
                <td>{t.latest_version}</td>
                <td className="muted">{fmtTime(t.updated_at)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  No templates yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}
