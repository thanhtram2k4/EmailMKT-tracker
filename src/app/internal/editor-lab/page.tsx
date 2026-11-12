import Link from "next/link";
import { getDb } from "../../../lib/db/client";
import { requireInternalTools } from "../../../lib/internal-tools";
import { FIXTURES } from "../../../lib/templates/fixtures";
import { listTemplates } from "../../../lib/templates/service";
import { AppShell } from "../../app-shell";
import { Flash } from "../../ui";
import { importFixtureAction } from "./actions";

export const dynamic = "force-dynamic";

/** INTERNAL test tooling. Not linked from the product UI; 404 outside APP_ENV local/test. */
export default async function EditorLabPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const staff = await requireInternalTools();
  const sp = await searchParams;
  const rows = await listTemplates(getDb());
  return (
    <AppShell staff={staff} wide>
      <h1 className="page-title">INTERNAL · Editor lab</h1>
      <Flash error={sp.error} />
      <div className="banner warn" data-testid="lab-banner">
        Internal test tooling, available only when APP_ENV is local or test. It is not part of the user workflow; users import their own HTML on the Emails page.
      </div>
      <section className="card">
        <h2>Labelled internal fixtures</h2>
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
      <section className="card table-wrap" tabIndex={0}>
        <h2>GrapesJS comparison (candidate b)</h2>
        <table data-testid="lab-table">
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td>
                  <Link href={`/internal/editor-lab/${t.id}/grapesjs`} data-testid={`lab-grapes-${t.id}`}>
                    Open latest version in GrapesJS
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </AppShell>
  );
}
