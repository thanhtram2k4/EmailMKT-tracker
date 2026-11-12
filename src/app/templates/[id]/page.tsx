import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Search, UserRound } from "lucide-react";
import { requireStaff } from "../../../lib/auth/session";
import { getConfig } from "../../../lib/config";
import { getDb } from "../../../lib/db/client";
import { maskEmail } from "../../../lib/redact";
import { listTestSends, testSendAvailability } from "../../../lib/sending/test-send";
import { regionsOf } from "../../../lib/templates/editable";
import { lintTemplate } from "../../../lib/templates/lint";
import { MERGE_FIELDS, SAMPLE_RECIPIENTS, renderSubject, scanSubject } from "../../../lib/templates/merge";
import { personalizationCheck, previewRecipients } from "../../../lib/templates/recipients";
import type { SanitizeReport } from "../../../lib/templates/sanitize";
import { getTemplate, getVersion } from "../../../lib/templates/service";
import { AppShell } from "../../app-shell";
import { saveSubjectAction } from "../../test-send-actions";
import { Flash, Pill, fmtTime } from "../../ui";
import { TemplateEditor } from "./template-editor";
import { TestSendPanel } from "./test-send-panel";

export const dynamic = "force-dynamic";

export default async function TemplatePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ v?: string; q?: string; ok?: string; error?: string }> }) {
  const staff = await requireStaff();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = getDb();
  const cfg = getConfig();
  const t = await getTemplate(db, id);
  if (!t) notFound();
  const v = await getVersion(db, id, sp.v);
  if (!v) notFound();
  const latest = t.versions[0];
  const regions = regionsOf(v.html);
  const lint = lintTemplate(v.html);
  const q = (sp.q ?? "").trim();
  const recipients = await previewRecipients(db, q || undefined);
  const report = (v.sanitizeReport ?? null) as SanitizeReport | null;
  const subjectProblems = v.subject ? scanSubject(v.subject) : [];
  const check = await personalizationCheck(db, { subject: v.subject, html: v.html });
  const versionNoById = new Map(t.versions.map((x) => [x.id, x.versionNo]));
  const history = (await listTestSends(db, id)).map((h) => ({
    id: h.id,
    recipient: maskEmail(h.recipientEmail),
    status: h.status,
    subject: h.renderedSubject,
    mergeSource: h.mergeSource,
    versionNo: versionNoById.get(h.templateVersionId) ?? null,
    providerMessageId: h.providerMessageId,
    error: h.errorMessage,
    createdAt: fmtTime(h.createdAt),
    transport: h.transport,
    resendOf: h.resendOf,
  }));

  return (
    <AppShell staff={staff} wide>
      <div className="page-header">
        <div>
          <Link href="/templates" className="back-link">
            <ArrowLeft className="icon-sm" aria-hidden /> Emails
          </Link>
          <h1 className="page-title" data-testid="template-title">
            {t.template.name}
          </h1>
          <p className="page-sub" data-testid="version-info">
            Version <strong>{v.versionNo}</strong> · saved {fmtTime(v.createdAt)}{v.editor === "grapesjs" ? " (internal GrapesJS comparison)" : ""}
            {latest && latest.id !== v.id && <> · <Link href={`/templates/${id}`}>latest is v{latest.versionNo}</Link></>}
            {t.template.sourceFilename && <> · source {t.template.sourceFilename}</>}
          </p>
        </div>
      </div>
      <Flash ok={sp.ok} error={sp.error} />

      <section className="card subject-card" data-testid="subject-card">
        <h2>Subject</h2>
        <form action={saveSubjectAction} className="subject-row">
          <input type="hidden" name="templateId" value={id} />
          <input type="hidden" name="baseVersionId" value={v.id} />
          <label className="field subject-field">
            <span>
              Subject line (merge fields allowed, e.g. <code>{'{{ greeting_name | default: "bạn" }}'}</code>)
            </span>
            <input name="subject" defaultValue={v.subject ?? ""} maxLength={200} required placeholder="Bản tin tháng 11 dành cho {{ company | default: &quot;quý khách&quot; }}" data-testid="subject-input" />
          </label>
          <button className="btn" type="submit" data-testid="subject-save">
            Save subject (new version)
          </button>
        </form>
        <p className="muted small">Saving the subject stores a new version with the same content. Unsaved edits in the editor below are not included, so save them first.</p>
        {!v.subject && (
          <div className="banner warn small" data-testid="subject-missing">
            This version has no subject yet.
          </div>
        )}
        {subjectProblems.length > 0 && (
          <div className="banner bad small" data-testid="subject-problems">
            <strong>Subject problems:</strong>
            <ul className="plain">
              {subjectProblems.map((p, i) => (
                <li key={i}>
                  <code>{p.raw}</code> — {p.error}
                </li>
              ))}
            </ul>
          </div>
        )}
        {v.subject && (
          <ul className="subject-preview small" data-testid="subject-preview">
            {SAMPLE_RECIPIENTS.map((r) => {
              const out = renderSubject(v.subject!, r.data);
              return (
                <li key={r.id} data-sample={r.id}>
                  <span className="muted">{r.label}:</span> <strong>{out.subject}</strong>{" "}
                  {out.missingWithoutFallback.length > 0 && <Pill tone="bad">missing {out.missingWithoutFallback.join(", ")}</Pill>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <form method="get" className="preview-search" data-testid="preview-search">
        <input type="hidden" name="v" value={v.id} />
        <label className="field">
          Find a contact to preview as
          <input type="search" name="q" defaultValue={q} placeholder="name, email or company" data-testid="preview-search-q" />
        </label>
        <button className="btn" type="submit" data-testid="preview-search-submit">
          <Search className="icon-sm" aria-hidden /> Search
        </button>
        <span className="muted small">
          <UserRound className="icon-sm" aria-hidden /> {recipients.length - SAMPLE_RECIPIENTS.length} contact(s){q ? ` matching “${q}”` : ""} in the preview list. Searching reloads the page, so save edits first.
        </span>
      </form>

      <TemplateEditor
        templateId={id}
        versionId={v.id}
        versionNo={v.versionNo}
        regions={regions}
        recipients={recipients.map((r) => ({ id: r.id, label: r.label }))}
        mergeFields={Object.keys(MERGE_FIELDS)}
      />

      <div className="grid2">
        <section className="card" data-testid="personalization-check">
          <h2>Personalization check</h2>
          <p className="muted small mt0">
            Checked against {check.checked} active contact(s) with a valid email. Fields used without a fallback:{" "}
            {check.fieldsNeedingValues.length ? check.fieldsNeedingValues.join(", ") : "none"}.
          </p>
          {check.blocking.length > 0 && (
            <div className="banner bad small" data-testid="personalization-blocking">
              <strong>Blocks sending:</strong>
              <ul className="plain">
                {check.blocking.map((b, i) => (
                  <li key={i}>
                    {b.where}: {b.raw && <code>{b.raw}</code>} {b.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {check.affected.length === 0 ? (
            <p className="small" data-testid="personalization-ok">
              <Pill tone="ok">ok</Pill> No contact is missing a value that has no fallback.
            </p>
          ) : (
            <>
              <p className="small" data-testid="personalization-affected-count">
                <Pill tone="warn">{check.affected.length}</Pill> contact(s) would get an unresolved field. Add a <code>default:</code> fallback or fix the data in Notion.
              </p>
              <div className="table-wrap" tabIndex={0}>
                <table data-testid="personalization-affected">
                  <tbody>
                    {check.affected.slice(0, 50).map((a) => (
                      <tr key={a.id}>
                        <td>
                          <Link href={`/contacts/${a.id}`}>{a.name}</Link>
                        </td>
                        <td className="small">missing: {a.missing.join(", ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {check.affected.length > 50 && <p className="muted small">…and {check.affected.length - 50} more.</p>}
            </>
          )}
        </section>

        <TestSendPanel
          templateId={id}
          versionId={v.id}
          versionNo={v.versionNo}
          hasSubject={Boolean(v.subject)}
          recipients={recipients.map((r) => ({ id: r.id, label: r.label }))}
          defaultMergeSource={SAMPLE_RECIPIENTS[0].id}
          availability={testSendAvailability(cfg)}
          sendMode={cfg.SEND_MODE}
          allowlistCount={cfg.TEST_RECIPIENT_ALLOWLIST.length}
          initialKey={randomUUID()}
          resendKey={randomUUID()}
          history={history}
        />
      </div>

      <div className="grid2 mt3">
        <section className="card" data-testid="lint-panel">
          <h2>Checks ({lint.findings.length})</h2>
          <p className="muted small mt0">
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
                  <td className="small break-all">
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
                  <td className="small break-all">
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
          <div className="row mt2">
            <a className="btn" href={`/templates/${id}/export?v=${v.id}`} data-testid="export-html">
              Export HTML (v{v.versionNo})
            </a>
            <a className="btn" href={`/templates/${id}/export?v=${v.id}&format=txt`} data-testid="export-txt">
              Export plain text
            </a>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
