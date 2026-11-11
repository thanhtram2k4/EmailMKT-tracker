/**
 * Control the local mock Notion server (synthetic data) for manual walkthroughs.
 *
 *   npm run notion:mock:ctl -- list
 *   npm run notion:mock:ctl -- set huy subscription=Subscribed      # try to "resubscribe" in Notion
 *   npm run notion:mock:ctl -- set ngoc name="Trần Bích Ngọc" greeting="Chị Ngọc"
 *   npm run notion:mock:ctl -- set ngoc email=ngoc.moi@example.com
 *   npm run notion:mock:ctl -- trash ngoc | restore ngoc | remove ngoc
 *   npm run notion:mock:ctl -- add email=moi@example.org name="Người Mới" greeting="Bạn"
 *   npm run notion:mock:ctl -- fault 503 3            # next 3 requests fail with 503
 *   npm run notion:mock:ctl -- fault 429 2 retry=2    # 429 with Retry-After: 2
 *   npm run notion:mock:ctl -- clear-faults | reset
 */
const BASE = `http://127.0.0.1:${process.env.NOTION_MOCK_PORT ?? 4010}/__mock`;
const [cmd, ...rest] = process.argv.slice(2);

const kv = (args: string[]) => Object.fromEntries(args.filter((a) => a.includes("=")).map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));
async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  console.log(r.status, t);
}
const fields = (o: Record<string, string>) => ({ ...o, ...(o.tags ? { tags: o.tags.split(",").map((s) => s.trim()) } : {}) });

switch (cmd) {
  case "list": {
    const r = await fetch(`${BASE}/pages`);
    console.table(((await r.json()) as Array<Record<string, unknown>>).map(({ key, name, email, subscription, inTrash }) => ({ key, name, email, subscription, inTrash })));
    break;
  }
  case "set":
    await call("PATCH", `/pages/${encodeURIComponent(rest[0])}`, fields(kv(rest.slice(1))));
    break;
  case "trash":
    await call("PATCH", `/pages/${encodeURIComponent(rest[0])}`, { inTrash: true });
    break;
  case "restore":
    await call("PATCH", `/pages/${encodeURIComponent(rest[0])}`, { inTrash: false });
    break;
  case "remove":
    await call("DELETE", `/pages/${encodeURIComponent(rest[0])}`);
    break;
  case "add":
    await call("POST", "/pages", fields(kv(rest)));
    break;
  case "fault": {
    const o = kv(rest);
    await call("POST", "/faults", { status: Number(rest[0]), times: Number(rest[1] ?? 1), ...(o.retry ? { retryAfterSeconds: Number(o.retry) } : {}) });
    break;
  }
  case "clear-faults":
    await call("DELETE", "/faults");
    break;
  case "reset":
    await call("POST", "/reset");
    break;
  default:
    console.log("commands: list | set <key> field=value… | trash <key> | restore <key> | remove <key> | add field=value… | fault <status> [times] [retry=s] | clear-faults | reset");
}

export {};
