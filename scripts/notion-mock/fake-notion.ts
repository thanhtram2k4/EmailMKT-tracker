/**
 * In-memory FAKE of the subset of the Notion API (2026-03-11) used by the CRM sync.
 * For automated tests (as an injected `fetch`) and for local manual testing (served over HTTP
 * by scripts/notion-mock/server.ts). Holds SYNTHETIC data only. Never connects to Notion.
 *
 * Simulated behaviours (from developers.notion.com, verified 2026-11-12, see docs/NOTION_SETUP.md):
 *  - Bearer auth (401 unauthorized), required Notion-Version header (400 missing_version);
 *  - POST /v1/data_sources/{id}/query with last_edited_time timestamp filter + sort, page_size <= 100,
 *    cursor pagination, and the 10,000-result cap (has_more=false + request_status "incomplete");
 *  - PATCH /v1/pages/{id} property updates (bumps last_edited_time; new select options auto-added);
 *  - POST /v1/databases with initial_data_source.properties;
 *  - error bodies { object:"error", status, code, message, request_id }, Retry-After on 429/529.
 * Configurable (behaviour the docs leave UNVERIFIED): whether trashed pages appear in queries,
 * and rounding of last_edited_time to the minute (default on, the conservative assumption).
 */
import { randomUUID } from "node:crypto";
import type { Database, DataSource, Page, PropertySchema, PropertyValue } from "../../src/lib/notion/types";

export const FAKE_NOTION_VERSION = "2026-03-11";

export type Fault = {
  method?: string;
  /** Substring of the request path to match. */
  pathIncludes?: string;
  /** Skip this many matching requests before the fault starts firing. */
  skip?: number;
  /** How many matching requests fail (default 1). */
  times?: number;
  status?: number;
  code?: string;
  retryAfterSeconds?: number;
  /** Simulate a transport failure (fetch rejects) instead of an HTTP error. */
  network?: boolean;
  /** Apply the request (e.g. a PATCH) and then fail — models "may already be saved". */
  applyThenFail?: boolean;
};

type StoredPage = {
  id: string;
  dataSourceId: string;
  createdMs: number;
  editedMs: number;
  inTrash: boolean;
  properties: Record<string, PropertyValue>;
};

export type FakeOptions = {
  token?: string;
  now?: () => number;
  roundEditedToMinute?: boolean;
  queryIncludesTrashed?: boolean;
  maxQueryResults?: number;
  /** If set, the fake itself enforces a request rate (sliding 1 s window) and returns 429. */
  enforceRps?: number;
};

