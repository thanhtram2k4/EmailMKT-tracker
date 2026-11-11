/**
 * Smoke suite (docs/PLAN.md "Scenario catalogue"). Runs against a running environment.
 *
 *   npm run smoke:local                                 # isolated local stack (start → smoke → stop)
 *   npm run smoke -- --base-url https://staging.example --env staging
 *
 * Results: PASS | FAIL | BLOCKED | NOT RUN, each tagged MOCK or LIVE. Only executed and observed
 * checks can PASS. Output: smoke-results.json + smoke-results.md in --out (default: STACK_LOG_DIR or .local/smoke).
 * Exit code 1 if any scenario FAILs.
 */
import fs from "node:fs";
import path from "node:path";

type Result = "PASS" | "FAIL" | "BLOCKED" | "NOT RUN";
type Row = { id: string; scenario: string; type: "MOCK" | "LIVE" | "-"; result: Result; notes: string; durationMs?: number };

const args = process.argv.slice(2);
const opt = (n: string, d?: string) => {
  const i = args.indexOf(n);
  return i === -1 ? d : args[i + 1];
};
const baseUrl = (opt("--base-url", process.env.E2E_BASE_URL) ?? "http://localhost:3000").replace(/\/$/, "");
const envLabel = opt("--env", "local")!;
const outDir = path.resolve(opt("--out", process.env.STACK_LOG_DIR ?? ".local/smoke")!);
const allowedEmail = opt("--allowed-email", "admin@example.com")!;
const outsiderEmail = opt("--outsider-email", "outsider@example.net")!;
const strangerEmail = opt("--stranger-email", "stranger@example.com")!;

const rows: Row[] = [];
async function check(id: string, scenario: string, type: Row["type"], fn: () => Promise<{ result: Result; notes: string }>) {
  const t0 = Date.now();
  try {
    const r = await fn();
    rows.push({ id, scenario, type, ...r, durationMs: Date.now() - t0 });
  } catch (e) {
    rows.push({ id, scenario, type, result: "FAIL", notes: `error: ${e instanceof Error ? e.message : String(e)}`, durationMs: Date.now() - t0 });
  }
}

const started = new Date();

// S1 — app + worker up
await check("S1", "App and worker start; /healthz reports DB ok and worker heartbeat < 60 s", envLabel.startsWith("staging") || envLabel.startsWith("prod") ? "LIVE" : "MOCK", async () => {
  const r = await fetch(`${baseUrl}/healthz`);
  const body = (await r.json()) as { status: string; build: string; checks: { database: { ok: boolean }; worker: { ok: boolean; ageSeconds?: number } } };
  const ok = r.status === 200 && body.checks.database.ok && body.checks.worker.ok && (body.checks.worker.ageSeconds ?? 999) < 60;
  return {
    result: ok ? "PASS" : "FAIL",
    notes: `HTTP ${r.status}; db=${body.checks.database.ok}; worker=${body.checks.worker.ok}; heartbeat age=${body.checks.worker.ageSeconds}s; build=${body.build}`,
  };
});

