/**
 * FIXTURE global setup that imports embedded-postgres DIRECTLY (without the project's fix in
 * scripts/lib/embedded-pg.ts). Used only to characterize the upstream behaviour that forced
 * exit code 0 — see tests/tooling/exit-code.test.ts.
 */
import "embedded-postgres";

export default function setup() {}
