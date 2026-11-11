/**
 * Starts a throwaway local PostgreSQL 17 (embedded-postgres, real server binaries) for the
 * integration project. Data directory is deleted afterwards.
 */
import type { TestProject } from "vitest/node";
import { localDatabaseUrl, startLocalPostgres } from "../../scripts/lib/embedded-pg";

const PORT = Number(process.env.TEST_PG_PORT ?? 54331);

declare module "vitest" {
  export interface ProvidedContext {
    pgPort: number;
    pgAdminUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const h = await startLocalPostgres({ dir: `.local/pg-test-${PORT}`, port: PORT, ephemeral: true, quiet: true });
  project.provide("pgPort", PORT);
  project.provide("pgAdminUrl", localDatabaseUrl(PORT, "postgres"));
  return async () => {
    await h.stop();
  };
}
