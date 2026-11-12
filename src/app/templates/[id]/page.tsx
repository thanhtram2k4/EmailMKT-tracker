import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "../../../lib/auth/session";
import { getDb } from "../../../lib/db/client";
import { regionsOf } from "../../../lib/templates/editable";
import { lintTemplate } from "../../../lib/templates/lint";
import { MERGE_FIELDS } from "../../../lib/templates/merge";
import { previewRecipients } from "../../../lib/templates/recipients";
import type { SanitizeReport } from "../../../lib/templates/sanitize";
import { getTemplate, getVersion } from "../../../lib/templates/service";
import { AppHeader } from "../../app-header";
import { Pill, fmtTime } from "../../ui";
import { TemplateEditor } from "./template-editor";

export const dynamic = "force-dynamic";

export default async function TemplatePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ v?: string }> }) {
  const staff = await requireStaff();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = getDb();
  const t = await getTemplate(db, id);
  if (!t) notFound();
  const v = await getVersion(db, id, sp.v);
  if (!v) notFound();
  const latest = t.versions[0];
  const regions = regionsOf(v.html);
  const lint = lintTemplate(v.html);
  const recipients = await previewRecipients(db);
  const report = (v.sanitizeReport ?? null) as SanitizeReport | null;

  return (
    <main className="shell wide">
      <AppHeader staff={staff} />
      <p>
        <Link href="/templates">← Emails</Link>
      </p>
      <h1 className="page-title" data-testid="template-title">
        {t.template.name}
      </h1>
      <p className="muted" style={{ marginTop: 0 }} data-testid="version-info">
        Version <strong>{v.versionNo}</strong> · saved {fmtTime(v.createdAt)}{v.editor === "grapesjs" ? " (internal GrapesJS comparison)" : ""}
        {latest && latest.id !== v.id && <> · <Link href={`/templates/${id}`}>latest is v{latest.versionNo}</Link></>}
        {t.template.sourceFilename && <> · source {t.template.sourceFilename}</>}
      </p>

      <TemplateEditor
        templateId={id}
        versionId={v.id}
        versionNo={v.versionNo}
        regions={regions}
        recipients={recipients.map((r) => ({ id: r.id, label: r.label }))}
        mergeFields={Object.keys(MERGE_FIELDS)}
      />

      <div className="grid2">
        <section className="card" data-testid="lint-panel">
          <h2>Checks ({lint.findings.length})</h2>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            Static checks only: remote URLs are not fetched, and this is not a Gmail/Outlook/mobile rendering test.
          </p>
          <ul className="plain findings">
            {lint.findings.map((f, i) => (
              <li key={i}>
                <Pill tone={f.severity === "error" ? "bad" : f.severity === "warning" ? "warn" : undefined}>{f.severity}</Pill> <strong>{f.area}</strong>: {f.message}
                {f.detail && <div className="muted small">{f.detail}</div>}
              </li>
            ))}
          </ul>
        </section>

        <section className="card" data-testid="merge-panel">
          <h2>Merge fields ({lint.merge.uses.length})</h2>
          <table>
            <tbody>
              {lint.merge.uses.map((u, i) => (
                <tr key={i}>
                  <td>
                    <code>{u.raw}</code>
                  </td>
                  <td className="muted">{u.context}</td>
                  <td>{u.problem ? <Pill tone="bad">{u.problem.replace(/_/g, " ")}</Pill> : u.hasFallback ? <Pill tone="ok">fallback</Pill> : <Pill tone="warn">no fallback</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {lint.merge.uses.length === 0 && <p className="muted">None.</p>}
        </section>

        <section className="card" data-testid="images-panel">
          <h2>Images ({lint.images.length})</h2>
          <table>
            <tbody>
              {lint.images.map((im, i) => (
                <tr key={i}>
                  <td className="small" style={{ wordBreak: "break-all" }}>
                    <code>{im.src.slice(0, 90)}</code>
                    <div className="muted">alt: {im.alt ?? "(none)"}</div>
                  </td>
                  <td>{im.issues.length ? im.issues.map((x) => <div key={x} className="small">⚠ {x}</div>) : <Pill tone="ok">ok</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card" data-testid="links-panel">
          <h2>Links ({lint.links.length})</h2>
          <table>
            <tbody>
              {lint.links.map((l, i) => (
                <tr key={i}>
                  <td className="small" style={{ wordBreak: "break-all" }}>
                    {l.text || <em className="muted">(no text)</em>}
                    <div className="muted">
                      <code>{l.href.slice(0, 120)}</code>
                    </div>
                  </td>
                  <td>{l.issues.length ? l.issues.map((x) => <div key={x} className="small">⚠ {x}</div>) : <Pill tone="ok">ok</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card" data-testid="sanitize-panel">
          <h2>Sanitization on import/save</h2>
          {report ? (
            <ul className="plain small">
              <li>Removed elements: {Object.keys(report.removedElements).length ? Object.entries(report.removedElements).map(([k, n]) => `<${k}>×${n}`).join(", ") : "none"}</li>
              <li>Removed event-handler attributes: {report.removedEventHandlers}</li>
              <li>Blocked URLs: {report.blockedUrls.length ? report.blockedUrls.map((b) => `${b.tag}[${b.attr}]=${b.value}`).join("; ") : "none"}</li>
              <li>Meta refresh removed: {report.removedMetaRefresh}</li>
              <li>Unsafe CSS removed: {report.cleanedStyleAttributes} style attribute(s), {report.cleanedStyleBlocks} style block(s)</li>
              <li>Outlook conditional comments kept: {report.conditionalCommentsKept} (dropped as unsafe: {report.conditionalCommentsDropped})</li>
              <li>Ordinary HTML comments removed: {report.plainCommentsRemoved}</li>
              {report.extracted && <li>Imported only <code>{report.extracted.selector}</code> (found: {String(report.extracted.found)})</li>}
            </ul>
          ) : (
            <p className="muted">No report.</p>
          )}
        </section>

        <section className="card" data-testid="versions-panel">
          <h2>Versions</h2>
          <ul className="plain">
            {t.versions.map((x) => (
              <li key={x.id}>
                <Link href={`/templates/${id}?v=${x.id}`}>v{x.versionNo}</Link> · {fmtTime(x.createdAt)} {x.id === v.id && <Pill>viewing</Pill>}
                {x.note && <div className="muted small" data-testid={`version-note-${x.versionNo}`}>{x.note}</div>}
              </li>
            ))}
          </ul>
          <div className="row" style={{ marginTop: 8 }}>
            <a className="btn" href={`/templates/${id}/export?v=${v.id}`} data-testid="export-html">
              Export HTML (v{v.versionNo})
            </a>
            <a className="btn" href={`/templates/${id}/export?v=${v.id}&format=txt`} data-testid="export-txt">
              Export plain text
            </a>
          </div>
        </section>
      </div>
    </main>
  );
}
