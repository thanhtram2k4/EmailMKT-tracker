import { randomBytes } from "node:crypto";
import { connectExistingDatabase } from "../../src/lib/crm/connection";
import type { NotionEnv } from "../../src/lib/crm/notion-env";
import { closeDb, getDb, type Db } from "../../src/lib/db/client";
import { VirtualTime } from "../../src/lib/notion/rate-limiter";
import { FakeNotion, crmPageProperties, crmSchema, type FakeOptions, type SimpleContact } from "../../scripts/notion-mock/fake-notion";
import { seedSyntheticCrm } from "../../scripts/notion-mock/seed";
import { createTestDatabase } from "./helpers";

export const TEST_ENCRYPTION_ENV = { APP_ENCRYPTION_KEY: randomBytes(32).toString("base64url"), APP_ENCRYPTION_KEY_ID: "k1" };

export type CrmCtx = {
  db: Db;
  url: string;
  fake: FakeNotion;
  env: NotionEnv;
  time: VirtualTime;
  dataSourceId: string;
  databaseId: string;
  pageIds: Record<string, string>;
  drop: () => Promise<void>;
};

/**
 * Fresh migrated database + fake Notion (virtual time, so retries/rate limiting cost no real time)
 * + a stored connection. `pages: "synthetic"` seeds the 40 synthetic contacts.
 */
export async function setupCrm(opts: { pages?: "synthetic" | "none"; fake?: FakeOptions } = {}): Promise<CrmCtx> {
  process.env.LOG_LEVEL = "silent";
  const tdb = await createTestDatabase("it_crm");
  const db = getDb(tdb.url);
  const time = new VirtualTime(Date.parse("2026-11-12T03:00:00.000Z"));
  const fake = new FakeNotion({ now: () => time.now(), ...opts.fake });
  let databaseId: string;
  let dataSourceId: string;
  let pageIds: Record<string, string> = {};
  if (opts.pages === "synthetic") {
    const s = seedSyntheticCrm(fake);
    ({ databaseId, dataSourceId, pageIds } = s);
  } else {
    ({ databaseId, dataSourceId } = fake.addDatabase({ title: "CRM", properties: crmSchema() }));
  }
  const env: NotionEnv = { baseUrl: "http://127.0.0.1:4010", ratePerSec: 2.5, fetch: fake.fetch, time, encryptionEnv: TEST_ENCRYPTION_ENV };
  const r = await connectExistingDatabase(db, env, { token: fake.token, databaseIdOrUrl: databaseId, actor: "test" });
  if (!r.ok) throw new Error(`connect failed: ${r.error}`);
  return {
    db,
    url: tdb.url,
    fake,
    env,
    time,
    dataSourceId,
    databaseId,
    pageIds,
    drop: async () => {
      await closeDb();
      await tdb.drop();
    },
  };
}

/** Add n generated contacts, each edited `stepMs` apart on the virtual clock. */
export function addGeneratedPages(ctx: CrmCtx, n: number, stepMs = 61_000, make?: (i: number) => SimpleContact) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ctx.time.advance(stepMs);
    ids.push(
      ctx.fake.addPage(
        ctx.dataSourceId,
        crmPageProperties(make?.(i) ?? { name: `Khách hàng mẫu ${i}`, greeting: `Bạn ${i}`, email: `gen.${i}@example.com`, tags: ["Dữ liệu mẫu"] }),
      ),
    );
  }
  return ids;
}
