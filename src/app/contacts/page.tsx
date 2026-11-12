import Link from "next/link";
import { requireStaff } from "../../lib/auth/session";
import { allTags, contactStats, getRequireConsent, queryContacts, type ContactFilters } from "../../lib/crm/queries";
import { getDb } from "../../lib/db/client";
import { AppShell } from "../app-shell";
import { CONSENT_TONE, Pill, ReasonList } from "../ui";

export const dynamic = "force-dynamic";
const PAGE_SIZE = 50;

type SP = Record<string, string | undefined>;

export default async function ContactsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const staff = await requireStaff();
  const sp = await searchParams;
  const db = getDb();
  const filters: ContactFilters = {
    q: sp.q,
    tag: sp.tag || undefined,
    state: (sp.state as ContactFilters["state"]) || "active",
    issue: (sp.issue as ContactFilters["issue"]) || undefined,
    suppressed: (sp.suppressed as ContactFilters["suppressed"]) || undefined,
    consent: (sp.consent as ContactFilters["consent"]) || undefined,
    eligible: (sp.eligible as ContactFilters["eligible"]) || undefined,
  };
  const [rows, stats, tags, requireConsent] = await Promise.all([queryContacts(db, filters), contactStats(db), allTags(db), getRequireConsent(db)]);
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const shown = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const qs = (patch: SP) => {
    const p = new URLSearchParams(Object.entries({ ...sp, ...patch }).filter(([, v]) => v) as Array<[string, string]>);
    return `/contacts?${p.toString()}`;
  };

  return (
    <AppShell staff={staff} wide>
      <h1 className="page-title">Contacts</h1>
      <p className="muted mt0">
        Read-only copy of the Notion CRM. Edit names, emails, companies and tags in Notion; suppression and consent are managed by this app.
      </p>
      <div className="stats" data-testid="contact-stats">
        <span>
          <strong>{stats.active}</strong> active
        </span>
        <span>
          <strong>{stats.duplicates}</strong> duplicates
        </span>
        <span>
          <strong>{stats.invalid + stats.missing}</strong> invalid/missing email
        </span>
        <span>
          <strong>{stats.missing_greeting}</strong> missing greeting
        </span>
        <span>
          <strong>{stats.suppressions}</strong> suppressed addresses
        </span>
        <span>
          <strong>{stats.archived}</strong> archived
        </span>
      </div>
      {requireConsent && (
        <div className="banner warn" data-testid="consent-policy-banner">
          Recorded marketing consent is required for eligibility (default, pending legal review). Imported contacts start as <strong>unknown</strong>.
        </div>
      )}

      <form className="card filters" method="get" action="/contacts">
        <label>
          Search
          <input name="q" defaultValue={sp.q} placeholder="name, email, company" data-testid="filter-q" />
        </label>
        <label>
          Tag
          <select name="tag" defaultValue={sp.tag ?? ""}>
            <option value="">Any</option>
            {tags.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          State
          <select name="state" defaultValue={filters.state}>
            <option value="active">Active</option>
            <option value="archived">Archived</option>
            <option value="all">All</option>
          </select>
        </label>
        <label>
          Issue
          <select name="issue" defaultValue={sp.issue ?? ""} data-testid="filter-issue">
            <option value="">Any or none</option>
            <option value="any">Has an issue</option>
            <option value="duplicate">Duplicate email</option>
            <option value="email_invalid">Invalid email</option>
            <option value="email_missing">Missing email</option>
            <option value="greeting_name_missing">Missing greeting name</option>
            <option value="full_name_missing">Missing full name</option>
            <option value="email_changed_from_suppressed">Email changed from suppressed</option>
          </select>
        </label>
        <label>
          Suppressed
          <select name="suppressed" defaultValue={sp.suppressed ?? ""}>
            <option value="">Any</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
        <label>
          Consent
          <select name="consent" defaultValue={sp.consent ?? ""}>
            <option value="">Any</option>
            <option value="unknown">Unknown</option>
            <option value="granted">Granted</option>
            <option value="withdrawn">Withdrawn</option>
            <option value="refused">Refused</option>
          </select>
        </label>
        <label>
          Eligible
          <select name="eligible" defaultValue={sp.eligible ?? ""}>
            <option value="">Any</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
        <div className="row">
          <button className="btn primary" type="submit" data-testid="filter-apply">
            Apply
          </button>
          <Link href="/contacts">Reset</Link>
        </div>
      </form>

      <p className="muted" data-testid="result-count">
        {rows.length} contact{rows.length === 1 ? "" : "s"} · page {page} of {pages}
      </p>
      <div className="card table-wrap" tabIndex={0}>
        <table data-testid="contacts-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Greeting</th>
              <th>Email</th>
              <th>Company</th>
              <th>Tags</th>
              <th>Consent</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => (
              <tr key={c.id} data-testid="contact-row">
                <td>
                  <Link href={`/contacts/${c.id}`}>{c.fullName ?? <em className="muted">(no name)</em>}</Link>
                </td>
                <td>{c.greetingName ?? <span className="muted">—</span>}</td>
                <td>
                  {c.email ?? <span className="muted">—</span>}
                  {c.emailStatus === "invalid" && (
                    <>
                      {" "}
                      <Pill tone="bad">{c.emailInvalidReason}</Pill>
                    </>
                  )}
                </td>
                <td>{c.company ?? <span className="muted">—</span>}</td>
                <td className="muted">{c.tags.join(", ")}</td>
                <td>
                  <Pill tone={CONSENT_TONE[c.marketingConsent]}>{c.marketingConsent}</Pill>
                </td>
                <td>
                  <ReasonList reasons={c.reasons} />
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  No contacts match. If nothing has been synced yet, connect Notion in Notion settings and run a sync.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <nav className="row">
          {page > 1 && <Link href={qs({ page: String(page - 1) })}>← Previous</Link>}
          {page < pages && <Link href={qs({ page: String(page + 1) })}>Next →</Link>}
        </nav>
      )}
    </AppShell>
  );
}
