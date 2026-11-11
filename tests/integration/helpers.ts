import { randomUUID } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";
import { localDatabaseUrl } from "../../scripts/lib/embedded-pg";
import { migrateDatabase } from "../../scripts/migrate";

/** Create a fresh, fully migrated database for one test file. */
export async function createTestDatabase(prefix: string): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `${prefix}_${randomUUID().slice(0, 8)}`.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  const admin = new pg.Client({ connectionString: inject("pgAdminUrl") });
  await admin.connect();
  await admin.query(`create database "${name}"`);
  await admin.end();
  const url = localDatabaseUrl(inject("pgPort"), name);
  await migrateDatabase(url, { quiet: true });
  return {
    url,
    drop: async () => {
      const a = new pg.Client({ connectionString: inject("pgAdminUrl") });
      await a.connect();
      await a.query(`drop database if exists "${name}" with (force)`);
      await a.end();
    },
  };
}

export async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 20_000, stepMs = 100): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** Minimal env for code paths that call getConfig(). */
export function testEnv(databaseUrl: string, extra: Record<string, string> = {}) {
  return {
    APP_ENV: "test",
    DATABASE_URL: databaseUrl,
    APP_BASE_URL: "http://localhost:3999",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123",
    ALLOWED_EMAIL_DOMAINS: "example.com",
    DEV_LOGIN_ENABLED: "true",
    SEND_MODE: "disabled",
    LOG_LEVEL: "silent",
    ...extra,
  };
}
