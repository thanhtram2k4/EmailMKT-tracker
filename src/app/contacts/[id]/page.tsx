import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "../../../lib/auth/session";
import { consentHistory } from "../../../lib/crm/consent";
import { REASON_LABELS } from "../../../lib/crm/eligibility";
import { queryContacts } from "../../../lib/crm/queries";
import { getDb } from "../../../lib/db/client";
import { recordConsentAction } from "../../crm-actions";
import { AppShell } from "../../app-shell";
import { CONSENT_TONE, Flash, Pill, fmtTime } from "../../ui";

export const dynamic = "force-dynamic";

export default async function ContactDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const staff = await requireStaff();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = getDb();
  const c = (await queryContacts(db, { id, state: "all" }))[0];
  if (!c) notFound();
  const history = c.emailNormalized ? await consentHistory(db, c.emailNormalized) : [];

  return (
    <AppShell staff={staff}>
      <p>
        <Link href="/contacts">← Contacts</Link>
      </p>
      <Flash ok={sp.ok} error={sp.error} />
      <section className="card" data-testid="contact-detail">
        <h1 className="page-title">
          {c.fullName ?? <em className="muted">(no name)</em>}
        </h1>
        <div className="table-wrap" tabIndex={0}>
        <table>
          <tbody>
            <tr>
              <th>Greeting name</th>
              <td>{c.greetingName ?? <Pill tone="warn">missing — fallback will be used</Pill>}</td>
            </tr>
            <tr>
              <th>Email</th>
              <td>
                {c.email ?? "—"} {c.emailStatus !== "valid" && <Pill tone="bad">{c.emailStatus}{c.emailInvalidReason ? `: ${c.emailInvalidReason}` : ""}</Pill>}
                {c.emailNormalized && c.email !== c.emailNormalized && <span className="muted"> (normalized: {c.emailNormalized})</span>}
              </td>
            </tr>
            <tr>
              <th>Company</th>
              <td>{c.company ?? "—"}</td>
            </tr>
            <tr>
              <th>Tags</th>
              <td>{c.tags.join(", ") || "—"}</td>
            </tr>
            <tr>
              <th>State</th>
              <td>
                {c.state}
                {c.archivedReason && <span className="muted"> ({c.archivedReason.replace(/_/g, " ")})</span>}
              </td>
            </tr>
            <tr>
              <th>Eligibility</th>
              <td data-testid="eligibility">
                {c.eligible ? (
                  <Pill tone="ok">eligible</Pill>
                ) : (
                  <ul className="plain">
                    {c.reasons.map((r) => (
                      <li key={r}>{REASON_LABELS[r]}</li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
            <tr>
              <th>Suppression</th>
              <td data-testid="suppression">{c.suppressionReason ? <Pill tone="bad">{c.suppressionReason.replace(/_/g, " ")}</Pill> : "none"}</td>
            </tr>
            <tr>
              <th>Data issues</th>
              <td>{[...c.issues, ...(c.isDuplicate ? ["duplicate_email"] : [])].map((i) => <Pill key={i} tone="warn">{i.replace(/_/g, " ")}</Pill>)}{!c.issues.length && !c.isDuplicate && "none"}</td>
            </tr>
            <tr>
              <th>Notion</th>
              <td className="muted">
                Subscription status in Notion: <strong>{c.notionSubscriptionValue ?? "(blank)"}</strong> · last edited {fmtTime(c.notionLastEditedAt)} · synced {fmtTime(c.lastSyncedAt)}
                {c.notionUrl && (
                  <>
                    {" "}
                    · <a href={c.notionUrl} target="_blank" rel="noreferrer">open page</a>
                  </>
                )}
              </td>
            </tr>
          </tbody>
        </table>
        </div>
      </section>

      <section className="card" data-testid="consent-section">
        <h2>
          Marketing consent: <Pill tone={CONSENT_TONE[c.marketingConsent]}>{c.marketingConsent}</Pill>
        </h2>
        <p className="muted small mt0">
          Consent history for this address (append-only). Imports never grant consent. An evidence reference found in Notion
          {c.notionConsentEvidence ? (
            <>
              {" "}
              (<code data-testid="notion-evidence">{c.notionConsentEvidence}</code>)
            </>
          ) : null}{" "}
          must be checked by staff before recording consent.
        </p>
        <div className="table-wrap" tabIndex={0}>
          <table data-testid="consent-history">
            <thead>
              <tr>
                <th>Recorded</th>
                <th>Purpose</th>
                <th>Status</th>
                <th>Source</th>
                <th>Effective</th>
                <th>Evidence</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td className="muted">{fmtTime(h.recordedAt)}</td>
                  <td>{h.purpose.replace(/_/g, " ")}</td>
                  <td>
                    <Pill tone={CONSENT_TONE[h.status]}>{h.status}</Pill>
                  </td>
                  <td>{h.source.replace(/_/g, " ")}</td>
                  <td className="muted">{fmtTime(h.effectiveAt)}</td>
                  <td>
                    {h.evidenceRef && <code>{h.evidenceRef}</code>} <span className="muted">{h.evidenceNote}</span>
                  </td>
                  <td className="muted">{h.recordedBy}</td>
                </tr>
              ))}
              {history.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">
                    No records — status is unknown.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {staff.role === "admin" && c.emailNormalized && c.emailStatus === "valid" && (
          <form action={recordConsentAction} className="stack" data-testid="consent-form">
            <h3>Record consent (admin)</h3>
            <p className="muted small m0">
              Only record consent you can prove. A grant requires an evidence reference or note, and never lifts a suppression.
            </p>
            <input type="hidden" name="contactId" value={c.id} />
            <input type="hidden" name="email" value={c.emailNormalized} />
            <div className="row">
              <label>
                Purpose
                <select name="purpose" defaultValue="marketing_email">
                  <option value="marketing_email">Marketing email</option>
                  <option value="email_tracking">Email open/click tracking</option>
                </select>
              </label>
              <label>
                Status
                <select name="status" defaultValue="granted" data-testid="consent-status">
                  <option value="granted">Granted</option>
                  <option value="refused">Refused</option>
                  <option value="withdrawn">Withdrawn</option>
                </select>
              </label>
              <label>
                Effective date (Asia/Ho_Chi_Minh)
                <input type="date" name="effectiveAt" />
              </label>
            </div>
            <label>
              Evidence reference
              <input name="evidenceRef" placeholder="Form submission ID, signed document, ticket…" data-testid="consent-evidence" />
            </label>
            <label>
              Note
              <input name="evidenceNote" placeholder="How the evidence was checked" />
            </label>
            <label>
              Consent text version
              <input name="consentTextVersion" placeholder="e.g. privacy-notice-2026-01" />
            </label>
            <div>
              <button className="btn primary" type="submit" data-testid="consent-submit">
                Add consent record
              </button>
            </div>
          </form>
        )}
      </section>
    </AppShell>
  );
}
