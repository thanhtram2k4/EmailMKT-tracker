import { eq } from "drizzle-orm";
import type { AppConfig } from "../config";
import { decryptSecret, encryptSecret, keysFromEnv } from "../crypto/secrets";
import type { Db } from "../db/client";
import { notionConnection } from "../db/schema";
import { NotionClient } from "../notion/client";
import { TokenBucket, realTime, type TimeSource } from "../notion/rate-limiter";
import type { AppField, FieldMapping } from "./mapping";

/** How to reach Notion. Production code builds it from config; tests inject a fake fetch + virtual time. */
export type NotionEnv = {
  baseUrl: string;
  ratePerSec: number;
  fetch?: typeof fetch;
  time?: TimeSource;
  limiter?: TokenBucket;
  maxAttempts?: number;
  encryptionEnv?: Record<string, string | undefined>;
};

export class NotionDisabledError extends Error {
  constructor() {
    super("Notion access is disabled (NOTION_MODE=disabled). Set NOTION_MODE=mock for local synthetic data.");
    this.name = "NotionDisabledError";
  }
}

const shared = ((globalThis as Record<string, unknown>).__emtNotionLimiter ??= {}) as { bucket?: TokenBucket };

export function notionEnvFromConfig(cfg: AppConfig): NotionEnv {
  if (cfg.NOTION_MODE === "disabled" || !cfg.notionBaseUrl) throw new NotionDisabledError();
  // One limiter per process so concurrent jobs share the ~3 req/s budget.
  shared.bucket ??= new TokenBucket(cfg.NOTION_RATE_LIMIT_RPS, 1, realTime);
  return { baseUrl: cfg.notionBaseUrl, ratePerSec: cfg.NOTION_RATE_LIMIT_RPS, limiter: shared.bucket };
}

export function makeClient(env: NotionEnv, token: string) {
  return new NotionClient({
    baseUrl: env.baseUrl,
    token,
    fetch: env.fetch,
    time: env.time,
    limiter: env.limiter ?? new TokenBucket(env.ratePerSec, 1, env.time ?? realTime),
    maxAttempts: env.maxAttempts,
  });
}

export const TOKEN_AAD = "notion_connection.token_ciphertext";

export function sealToken(token: string, env: NotionEnv) {
  return encryptSecret(token, keysFromEnv(env.encryptionEnv ?? process.env).current, TOKEN_AAD);
}

export type StoredMapping = { fields: FieldMapping; types: Partial<Record<AppField, string>> };

export async function loadConnection(db: Db) {
  return (await db.select().from(notionConnection).where(eq(notionConnection.id, "default")).limit(1))[0] ?? null;
}

/** Client for the stored connection (decrypts the token in memory only). */
export async function clientForConnection(db: Db, env: NotionEnv) {
  const conn = await loadConnection(db);
  if (!conn || conn.status !== "connected" || !conn.tokenCiphertext) return null;
  const token = decryptSecret(conn.tokenCiphertext, keysFromEnv(env.encryptionEnv ?? process.env).all, TOKEN_AAD);
  return { conn, client: makeClient(env, token), mapping: (conn.mapping ?? { fields: {}, types: {} }) as StoredMapping };
}