// S2 — sign-in gate
async function devLogin(email: string) {
  const r = await fetch(`${baseUrl}/api/dev/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ email }),
  });
  if (r.status === 404) return { available: false as const };
  const { url } = (await r.json()) as { url?: string };
  if (!url) throw new Error(`dev sign-in returned HTTP ${r.status} without a link`);
  const v = await fetch(url, { redirect: "manual", headers: { origin: baseUrl } });
  return { available: true as const, status: v.status, location: v.headers.get("location") ?? "", cookies: v.headers.getSetCookie() };
}

const devProbe = await fetch(`${baseUrl}/api/dev/sign-in`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(
  () => null,
);
const devAvailable = devProbe !== null && devProbe.status !== 404;

if (devAvailable) {
  await check("S2a", "Allowed staff account can sign in (dev identity provider)", "MOCK", async () => {
    const r = await devLogin(allowedEmail);
    if (!r.available) return { result: "BLOCKED", notes: "dev sign-in not available" };
    const session = r.cookies.map((c) => c.split(";")[0]).filter((c) => /session_token=/.test(c));
    const loc = new URL(r.location, baseUrl);
    if (r.status !== 302 || loc.pathname !== "/" || session.length === 0)
      return { result: "FAIL", notes: `verify → HTTP ${r.status} → ${loc.pathname}${loc.search}; session cookie: ${session.length > 0}` };
    const home = await fetch(`${baseUrl}/`, { headers: { cookie: session.join("; ") }, redirect: "manual" });
    const html = await home.text();
    const ok = home.status === 200 && html.includes(allowedEmail);
    return { result: ok ? "PASS" : "FAIL", notes: `verify → 302 /; dashboard HTTP ${home.status}; shows signed-in user: ${html.includes(allowedEmail)}` };
  });
  for (const [id, email, code, label] of [
    ["S2b", outsiderEmail, "ACCESS_DENIED_WRONG_DOMAIN", "Outside-domain account is rejected"],
    ["S2c", strangerEmail, "ACCESS_DENIED_NOT_ALLOWLISTED", "Company-domain account not on allowlist is rejected"],
  ] as const) {
    await check(id, `${label} (dev identity provider)`, "MOCK", async () => {
      const r = await devLogin(email);
      if (!r.available) return { result: "BLOCKED", notes: "dev sign-in not available" };
      const loc = new URL(r.location, baseUrl);
      const hasSession = r.cookies.some((c) => /session_token=[^;]+/.test(c.split(";")[0]) && !/session_token=;/.test(c));
      const ok = loc.pathname === "/access-denied" && loc.searchParams.get("error") === code && !hasSession;
      return { result: ok ? "PASS" : "FAIL", notes: `verify → HTTP ${r.status} → ${loc.pathname}?error=${loc.searchParams.get("error")}; session cookie set: ${hasSession}` };
    });
  }
}
rows.push({
  id: "S2-live",
  scenario: "Google OAuth sign-in with a real company Workspace account (allowed) and an outside account (rejected)",
  type: "LIVE",
  result: "BLOCKED",
  notes: "No Google OAuth client configured (M0 prerequisite). Requires an interactive Google sign-in on a deployed environment.",
});

for (const [id, s, ms] of [
  ["S3", "Notion sync now matches test database counts", "M2"],
  ["S4", "Preview as recipient with no unresolved fields", "M4"],
  ["S5", "Test send → simulator Delivery event; campaign metrics unchanged", "M4"],
  ["S6", "Send now to 3 simulator addresses → Sent 3 / Delivered 2 / Bounced 1", "M5"],
  ["S7", "Scheduled send (+3 min, Asia/Ho_Chi_Minh) executes with browser closed", "M6"],
  ["S8", "Open, click, unsubscribe recorded; redirect to snapshot URL", "M7"],
  ["S9", "Cancelled scheduled campaign never dispatches", "M6"],
] as const) {
  rows.push({ id, scenario: s, type: "-", result: "NOT RUN", notes: `Feature not implemented yet (${ms}).` });
}

const finished = new Date();
const summary = {
  baseUrl,
  env: envLabel,
  startedAt: started.toISOString(),
  finishedAt: finished.toISOString(),
  timezoneNote: "timestamps are UTC (ISO 8601); report converts to Asia/Ho_Chi_Minh (UTC+07:00)",
  counts: rows.reduce<Record<string, number>>((a, r) => ((a[r.result] = (a[r.result] ?? 0) + 1), a), {}),
  rows,
};
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "smoke-results.json"), JSON.stringify(summary, null, 2));
const md = [
  `| ID | Scenario | MOCK/LIVE | Result | Notes |`,
  `|---|---|---|---|---|`,
  ...rows.map((r) => `| ${r.id} | ${r.scenario} | ${r.type} | ${r.result} | ${r.notes.replace(/\|/g, "\\|")} |`),
].join("\n");
fs.writeFileSync(path.join(outDir, "smoke-results.md"), md + "\n");
console.log(md);
console.log(`\nsmoke: ${JSON.stringify(summary.counts)} → ${outDir}`);
process.exit(rows.some((r) => r.result === "FAIL") ? 1 : 0);
