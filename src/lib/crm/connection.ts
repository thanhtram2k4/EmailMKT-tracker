/**
 * Notion connection management: connect (token + database), map an existing database,
 * create the CRM database, disconnect. The token is never logged, echoed or stored in plain text.
 */
import { eq } from "drizzle-orm";
import { writeAudit } from "../audit";
import type { Db } from "../db/client";
import { notionConnection } from "../db/schema";
import { NotionApiError, type NotionClient } from "../notion/client";
import { NOTION_API_VERSION, type DataSource } from "../notion/types";
import { APP_FIELDS, CRM_DATABASE_MAPPING, CRM_DATABASE_PROPERTIES, suggestMapping, validateMapping, type AppField, type FieldMapping, type MappingValidation } from "./mapping";
import { clientForConnection, loadConnection, makeClient, sealToken, type NotionEnv, type StoredMapping } from "./notion-env";

/** Accepts a bare 32-hex id, a dashed UUID, or a Notion URL containing one. Returns a dashed UUID. */
export function parseNotionId(input: string): string | null {
  const s = input.trim();
  const m = s.match(/([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})(?![0-9a-f])/i);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}-${m[4]}-${m[5]}`.toLowerCase();
}

export function friendlyNotionError(e: unknown): string {
  if (e instanceof NotionApiError) {
    if (e.isAuthError) return "Notion rejected the token (401 unauthorized). Check the token of the internal connection.";
    if (e.isNotFound) return "Notion could not find that database or page (404). Make sure it is shared with the connection (••• → Connections).";
    if (e.status === 403) return "The connection lacks a capability for this action (403). Enable Read, Update and Insert content.";
    if (e.status === 429 || e.status === 529) return "Notion is rate limiting or overloaded; try again in a minute.";
    return `Notion error ${e.status} ${e.code}: ${e.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}

function typesFor(mapping: FieldMapping, ds: DataSource): Partial<Record<AppField, string>> {
  const out: Partial<Record<AppField, string>> = {};
  for (const f of Object.keys(APP_FIELDS) as AppField[]) {
    const p = mapping[f];
    if (p && ds.properties[p]) out[f] = ds.properties[p].type;
  }
  return out;
}

export type ConnectResult =
  | { ok: true; databaseTitle: string; dataSourceId: string; mapping: FieldMapping; validation: MappingValidation; dataSources: Array<{ id: string; name: string }> }
  | { ok: false; error: string };

async function describeDatabase(client: NotionClient, databaseId: string, dataSourceId?: string) {
  const db = await client.retrieveDatabase(databaseId);
  if (!db.data_sources?.length) throw new Error("This database has no data sources.");
  const chosen = dataSourceId ? db.data_sources.find((d) => d.id === dataSourceId) : db.data_sources[0];
  if (!chosen) throw new Error("The selected data source does not belong to this database.");
  const ds = await client.retrieveDataSource(chosen.id);
  const title = (db.title ?? []).map((t) => t.plain_text).join("") || "Untitled";
  return { db, ds, title, dataSources: db.data_sources };
}

/** Connect with a token and an existing database; stores a *suggested* mapping for admin review. */
export async function connectExistingDatabase(
  db: Db,
  env: NotionEnv,
  i: { token: string; databaseIdOrUrl: string; actor: string; correlationId?: string },
): Promise<ConnectResult> {
  const token = i.token.trim();
  if (!token) return { ok: false, error: "A token is required." };
  const databaseId = parseNotionId(i.databaseIdOrUrl);
  if (!databaseId) return { ok: false, error: "Could not find a database ID in that value." };
  const client = makeClient(env, token);
  try {
    const { ds, title, dataSources } = await describeDatabase(client, databaseId);
    const mapping = suggestMapping(ds);
    const validation = validateMapping(mapping, ds);
    const now = new Date();
    const values = {
      status: "connected" as const,
      tokenCiphertext: sealToken(token, env),
      tokenHint: token.slice(-4),
      apiVersion: NOTION_API_VERSION,
      databaseId,
      dataSourceId: ds.id,
      databaseTitle: title,
      mapping: { fields: mapping, types: typesFor(mapping, ds) } satisfies StoredMapping,
      connectedBy: i.actor,
      connectedAt: now,
      updatedAt: now,
      lastVerifiedAt: now,
      lastError: null,
    };
    await db.insert(notionConnection).values({ id: "default", ...values }).onConflictDoUpdate({ target: notionConnection.id, set: values });
    await writeAudit(db, {
      actor: i.actor,
      action: "crm.notion_connected",
      entityType: "notion_connection",
      entityId: databaseId,
      after: { databaseTitle: title, dataSourceId: ds.id, mappingValid: validation.ok },
      correlationId: i.correlationId,
    });
    return { ok: true, databaseTitle: title, dataSourceId: ds.id, mapping, validation, dataSources };
  } catch (e) {
    return { ok: false, error: friendlyNotionError(e) };
  }
}

