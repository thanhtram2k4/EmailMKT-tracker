# Email MKT Tracker

This is an internal email-marketing app for a single company. Campaigns go out through Amazon SES, contacts come from a Notion CRM, and the app supports one-time scheduled sends, open and click tracking, and analytics.

- Requirements: `PROJECT_BRIEF.md`
- Approved design: `docs/DESIGN.md`
- Milestones, test checklists and decisions log: `docs/PLAN.md`
- Legal and consent prerequisites: `docs/COMPLIANCE.md`
- Test evidence: `reports/`
- How to run: `README.md`

## Status
- **M1 (foundation) is implemented.** See `reports/2026-11-12-m1/report.md`.
- **M2 and later are not authorized yet.**

Ask the user explicitly before any of these:
- starting a new milestone
- deploying
- changing live Notion data
- sending any real email

Approving a plan or a document does not count as permission for any of them.

## Language
Reply to the user in **English**, because they asked for it; this overrides the brief's request for Vietnamese. The app's UI and email content may be in Vietnamese.

## Stack
TypeScript on Node 22.18+ (developed on Node 24).
- Web: Next.js 16.4, with `src/proxy.ts` and route handlers.
- Worker: Graphile Worker 0.18, in `src/worker/`.
- Database: PostgreSQL with Drizzle. Migrations live in `drizzle/` and are applied by `scripts/migrate.ts`.
- Sign-in: Better Auth 1.7 with Google, limited to the company domain and the staff allowlist. A dev magic link exists only when APP_ENV is local or test.
- Logging: pino.
- Tests: Vitest and Playwright.
- Local Postgres: `embedded-postgres` (real PostgreSQL 17 binaries; no Docker needed).
- Planned: SES v2 in ap-southeast-1, LiquidJS, Luxon, and hosting on Render in Singapore.

## Commands
| Task | Command |
|---|---|
| First-time setup | `npm install` · `npm run setup:local` · `npm run playwright:install` |
| Local DB (keep this terminal open) | `npm run db:start` |
| Migrate / staff | `npm run db:migrate` · `npm run staff:add -- a@b.com admin` |
| Run | `npm run dev:all` (web on :3000 and worker) |
| Checks | `npm run lint` · `npm run typecheck` · `npm run test:unit` · `npm run test:integration` |
| E2E / smoke | `npm run e2e` · `npm run smoke:local` (each starts an isolated stack, runs, then tears it down) |
| New migration | edit `src/lib/db/schema.ts`, then `npm run db:generate` |

## Sending rules (do not break)
- **Customer campaigns must never be sent from local, test or staging environments.** They require all of the following:
  - APP_ENV=production with SEND_MODE=live;
  - an admin enabling live campaigns;
  - per-campaign approval (from M5);
  - the `docs/COMPLIANCE.md` gate cleared.
- **Real integration tests outside production** may later use designated test accounts, verified test recipients, or the SES mailbox simulator, but only under these conditions:
  - explicit authorization from the user, recorded in `SEND_AUTHORIZATION_REF`;
  - a recipient allowlist (`SEND_MODE=simulator` or `allowlist`).
- **SEND_MODE values:**
  - `disabled` (default) refuses every send;
  - `mock` keeps everything in-process with no network, and is not allowed in production;
  - `live` is rejected at startup unless APP_ENV=production.
- **Enforcement points:**
  - `src/lib/config.ts` (startup validation);
  - `src/lib/sending/guard.ts` (per-send decision);
  - `src/lib/sending/transport.ts` (factory).
- **M1 contains no real transport.** The factory refuses to build one.
- **Not permitted under the M1 authorization:** any real email sending or deployment.

## Invariants (do not break)
- **Never resubscribe automatically.** Suppressions are never removed by sync or other automation. Notion "Subscribed" never overrides a suppression.
- **Never retry an `unknown` send automatically.** Resolve it through SES events, or let the user explicitly choose resend or mark-not-sent.
- Commit a message as `claimed` before calling the provider. Stale `claimed` messages become `unknown`, never `pending`.
- Campaign start uses a fenced conditional update on `status`, `schedule_revision` and `scheduled_at_utc`. Correctness must not depend on queue deduplication.
- Approved snapshots are immutable. Any edit returns the campaign to `draft` and increments `schedule_revision`.
- Check suppression (and, once adopted, the frequency cap) immediately before each send.
- Click redirects go only to URLs stored in the snapshot's link table. Tokens are opaque, and URLs never contain email addresses.
- Store times in UTC and keep the IANA zone. Default zone: Asia/Ho_Chi_Minh.
- Test sends never count toward campaign metrics.
- `audit_log` is append-only, enforced by a DB trigger. Access is decided by `staff_allowlist` and re-checked on every request.
- Session-hook denials must return `false`, not throw. Throwing produced a raw JSON 403 instead of the access-denied page (see the M1 report).

## Testing and evidence rules
- Mark every result as **MOCK** or **LIVE**. A passing mock (including the dev sign-in) does not prove that Google, SES or Notion work.
- Never report PASS unless the test was run and its result observed. Use BLOCKED or NOT RUN when access is missing.
- Take expected behavior from the brief and design, not from what the current code does.
- For a bug, reproduce it before fixing (record failed reproductions too). Afterwards, rerun the original case and the affected regressions. Keep the first failure in the report.
- Redact tokens, cookies, keys and contact emails in reports (`src/lib/redact.ts`, plus a manual check). Never send reports to anyone automatically.
- Use only fixture addresses at reserved domains (`example.com`, `example.net`) in tests.
