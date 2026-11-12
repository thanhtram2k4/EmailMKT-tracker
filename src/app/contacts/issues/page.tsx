import Link from "next/link";
import { requireStaff } from "../../../lib/auth/session";
import { duplicateGroups, queryContacts, syncOverview } from "../../../lib/crm/queries";
import { getDb } from "../../../lib/db/client";
import { choosePrimaryAction, clearPrimaryAction } from "../../crm-actions";
import { AppShell } from "../../app-shell";
import { Flash, Pill } from "../../ui";

export const dynamic = "force-dynamic";

export default async function DataIssues({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const staff = await requireStaff();
  const sp = await searchParams;
  const db = getDb();
  const [groups, invalid, missingGreeting, changed, overview] = await Promise.all([
    duplicateGroups(db),
    queryContacts(db, { issue: "any" }).then((r) => r.filter((c) => c.emailStatus !== "valid")),
    queryContacts(db, { issue: "greeting_name_missing" }),
    queryContacts(db, { issue: "email_changed_from_suppressed", state: "all" }),
    syncOverview(db),
  ]);
  const admin = staff.role === "admin";

  return (
    <AppShell staff={staff} wide>
      <h1 className="page-title">Data issues</h1>
      <Flash ok={sp.ok} error={sp.error} />
      <p className="muted mt0">
        Fix names, emails and duplicates in Notion. The app never edits or deletes Notion pages for these issues.
      </p>

      <section className="card" data-testid="duplicates">
        <h2>Duplicate emails ({groups.length} groups)</h2>
        <p className="muted small mt0">
          Until a primary contact is chosen, every page in the group is excluded from audiences.
        </p>
        {groups.map((g) => (
          <div key={g.email} className="group" data-testid="duplicate-group">
            <div className="row">
              <strong>{g.email}</strong> {g.resolved ? <Pill tone="ok">primary chosen</Pill> : <Pill tone="warn">unresolved</Pill>}
              {admin && g.resolved && (
                <form action={clearPrimaryAction}>
                  <input type="hidden" name="email" value={g.email} />
                  <button className="btn" type="submit">
                    Clear choice
                  </button>
                </form>
              )}
            </div>
            <div className="table-wrap" tabIndex={0}>
            <table>
              <tbody>
                {g.members.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <Link href={`/contacts/${m.id}`}>{m.fullName ?? "(no name)"}</Link>
                    </td>
                    <td>{m.email}</td>
                    <td>{m.duplicateResolution === "primary" ? <Pill tone="ok">primary</Pill> : m.duplicateResolution === "secondary" ? <Pill>secondary</Pill> : null}</td>
                    <td>
                      {admin && m.duplicateResolution !== "primary" && (
                        <form action={choosePrimaryAction}>
                          <input type="hidden" name="contactId" value={m.id} />
                          <button className="btn" type="submit" data-testid="choose-primary">
                            Make primary
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        ))}
        {groups.length === 0 && <p className="muted">None.</p>}
      </section>

      <section className="card" data-testid="invalid-emails">
        <h2>Invalid or missing email ({invalid.length})</h2>
        <div className="table-wrap" tabIndex={0}>
        <table>
          <tbody>
            {invalid.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link href={`/contacts/${c.id}`}>{c.fullName ?? "(no name)"}</Link>
                </td>
                <td>
                  <code>{c.email ?? "(empty)"}</code>
                </td>
                <td>
                  <Pill tone="bad">{c.emailInvalidReason ?? c.emailStatus}</Pill>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </section>

      <section className="card" data-testid="missing-greeting">
        <h2>Missing greeting name ({missingGreeting.length})</h2>
        <p className="muted small mt0">
          These contacts will receive the fallback greeting (configured per template in M4).
        </p>
        <p>
          {missingGreeting.map((c, i) => (
            <span key={c.id}>
              {i > 0 && ", "}
              <Link href={`/contacts/${c.id}`}>{c.fullName ?? c.email ?? "(no name)"}</Link>
            </span>
          ))}
        </p>
      </section>

      {changed.length > 0 && (
        <section className="card" data-testid="email-changed">
          <h2>Email changed away from a suppressed address ({changed.length})</h2>
          <p className="muted small mt0">
            The old address stays suppressed; the new address is not. Check that this is a genuine change, not a way around an unsubscribe.
          </p>
          <ul>
            {changed.map((c) => (
              <li key={c.id}>
                <Link href={`/contacts/${c.id}`}>{c.fullName}</Link> → {c.email}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card" data-testid="sync-page-issues">
        <h2>Problems found by the latest sync ({overview.latestIssues.length})</h2>
        <div className="table-wrap" tabIndex={0}>
        <table>
          <tbody>
            {overview.latestIssues.map((i) => (
              <tr key={i.id}>
                <td>
                  <Pill tone={i.severity === "error" ? "bad" : "warn"}>{i.severity}</Pill>
                </td>
                <td>
                  <code>{i.code}</code>
                </td>
                <td>{i.message}</td>
                <td className="muted">
                  <code>{i.notionPageId}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        {overview.latestIssues.length === 0 && <p className="muted">None.</p>}
      </section>
    </AppShell>
  );
}