export type RequestLogEntry = { method: string; path: string; status: number; at: number; body?: unknown };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const err = (status: number, code: string, message: string, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
  json(status, { object: "error", status, code, message, request_id: randomUUID(), ...extra }, headers);

const nid = () => randomUUID();

export class FakeNotion {
  token: string;
  now: () => number;
  roundEditedToMinute: boolean;
  queryIncludesTrashed: boolean;
  maxQueryResults: number;
  enforceRps?: number;
  readonly databases = new Map<string, { id: string; title: string; parentPageId: string; dataSourceIds: string[] }>();
  readonly dataSources = new Map<string, { id: string; databaseId: string; title: string; properties: Record<string, PropertySchema> }>();
  readonly pages = new Map<string, StoredPage>();
  /** Pages the integration may create databases under. */
  readonly parentPages = new Set<string>();
  readonly requests: RequestLogEntry[] = [];
  faults: Fault[] = [];
  private faultHits = new Map<Fault, number>();
  private recent: number[] = [];
  private clockSkewMs = 0;

  constructor(opts: FakeOptions = {}) {
    this.token = opts.token ?? "mock-notion-token-not-a-secret";
    this.now = opts.now ?? (() => Date.now());
    this.roundEditedToMinute = opts.roundEditedToMinute ?? true;
    this.queryIncludesTrashed = opts.queryIncludesTrashed ?? false;
    this.maxQueryResults = opts.maxQueryResults ?? 10_000;
    this.enforceRps = opts.enforceRps;
  }

  /** `fetch`-compatible entry point. */
  fetch: typeof fetch = async (input, init) => this.handle(new Request(input as RequestInfo, init));

  private t(): number {
    return this.now() + this.clockSkewMs;
  }
  advance(ms: number) {
    this.clockSkewMs += ms;
  }

  private iso(ms: number) {
    const v = this.roundEditedToMinute ? Math.floor(ms / 60_000) * 60_000 : ms;
    return new Date(v).toISOString();
  }

  // ------------------------------------------------------------------ fixtures API
  addDatabase(opts: { title: string; properties: Record<string, PropertySchema>; id?: string; dataSourceId?: string; parentPageId?: string }) {
    const id = opts.id ?? nid();
    const dsId = opts.dataSourceId ?? nid();
    this.databases.set(id, { id, title: opts.title, parentPageId: opts.parentPageId ?? nid(), dataSourceIds: [dsId] });
    this.dataSources.set(dsId, { id: dsId, databaseId: id, title: opts.title, properties: structuredClone(opts.properties) });
    return { databaseId: id, dataSourceId: dsId };
  }

  addPage(dataSourceId: string, properties: Record<string, PropertyValue>, opts: { id?: string; inTrash?: boolean; editedMs?: number } = {}) {
    const id = opts.id ?? nid();
    const t = opts.editedMs ?? this.t();
    this.pages.set(id, { id, dataSourceId, createdMs: t, editedMs: t, inTrash: opts.inTrash ?? false, properties: structuredClone(properties) });
    return id;
  }

  editPage(id: string, properties: Record<string, PropertyValue>, opts: { inTrash?: boolean } = {}) {
    const p = this.pages.get(id);
    if (!p) throw new Error(`no page ${id}`);
    Object.assign(p.properties, structuredClone(properties));
    if (opts.inTrash !== undefined) p.inTrash = opts.inTrash;
    p.editedMs = this.t();
  }

  /** Permanently remove a page (it disappears from all queries). */
  removePage(id: string) {
    this.pages.delete(id);
  }

  renameProperty(dataSourceId: string, from: string, to: string) {
    const ds = this.dataSources.get(dataSourceId)!;
    const s = ds.properties[from];
    delete ds.properties[from];
    ds.properties[to] = { ...s, name: to };
    for (const p of this.pages.values()) {
      if (p.dataSourceId === dataSourceId && p.properties[from]) {
        p.properties[to] = p.properties[from];
        delete p.properties[from];
      }
    }
  }

  countRequests(method: string, pathIncludes: string) {
    return this.requests.filter((r) => r.method === method && r.path.includes(pathIncludes)).length;
  }

  // ------------------------------------------------------------------ serialization
  private pageJson(p: StoredPage): Page {
    const ds = this.dataSources.get(p.dataSourceId)!;
    return {
      object: "page",
      id: p.id,
      created_time: this.iso(p.createdMs),
      last_edited_time: this.iso(p.editedMs),
      in_trash: p.inTrash,
      is_archived: false,
      url: `https://www.notion.so/${p.id.replace(/-/g, "")}`,
      parent: { type: "data_source_id", data_source_id: p.dataSourceId, database_id: ds.databaseId },
      properties: structuredClone(p.properties),
    };
  }

  // ------------------------------------------------------------------ HTTP handling
  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();
    const body = method === "GET" ? undefined : await req.json().catch(() => undefined);
    const log = (res: Response) => {
      this.requests.push({ method, path, status: res.status, at: this.t(), body });
      return res;
    };

    // Rate limiting (optional).
    if (this.enforceRps) {
      const now = this.t();
      this.recent = this.recent.filter((x) => now - x < 1000);
      if (this.recent.length >= this.enforceRps) {
        return log(err(429, "rate_limited", "You have been rate limited. Please try again in a few minutes.", { "retry-after": "1" }));
      }
      this.recent.push(now);
    }

    // Fault injection.
    const fault = this.faults.find((f) => (!f.method || f.method === method) && (!f.pathIncludes || path.includes(f.pathIncludes)));
    let applyThenFail: Fault | undefined;
    if (fault) {
      const hits = (this.faultHits.get(fault) ?? 0) + 1;
      this.faultHits.set(fault, hits);
      const skip = fault.skip ?? 0;
      const times = fault.times ?? 1;
      if (hits > skip && hits <= skip + times) {
        if (fault.applyThenFail) applyThenFail = fault;
        else {
          if (fault.network) {
            this.requests.push({ method, path, status: 0, at: this.t(), body });
            throw new TypeError("fetch failed (simulated network error)");
          }
          const status = fault.status ?? 503;
          const headers: Record<string, string> = fault.retryAfterSeconds ? { "retry-after": String(fault.retryAfterSeconds) } : {};
          return log(err(status, fault.code ?? (status === 429 ? "rate_limited" : "service_unavailable"), "Injected fault", headers));
        }
      }
      if (hits > skip + times) this.faults = this.faults.filter((f) => f !== fault);
    }

    if (!req.headers.get("notion-version")) return log(err(400, "missing_version", "Notion-Version header is required"));
    if (req.headers.get("authorization") !== `Bearer ${this.token}`) return log(err(401, "unauthorized", "API token is invalid."));

    const res = this.route(method, path, body);
    if (applyThenFail) {
      log(res);
      return log(err(applyThenFail.status ?? 503, applyThenFail.code ?? "service_unavailable", "Injected fault after apply"));
    }
    return log(res);
  }

  private route(method: string, path: string, body: unknown): Response {
    let m: RegExpMatchArray | null;
    if (method === "GET" && (m = path.match(/^\/v1\/databases\/([^/]+)$/))) {
      const db = this.databases.get(m[1]) ?? [...this.databases.values()].find((d) => d.id.replace(/-/g, "") === m![1].replace(/-/g, ""));
      if (!db) return err(404, "object_not_found", `Could not find database with ID: ${m[1]}. Make sure the relevant pages and databases are shared with your integration.`);
      const out: Database = {
        object: "database",
        id: db.id,
        title: [{ type: "text", plain_text: db.title, text: { content: db.title } }],
        in_trash: false,
        url: `https://www.notion.so/${db.id.replace(/-/g, "")}`,
        data_sources: db.dataSourceIds.map((id) => ({ id, name: this.dataSources.get(id)!.title })),
      };
      return json(200, out);
    }
    if (method === "GET" && (m = path.match(/^\/v1\/data_sources\/([^/]+)$/))) {
      const ds = this.dataSources.get(m[1]);
      if (!ds) return err(404, "object_not_found", `Could not find data source with ID: ${m[1]}.`);
      const out: DataSource = {
        object: "data_source",
        id: ds.id,
        title: [{ type: "text", plain_text: ds.title, text: { content: ds.title } }],
        parent: { type: "database_id", database_id: ds.databaseId },
        in_trash: false,
        properties: structuredClone(ds.properties),
      };
      return json(200, out);
    }
    if (method === "POST" && (m = path.match(/^\/v1\/data_sources\/([^/]+)\/query$/))) return this.query(m[1], (body ?? {}) as Record<string, unknown>);
    if (method === "PATCH" && (m = path.match(/^\/v1\/pages\/([^/]+)$/))) return this.patchPage(m[1], (body ?? {}) as Record<string, unknown>);
    if (method === "POST" && path === "/v1/databases") return this.createDatabase((body ?? {}) as Record<string, unknown>);
    return err(400, "invalid_request_url", `Invalid request URL: ${method} ${path}`);
  }

  private query(dsId: string, body: Record<string, unknown>): Response {
    const ds = this.dataSources.get(dsId);
    if (!ds) return err(404, "object_not_found", `Could not find data source with ID: ${dsId}.`);
    const allowed = new Set(["filter", "sorts", "start_cursor", "page_size", "is_archived", "result_type"]);
    const extra = Object.keys(body).filter((k) => !allowed.has(k));
    if (extra.length) return err(400, "validation_error", `body failed validation: unexpected keys ${extra.join(", ")}`);
    const pageSize = (body.page_size as number | undefined) ?? 100;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) return err(400, "validation_error", "page_size should be ≤ 100");

    let list = [...this.pages.values()].filter((p) => p.dataSourceId === dsId && (this.queryIncludesTrashed || !p.inTrash));
    const f = body.filter as { timestamp?: string; last_edited_time?: Record<string, string>; property?: string } | undefined;
    if (f) {
      if (f.property) return err(400, "validation_error", "timestamp filters must not include property");
      if (f.timestamp !== "last_edited_time" || !f.last_edited_time) return err(400, "validation_error", "unsupported filter in fake");
      const cond = f.last_edited_time;
      const edited = (p: StoredPage) => Date.parse(this.iso(p.editedMs));
      if (cond.on_or_after) list = list.filter((p) => edited(p) >= Date.parse(cond.on_or_after));
      if (cond.after) list = list.filter((p) => edited(p) > Date.parse(cond.after));
      if (cond.before) list = list.filter((p) => edited(p) < Date.parse(cond.before));
    }
    const sorts = (body.sorts as Array<{ timestamp?: string; direction?: string }> | undefined) ?? [];
    const dir = sorts[0]?.timestamp === "last_edited_time" && sorts[0]?.direction === "descending" ? -1 : 1;
    list.sort((a, b) => dir * (a.editedMs - b.editedMs) || a.id.localeCompare(b.id));

    const offset = body.start_cursor ? Number(Buffer.from(String(body.start_cursor), "base64url").toString()) : 0;
    if (!Number.isFinite(offset)) return err(400, "validation_error", "invalid start_cursor");
    const cap = this.maxQueryResults;
    const end = Math.min(offset + pageSize, list.length, cap);
    const results = list.slice(offset, end).map((p) => this.pageJson(p));
    const truncated = list.length > cap && end >= cap;
    const hasMore = !truncated && end < list.length;
    return json(200, {
      object: "list",
      type: "page_or_data_source",
      results,
      has_more: hasMore,
      next_cursor: hasMore ? Buffer.from(String(end)).toString("base64url") : null,
      ...(truncated ? { request_status: { type: "incomplete" } } : {}),
    });
  }

  private patchPage(id: string, body: Record<string, unknown>): Response {
    const p = this.pages.get(id);
    if (!p) return err(404, "object_not_found", `Could not find page with ID: ${id}.`);
    const ds = this.dataSources.get(p.dataSourceId)!;
    const props = (body.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const [name, val] of Object.entries(props)) {
      const schema = ds.properties[name];
      if (!schema) return err(400, "validation_error", `${name} is not a property that exists.`);
      const type = schema.type;
      if (!(type in val)) return err(400, "validation_error", `${name} is expected to be ${type}.`);
      if (type === "select" || type === "status") {
        const v = val[type] as { name: string } | null;
        const opts = (schema as Record<string, { options: Array<{ name: string }> }>)[type].options;
        if (v && !opts.some((o) => o.name === v.name)) {
          if (type === "status") return err(400, "validation_error", `Invalid status option. Status option "${v.name}" does not exist.`);
          opts.push({ name: v.name });
        }
        p.properties[name] = { id: schema.id, type, [type]: v ? { name: v.name } : null } as PropertyValue;
      } else if (type === "date") {
        p.properties[name] = { id: schema.id, type: "date", date: (val.date as { start: string } | null) ?? null };
      } else if (type === "rich_text") {
        const items = (val.rich_text as Array<{ text: { content: string } }>) ?? [];
        p.properties[name] = { id: schema.id, type: "rich_text", rich_text: items.map((i) => ({ type: "text", plain_text: i.text.content, text: i.text })) };
      } else {
        return err(400, "validation_error", `fake does not support writing ${type}`);
      }
    }
    if (typeof body.in_trash === "boolean") p.inTrash = body.in_trash;
    p.editedMs = this.t();
    return json(200, this.pageJson(p));
  }

  private createDatabase(body: Record<string, unknown>): Response {
    const parent = body.parent as { type?: string; page_id?: string } | undefined;
    if (!parent?.page_id) return err(400, "validation_error", "parent.page_id is required");
    if (!this.parentPages.has(parent.page_id)) {
      return err(404, "object_not_found", `Could not find page with ID: ${parent.page_id}. Make sure the relevant pages and databases are shared with your integration.`);
    }
    const init = body.initial_data_source as { properties?: Record<string, Record<string, unknown>> } | undefined;
    if (!init?.properties) return err(400, "validation_error", "initial_data_source.properties is required");
    const properties: Record<string, PropertySchema> = {};
    for (const [name, def] of Object.entries(init.properties)) {
      const type = Object.keys(def)[0];
      const conf = (def[type] ?? {}) as Record<string, unknown>;
      properties[name] = {
        id: name === Object.keys(init.properties).find((k) => "title" in init.properties![k]) ? "title" : nid().slice(0, 4),
        name,
        type,
        [type]: type === "select" || type === "multi_select" || type === "status" ? { options: (conf.options as unknown[]) ?? [] } : {},
      } as PropertySchema;
    }
    const title = ((body.title as Array<{ text: { content: string } }>) ?? [])[0]?.text.content ?? "Untitled";
    const { databaseId } = this.addDatabase({ title, properties, parentPageId: parent.page_id });
    const db = this.databases.get(databaseId)!;
    return json(200, {
      object: "database",
      id: databaseId,
      title: [{ type: "text", plain_text: title, text: { content: title } }],
      in_trash: false,
      data_sources: db.dataSourceIds.map((id) => ({ id, name: title })),
    } satisfies Database);
  }
}

