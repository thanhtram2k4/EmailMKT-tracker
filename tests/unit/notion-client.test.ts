/**
 * Notion client: rate limiting and retry policy, on a virtual clock against the fake Notion.
 * MOCK: proves our client's behaviour, not Notion's real limits.
 */
import { describe, expect, it } from "vitest";
import { NotionApiError, NotionClient, NotionUncertainError } from "../../src/lib/notion/client";
import { TokenBucket, VirtualTime } from "../../src/lib/notion/rate-limiter";
import { FakeNotion, crmSchema } from "../../scripts/notion-mock/fake-notion";

function setup(opts: { enforceRps?: number } = {}) {
  const time = new VirtualTime(Date.parse("2026-11-12T00:00:00Z"));
  const fake = new FakeNotion({ now: () => time.now(), enforceRps: opts.enforceRps });
  const { dataSourceId, databaseId } = fake.addDatabase({ title: "CRM", properties: crmSchema() });
  const client = new NotionClient({ baseUrl: "http://127.0.0.1:4010", token: fake.token, fetch: fake.fetch, time, random: () => 0 });
  return { time, fake, client, dataSourceId, databaseId };
}

describe("token bucket", () => {
  it("allows a burst of 3, then paces at the configured rate", async () => {
    const time = new VirtualTime(0);
    const b = new TokenBucket(2.5, 3, time);
    for (let i = 0; i < 13; i++) await b.acquire();
    // 3 immediate + 10 paced at 2.5/s → ≈ 4 s of virtual time
    expect(time.now()).toBeGreaterThanOrEqual(3900);
    expect(time.now()).toBeLessThanOrEqual(4100);
  });

  it("keeps the client under a server-enforced 3 req/s limit (no 429s)", async () => {
    const { client, fake, dataSourceId } = setup({ enforceRps: 3 });
    for (let i = 0; i < 30; i++) await client.retrieveDataSource(dataSourceId);
    expect(fake.requests.filter((r) => r.status === 429)).toHaveLength(0);
    expect(client.stats.rateLimited).toBe(0);
  });
});

describe("retry policy", () => {
  it("honours Retry-After on 429 and then succeeds", async () => {
    const { client, fake, time, dataSourceId } = setup();
    fake.faults.push({ method: "POST", pathIncludes: "/query", status: 429, code: "rate_limited", retryAfterSeconds: 7, times: 2 });
    const res = await client.queryDataSource(dataSourceId, { page_size: 10 });
    expect(res.object).toBe("list");
    expect(fake.countRequests("POST", "/query")).toBe(3);
    expect(time.sleeps.filter((s) => s === 7000)).toHaveLength(2);
    expect(client.stats.rateLimited).toBe(2);
  });

  it("retries 529 and 5xx on reads with exponential backoff", async () => {
    const { client, fake, time, dataSourceId } = setup();
    fake.faults.push({ method: "GET", status: 529, code: "service_overload", times: 1 });
    await client.retrieveDataSource(dataSourceId);
    fake.faults.push({ method: "GET", status: 503, times: 3 });
    await client.retrieveDataSource(dataSourceId);
    expect(time.sleeps.slice(-3)).toEqual([1000, 2000, 4000]);
  });

  it("gives up after max attempts with the last error", async () => {
    const { client, fake, dataSourceId } = setup();
    fake.faults.push({ method: "GET", status: 502, code: "bad_gateway", times: 10 });
    const e = await client.retrieveDataSource(dataSourceId).catch((x) => x);
    expect(e).toBeInstanceOf(NotionApiError);
    expect(e).toMatchObject({ status: 502, attempts: 5 });
  });

  it("never retries 4xx such as 401, 404 or 400", async () => {
    const { client, fake, dataSourceId } = setup();
    const bad = new NotionClient({ baseUrl: "http://x", token: "wrong", fetch: fake.fetch, time: new VirtualTime() });
    await expect(bad.retrieveDataSource(dataSourceId)).rejects.toMatchObject({ status: 401, code: "unauthorized", attempts: 1 });
    await expect(client.retrieveDataSource("does-not-exist")).rejects.toMatchObject({ status: 404, attempts: 1 });
    await expect(client.queryDataSource(dataSourceId, { page_size: 500 })).rejects.toMatchObject({ status: 400, code: "validation_error", attempts: 1 });
  });

  it("retries network errors on reads, but reports an uncertain outcome for non-idempotent creates", async () => {
    const { client, fake, dataSourceId } = setup();
    fake.faults.push({ method: "GET", network: true, times: 2 });
    await expect(client.retrieveDataSource(dataSourceId)).resolves.toMatchObject({ object: "data_source" });
    fake.parentPages.add("parent");
    fake.faults.push({ method: "POST", pathIncludes: "/v1/databases", network: true, times: 1 });
    await expect(client.createDatabase({ parent: { page_id: "parent" }, initial_data_source: { properties: {} } })).rejects.toBeInstanceOf(NotionUncertainError);
    expect(fake.countRequests("POST", "/v1/databases")).toBe(1); // exactly one attempt, not retried
    expect(fake.databases.size).toBe(1); // no database was created (only the fixture one exists)
  });

  it("does not retry a 5xx on a non-idempotent create (could create a second database)", async () => {
    const { client, fake } = setup();
    fake.parentPages.add("parent");
    fake.faults.push({ method: "POST", pathIncludes: "/v1/databases", status: 503, applyThenFail: true });
    await expect(client.createDatabase({ parent: { page_id: "parent" }, title: [], initial_data_source: { properties: { Name: { title: {} } } } })).rejects.toMatchObject({ status: 503, attempts: 1 });
    expect(fake.databases.size).toBe(2); // the write was applied once and not duplicated by a retry
  });

  it("aborts instead of blocking when Retry-After is very long", async () => {
    const { client, fake, dataSourceId } = setup();
    fake.faults.push({ method: "GET", status: 429, retryAfterSeconds: 600, times: 1 });
    await expect(client.retrieveDataSource(dataSourceId)).rejects.toMatchObject({ status: 429, retryAfterMs: 600_000 });
  });

  it("sends the pinned Notion-Version and bearer token", async () => {
    const { fake, dataSourceId, time } = setup();
    let seen: Headers | undefined;
    const spy: typeof fetch = async (input, init) => {
      seen = new Headers(init?.headers);
      return fake.fetch(input, init);
    };
    await new NotionClient({ baseUrl: "http://x", token: fake.token, fetch: spy, time }).retrieveDataSource(dataSourceId);
    expect(seen?.get("notion-version")).toBe("2026-03-11");
    expect(seen?.get("authorization")).toBe(`Bearer ${fake.token}`);
  });
});
