/**
 * FIXTURE global setup: the project's embedded-postgres helper (with the exit-hook fix).
 * FIXTURE_START_PG=1 also starts and stops a real throwaway cluster, exercising the same
 * teardown path as tests/integration/global-setup.ts.
 */
import { startLocalPostgres } from "../../../scripts/lib/embedded-pg";

export default async function setup() {
  if (process.env.FIXTURE_START_PG !== "1") return;
  const port = Number(process.env.FIXTURE_PG_PORT ?? 54341);
  const h = await startLocalPostgres({ dir: `.local/pg-tooling-${port}`, port, ephemeral: true, quiet: true });
  return async () => {
    await h.stop();
  };
}
