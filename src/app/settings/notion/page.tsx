import { requireRole } from "../../../lib/auth/session";
import { getConfig } from "../../../lib/config";
import { inspectConnection } from "../../../lib/crm/connection";
import { APP_FIELDS, type AppField } from "../../../lib/crm/mapping";
import { NotionDisabledError, loadConnection, notionEnvFromConfig } from "../../../lib/crm/notion-env";
import { getDb } from "../../../lib/db/client";
import { NOTION_API_VERSION } from "../../../lib/notion/types";
import { connectNotionAction, createCampaignsDatabaseAction, createDatabaseAction, disconnectNotionAction, saveMappingAction } from "../../crm-actions";
import { AppShell } from "../../app-shell";
import { Flash, Pill, fmtTime } from "../../ui";

export const dynamic = "force-dynamic";

export default async function NotionSettings({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const staff = await requireRole("admin");
  const sp = await searchParams;
  const cfg = getConfig();
  const db = getDb();
  let info: Awaited<ReturnType<typeof inspectConnection>> = null;
  let disabled = false;
  try {
    info = await inspectConnection(db, notionEnvFromConfig(cfg));
  } catch (e) {
    if (e instanceof NotionDisabledError) disabled = true;
    else throw e;
  }
  const conn = info?.conn ?? (await loadConnection(db));

  return (
    <AppShell staff={staff}>
      <h1 className="page-title">Notion settings</h1>
      <Flash ok={sp.ok} error={sp.error} />

      <section className="card" data-testid="notion-mode">
        <p className="m0">
          <code>NOTION_MODE={cfg.NOTION_MODE}</code> · API version <code>{NOTION_API_VERSION}</code>
          {cfg.notionBaseUrl && (
            <>
              {" "}
              · <code>{cfg.notionBaseUrl}</code>
            </>
          )}
        </p>
        {disabled && <p className="muted">Notion access is disabled. Set NOTION_MODE=mock (local synthetic data) or, with a recorded authorization, NOTION_MODE=live.</p>}
        {cfg.NOTION_MODE === "mock" && (
          <p className="muted small" data-testid="mock-hint">
            Local mock server with <strong>synthetic</strong> contacts. Token: <code>mock-notion-token-not-a-secret</code> · database ID{" "}
            <code>11111111-2222-4333-8444-555555555555</code> · parent page for “Create CRM database”: <code>99999999-8888-4777-8666-555555555555</code>
          </p>
        )}
      </section>

      {!disabled && (
        <section className="card" data-testid="connection">
          <h2>Connection</h2>
          {conn?.status === "connected" ? (
            <>
              <p>
                Connected to <strong>{conn.databaseTitle}</strong> · data source <code>{conn.dataSourceId}</code> · token ending <code>…{conn.tokenHint}</code> · by{" "}
                {conn.connectedBy} on {fmtTime(conn.connectedAt)}
              </p>
              {conn.lastError && <div className="banner bad">{conn.lastError}</div>}
              {info?.error && <div className="banner bad">{info.error}</div>}
              <form action={disconnectNotionAction}>
                <button className="btn" type="submit" data-testid="disconnect">
                  Disconnect (deletes the stored token)
                </button>
              </form>
            </>
          ) : (
            <p className="muted">Not connected.</p>
          )}
        </section>
      )}

      {conn?.status === "connected" && (
        <section className="card" data-testid="campaigns-database">
          <h2>Email Campaigns database (summaries)</h2>
          {conn.campaignsDataSourceId ? (
            <p className="small m0" data-testid="campaigns-database-connected">
              Connected · data source <code>{conn.campaignsDataSourceId}</code>. Each finished campaign gets one summary page, updated on completion, +24 h, +72 h and +7 days. Contacts&apos;
              “Last emailed” and “Last engagement” are written back when those properties are mapped.
            </p>
          ) : (
            <form action={createCampaignsDatabaseAction} className="row">
              <label>
                Parent page (ID or URL, shared with the integration)
                <input name="parent" required data-testid="campaigns-parent" />
              </label>
              <label>
                Title
                <input name="title" placeholder="Email Campaigns" />
              </label>
              <button className="btn" type="submit" data-testid="create-campaigns-database">
                Create Email Campaigns database
              </button>
            </form>
          )}
        </section>
      )}

      {info?.dataSource && (
        <section className="card" data-testid="mapping">
          <h2>Field mapping</h2>
          {info.validation && !info.validation.ok && (
            <div className="banner bad" data-testid="mapping-errors">
              {info.validation.errors.join(" · ")}
            </div>
          )}
          {info.validation?.warnings.map((w) => (
            <div key={w} className="banner warn">
              {w}
            </div>
          ))}
          <form action={saveMappingAction}>
            <div className="table-wrap" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th>App field</th>
                  <th>Owner</th>
                  <th>Notion property</th>
                </tr>
              </thead>
              <tbody>
                {(Object.keys(APP_FIELDS) as AppField[]).map((f) => {
                  const def = APP_FIELDS[f];
                  const options = Object.values(info!.dataSource!.properties).filter((p) => (def.types as readonly string[]).includes(p.type));
                  return (
                    <tr key={f}>
                      <td>
                        {def.label} {def.required && <Pill>required</Pill>}
                      </td>
                      <td className="muted">{def.owner === "notion" ? "Notion → app" : "app → Notion"}</td>
                      <td>
                        <select name={`map_${f}`} aria-label={`Notion property for ${def.label}`} defaultValue={info!.mapping.fields[f] ?? ""} data-testid={`map-${f}`}>
                          <option value="">(not mapped)</option>
                          {options.map((p) => (
                            <option key={p.name} value={p.name}>
                              {p.name} ({p.type})
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
            <p className="muted small">
              App-owned columns are mirrors: the app writes Subscription status (and, later, Last emailed / Last engagement). A person setting Unsubscribed,
              Bounced or Complained in Notion adds a suppression; setting Subscribed never removes one and never counts as consent.
            </p>
            <button className="btn primary" type="submit" data-testid="save-mapping">
              Save mapping
            </button>
          </form>
        </section>
      )}

      {!disabled && (
        <>
          <section className="card">
            <h2>{conn?.status === "connected" ? "Reconnect / switch database" : "Connect an existing database"}</h2>
            <form action={connectNotionAction} className="stack" autoComplete="off">
              <label>
                Internal connection token
                <input name="token" type="password" required autoComplete="off" data-testid="notion-token" />
              </label>
              <label>
                Database URL or ID
                <input name="database" required data-testid="notion-database" />
              </label>
              <div>
                <button className="btn primary" type="submit" data-testid="connect">
                  Connect
                </button>
              </div>
              <p className="muted small m0">
                The token is encrypted (AES-256-GCM) before it is stored and is never shown again. Do not paste it into chat, tickets or Git.
              </p>
            </form>
          </section>
          <section className="card">
            <h2>Create the CRM database</h2>
            <form action={createDatabaseAction} className="stack" autoComplete="off">
              <label>
                Internal connection token
                <input name="token" type="password" required autoComplete="off" />
              </label>
              <label>
                Parent page URL or ID (shared with the connection)
                <input name="parent" required />
              </label>
              <label>
                Database title
                <input name="title" defaultValue="Email CRM contacts" />
              </label>
              <div>
                <button className="btn" type="submit">
                  Create and connect
                </button>
              </div>
            </form>
          </section>
        </>
      )}
    </AppShell>
  );
}