/** Create the CRM database (fixed schema) under a parent page, and connect to it. */
export async function createCrmDatabase(
  db: Db,
  env: NotionEnv,
  i: { token: string; parentPageIdOrUrl: string; title?: string; actor: string; correlationId?: string },
): Promise<ConnectResult> {
  const token = i.token.trim();
  const parent = parseNotionId(i.parentPageIdOrUrl);
  if (!token) return { ok: false, error: "A token is required." };
  if (!parent) return { ok: false, error: "Could not find a page ID in that value." };
  const client = makeClient(env, token);
  const title = i.title?.trim() || "Email CRM contacts";
  try {
    // Not retried on 5xx/network errors (non-idempotent): a retry could create a second database.
    const created = await client.createDatabase({
      parent: { type: "page_id", page_id: parent },
      title: [{ type: "text", text: { content: title } }],
      initial_data_source: { properties: CRM_DATABASE_PROPERTIES },
    });
    const { ds, dataSources } = await describeDatabase(client, created.id);
    const mapping = { ...CRM_DATABASE_MAPPING };
    const validation = validateMapping(mapping, ds);
    const now = new Date();
    const values = {
      status: "connected" as const,
      tokenCiphertext: sealToken(token, env),
      tokenHint: token.slice(-4),
      apiVersion: NOTION_API_VERSION,
      databaseId: created.id,
      dataSourceId: ds.id,
      databaseTitle: title,
      mapping: { fields: mapping, types: typesFor(mapping, ds) } satisfies StoredMapping,
      connectedBy: i.actor,
      connectedAt: now,
      updatedAt: now,
      lastVerifiedAt: now,
      lastError: null,
    };
    await db.insert(notionConnection).values({ id: "default", ...values }).onConflictDoUpdate({ target: notionConnection.id, set: values });
    await writeAudit(db, {
      actor: i.actor,
      action: "crm.notion_database_created",
      entityType: "notion_connection",
      entityId: created.id,
      after: { title, parentPageId: parent, dataSourceId: ds.id },
      correlationId: i.correlationId,
    });
    return { ok: true, databaseTitle: title, dataSourceId: ds.id, mapping, validation, dataSources };
  } catch (e) {
    return { ok: false, error: friendlyNotionError(e) };
  }
}

/** Validate and save an admin-reviewed mapping against the live data-source schema. */
export async function saveMapping(db: Db, env: NotionEnv, i: { mapping: FieldMapping; actor: string; correlationId?: string }) {
  const c = await clientForConnection(db, env);
  if (!c) return { ok: false as const, error: "Notion is not connected." };
  try {
    const ds = await c.client.retrieveDataSource(c.conn.dataSourceId!);
    const clean: FieldMapping = {};
    for (const f of Object.keys(APP_FIELDS) as AppField[]) if (i.mapping[f]) clean[f] = i.mapping[f];
    const validation = validateMapping(clean, ds);
    if (!validation.ok) return { ok: false as const, error: validation.errors.join("; "), validation };
    await db
      .update(notionConnection)
      .set({ mapping: { fields: clean, types: typesFor(clean, ds) }, updatedAt: new Date(), lastVerifiedAt: new Date(), lastError: null })
      .where(eq(notionConnection.id, "default"));
    await writeAudit(db, {
      actor: i.actor,
      action: "crm.mapping_saved",
      entityType: "notion_connection",
      entityId: c.conn.databaseId ?? undefined,
      before: c.mapping.fields,
      after: clean,
      correlationId: i.correlationId,
    });
    return { ok: true as const, validation };
  } catch (e) {
    return { ok: false as const, error: friendlyNotionError(e) };
  }
}

/** Remove the stored token. Contacts, suppressions and consent history are kept. */
export async function disconnectNotion(db: Db, i: { actor: string; correlationId?: string }) {
  const conn = await loadConnection(db);
  if (!conn) return false;
  await db
    .update(notionConnection)
    .set({ status: "disconnected", tokenCiphertext: null, tokenHint: null, updatedAt: new Date() })
    .where(eq(notionConnection.id, "default"));
  await writeAudit(db, {
    actor: i.actor,
    action: "crm.notion_disconnected",
    entityType: "notion_connection",
    entityId: conn.databaseId ?? undefined,
    correlationId: i.correlationId,
  });
  return true;
}

/** Current data-source schema + validation of the stored mapping (for the settings screen). */
export async function inspectConnection(db: Db, env: NotionEnv) {
  const c = await clientForConnection(db, env);
  if (!c) return null;
  try {
    const ds = await c.client.retrieveDataSource(c.conn.dataSourceId!);
    return { conn: c.conn, mapping: c.mapping, dataSource: ds, validation: validateMapping(c.mapping.fields, ds), error: null as string | null };
  } catch (e) {
    return { conn: c.conn, mapping: c.mapping, dataSource: null, validation: null, error: friendlyNotionError(e) };
  }
}
