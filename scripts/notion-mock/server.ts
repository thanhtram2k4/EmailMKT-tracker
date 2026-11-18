/**
 * LOCAL MOCK NOTION SERVER — synthetic data only, loopback only. Never contacts Notion.
 *
 *   npm run notion:mock              # http://127.0.0.1:4010, seeded with 40 synthetic contacts
 *
 * The app talks to it when NOTION_MODE=mock. Token (not a secret): mock-notion-token-not-a-secret
 * Control API for manual testing (or use `npm run notion:mock:ctl -- …`):
 *   GET    /__mock/pages                     list pages (key, id, name, email, subscription, trashed)
 *   POST   /__mock/pages                     add {name, greeting, email, company, tags, subscription, consentEvidence}
 *   PATCH  /__mock/pages/:keyOrId            edit the same fields (+ inTrash: true|false)
 *   DELETE /__mock/pages/:keyOrId            remove permanently
 *   POST   /__mock/faults                    inject {method, pathIncludes, status, times, retryAfterSeconds, network}
 *   DELETE /__mock/faults                    clear faults
 *   POST   /__mock/reset                     reseed
 */
import http from "node:http";
import { FakeNotion, crmPageProperties, type Fault, type SimpleContact } from "./fake-notion";
import { MOCK_DATA_SOURCE_ID, seedSyntheticCrm } from "./seed";

const PORT = Number(process.env.NOTION_MOCK_PORT ?? 4010);
const HOST = "127.0.0.1";

let fake: FakeNotion;
let keys: Record<string, string> = {};
function reset() {
  fake = new FakeNotion();
  keys = seedSyntheticCrm(fake).pageIds;
}
reset();

const resolveId = (k: string) => keys[k] ?? k;
const keyOf = (id: string) => Object.entries(keys).find(([, v]) => v === id)?.[0] ?? null;

function summary() {
  return [...fake.pages.values()].map((p) => {
    const text = (n: string) => {
      const v = p.properties[n] as { title?: Array<{ plain_text: string }>; rich_text?: Array<{ plain_text: string }>; email?: string; select?: { name: string } | null } | undefined;
      return v?.title?.map((t) => t.plain_text).join("") ?? v?.rich_text?.map((t) => t.plain_text).join("") ?? v?.email ?? v?.select?.name ?? null;
    };
    const lastEmailed = (p.properties["Last emailed"] as { date?: { start: string } | null } | undefined)?.date?.start ?? null;
    return { key: keyOf(p.id), id: p.id, name: text("Name"), email: text("Email"), subscription: text("Subscription status"), lastEmailed, inTrash: p.inTrash, lastEdited: new Date(p.editedMs).toISOString() };
  });
}

function currentSimple(id: string): SimpleContact {
  const s = summary().find((x) => x.id === id)!;
  const p = fake.pages.get(id)!;
  const rt = (n: string) => ((p.properties[n] as { rich_text?: Array<{ plain_text: string }> })?.rich_text ?? []).map((t) => t.plain_text).join("") || null;
  const tags = ((p.properties.Tags as { multi_select?: Array<{ name: string }> })?.multi_select ?? []).map((t) => t.name);
  return { name: s.name, email: s.email, subscription: s.subscription, greeting: rt("Greeting name"), company: rt("Company"), consentEvidence: rt("Consent evidence"), tags };
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

const send = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
    const body = await readBody(req);
    if (url.pathname.startsWith("/__mock/")) {
      const json = body.length ? JSON.parse(body.toString("utf8")) : {};
      const m = url.pathname.match(/^\/__mock\/pages\/(.+)$/);
      if (req.method === "GET" && url.pathname === "/__mock/pages") return send(res, 200, summary());
      if (req.method === "POST" && url.pathname === "/__mock/pages") {
        const id = fake.addPage(MOCK_DATA_SOURCE_ID, crmPageProperties(json as SimpleContact));
        if (json.key) keys[json.key] = id;
        return send(res, 201, { id });
      }
      if (req.method === "PATCH" && m) {
        const id = resolveId(decodeURIComponent(m[1]));
        if (!fake.pages.has(id)) return send(res, 404, { error: "no such page" });
        const { inTrash, ...fields } = json as SimpleContact & { inTrash?: boolean };
        fake.editPage(id, Object.keys(fields).length ? crmPageProperties({ ...currentSimple(id), ...fields }) : {}, { inTrash });
        return send(res, 200, summary().find((s) => s.id === id));
      }
      if (req.method === "DELETE" && m) {
        fake.removePage(resolveId(decodeURIComponent(m[1])));
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/__mock/faults") {
        fake.faults.push(json as Fault);
        return send(res, 200, { faults: fake.faults.length });
      }
      if (req.method === "DELETE" && url.pathname === "/__mock/faults") {
        fake.faults = [];
        return send(res, 200, { faults: 0 });
      }
      if (req.method === "POST" && url.pathname === "/__mock/reset") {
        reset();
        return send(res, 200, { pages: fake.pages.size });
      }
      return send(res, 404, { error: "unknown control endpoint" });
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const r = await fake.handle(new Request(url, { method: req.method, headers, body: req.method === "GET" || !body.length ? undefined : new Uint8Array(body) }));
    res.writeHead(r.status, Object.fromEntries(r.headers.entries()));
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    // Simulated network faults surface here: drop the connection.
    if (e instanceof TypeError && String(e.message).includes("simulated network error")) return req.socket.destroy();
    send(res, 500, { object: "error", status: 500, code: "internal_server_error", message: String(e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Mock Notion (SYNTHETIC data) listening on http://${HOST}:${PORT} — ${fake.pages.size} pages`);
  console.log(`Token: ${fake.token}  ·  database ID: 11111111-2222-4333-8444-555555555555`);
});
const stop = () => server.close(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