// ------------------------------------------------------------------ helpers to build page values
const rt = (s: string) => [{ type: "text", plain_text: s, text: { content: s, link: null } }];

export type SimpleContact = {
  name?: string | null;
  greeting?: string | null;
  email?: string | null;
  company?: string | null;
  tags?: string[];
  subscription?: string | null;
  consentEvidence?: string | null;
};

/** Build page property values for the standard CRM schema (scripts/notion-mock + CRM_DATABASE_PROPERTIES). */
export function crmPageProperties(c: SimpleContact): Record<string, PropertyValue> {
  return {
    Name: { type: "title", title: c.name ? rt(c.name) : [] },
    "Greeting name": { type: "rich_text", rich_text: c.greeting ? rt(c.greeting) : [] },
    Email: { type: "email", email: c.email ?? null },
    Company: { type: "rich_text", rich_text: c.company ? rt(c.company) : [] },
    Tags: { type: "multi_select", multi_select: (c.tags ?? []).map((name) => ({ name })) },
    "Consent evidence": { type: "rich_text", rich_text: c.consentEvidence ? rt(c.consentEvidence) : [] },
    "Subscription status": { type: "select", select: c.subscription ? { name: c.subscription } : null },
    "Last emailed": { type: "date", date: null },
    "Last engagement": { type: "date", date: null },
  } as Record<string, PropertyValue>;
}

/** Data-source schema for the standard CRM database (same as the app's "Create CRM database"). */
export function crmSchema(): Record<string, PropertySchema> {
  const s = (name: string, type: string, extra: Record<string, unknown> = {}): PropertySchema =>
    ({ id: name === "Name" ? "title" : name.slice(0, 4), name, type, [type]: extra }) as PropertySchema;
  return {
    Name: s("Name", "title"),
    "Greeting name": s("Greeting name", "rich_text"),
    Email: s("Email", "email"),
    Company: s("Company", "rich_text"),
    Tags: s("Tags", "multi_select", { options: [] }),
    "Consent evidence": s("Consent evidence", "rich_text"),
    "Subscription status": s("Subscription status", "select", {
      options: [{ name: "Subscribed" }, { name: "Unsubscribed" }, { name: "Bounced" }, { name: "Complained" }],
    }),
    "Last emailed": s("Last emailed", "date"),
    "Last engagement": s("Last engagement", "date"),
  };
}
