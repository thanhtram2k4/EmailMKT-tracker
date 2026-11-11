import { NextResponse } from "next/server";
import { systemClock } from "../../lib/clock";
import { getConfig } from "../../lib/config";
import { getDb } from "../../lib/db/client";
import { checkHealth } from "../../lib/health";

export const dynamic = "force-dynamic";

/** Public liveness/readiness endpoint. Reveals no secrets or connection details. */
export async function GET() {
  const cfg = getConfig();
  const report = await checkHealth(getDb(), {
    clock: systemClock,
    build: cfg.BUILD_ID,
    env: cfg.APP_ENV,
    sendMode: cfg.SEND_MODE,
    maxHeartbeatAgeS: cfg.HEALTH_MAX_HEARTBEAT_AGE_S,
  });
  return NextResponse.json(report, {
    status: report.status === "ok" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
