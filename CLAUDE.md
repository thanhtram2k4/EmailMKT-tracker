# Email MKT Tracker

This is an internal email-marketing app for a single company. Campaigns go out through Amazon SES, contacts come from a Notion CRM, and the app supports one-time scheduled sends, open and click tracking, and analytics.

- Requirements: `PROJECT_BRIEF.md`
- Approved design: `docs/DESIGN.md`
- Milestones, test checklists and decisions log: `docs/PLAN.md`
- Legal and consent prerequisites: `docs/COMPLIANCE.md`
- Connecting the real Notion test database: `docs/NOTION_SETUP.md`
- Test evidence: `reports/`
- How to run: `README.md`

## Status
- **M1 (foundation) is implemented** and checkpointed as Git tag `m1-checkpoint`. See `reports/2026-11-12-m1/report.md`.
- **M2 (Notion CRM) is implemented with mocks and synthetic data only.** Tag `m2-checkpoint`. See `reports/2026-11-12-m2/report.md`.
- **M3 (editor trial) is done.** Tag `m3-checkpoint`, branch `m3-editor-trial`. See `reports/2026-11-12-m3/report.md` (Vietnamese).
  - The editor recommendation is **provisional**: only one unconfirmed real template was available, and no real email client was tested.
- **M4 and later are not authorized yet.**
- **Verified only locally:** Google OAuth, staging, CI and live Notion are unverified.

Ask the user explicitly before any of these:
- starting a new milestone
- deploying
- connecting to any real Notion workspace (`NOTION_MODE=live`) or importing real contacts
- changing live Notion data
- sending any real email
- pushing to a remote or creating one

Approving a plan or a document does not count as permission for any of them.

## Language
- **Replies:** in **Vietnamese**. That is the user's latest instruction (M3, 2026-11-12); M1–M2 replies were in English at their request. Follow the most recent explicit instruction.
- **Repository docs:** stay in English. Test reports follow the reply language.
- **App:** UI and email content may be in Vietnamese.

## Stack
TypeScript on Node 22.18+ (developed on Node 24).
- Web: Next.js 16.4, with `src/proxy.ts` and route handlers.
- Worker: Graphile Worker 0.18, in `src/worker/`.
- Database: PostgreSQL with Drizzle. Migrations live in `drizzle/` and are applied by `scripts/migrate.ts`.
- Sign-in: Better Auth 1.7 with Google, limited to the company domain and the staff allowlist. A dev magic link exists only when APP_ENV is local or test.
- Logging: pino.
- Tests: Vitest and Playwright.
- Local Postgres: `embedded-postgres` (real PostgreSQL 17 binaries; no Docker needed). Its exit hooks are partly removed in `scripts/lib/embedded-pg.ts`, because they forced exit code 0.
- Notion: API version pinned to `2026-03-11` (`src/lib/notion/`). The CRM sync, outbox, consent and eligibility code is in `src/lib/crm/`. The mock server is in `scripts/notion-mock/`.
- Planned: SES v2 in ap-southeast-1, LiquidJS, Luxon, and hosting on Render in Singapore.

## Commands
| Task | Command |
|---|---|
| First-time setup | `npm install` · `npm run setup:local` · `npm run playwright:install` |
| Local DB (keep this terminal open) | `npm run db:start` |
| Migrate / staff | `npm run db:migrate` · `npm run staff:add -- admin@example.com admin` |
| Run | `npm run dev:all` (web on :3000 and worker) · `npm run dev:crm` (plus the mock Notion server on :4010) |
| Mock Notion control | `npm run notion:mock:ctl -- list` · `set <key> subscription=Subscribed` · `trash <key>` · `fault 503 3` |
| Checks | `npm run lint` · `npm run typecheck` · `npm run test:unit` · `npm run test:integration` · `npm run test:tooling` |
| Editor trial | `npm run e2e -- tests/e2e/editor-trial.spec.ts` (results in `test-results/editor-trial/`) · `npx tsx scripts/editor-trial/probe.ts` (counts only) |
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
- **Not permitted under the M1 or M2 authorizations:** any real email sending or deployment.

## CRM rules (M2; do not break)
- **Identity is the Notion page id.** An email change keeps the same contact. Suppressions and consent follow the **address**.
- **Notion owns** full name, greeting name, email, company, tags and the consent evidence reference. **The app owns** suppression and subscription state, consent records, last emailed and last engagement.
- **Notion values and suppressions:**
  - `Unsubscribed`, `Bounced` or `Complained` in Notion **adds** a suppression and records consent as withdrawn.
  - `Subscribed` or blank never removes a suppression and never means consent. The app writes the suppressed value back through `notion_outbox`.
- **Consent:**
  - Imports never grant consent; contacts default to `unknown`. Only a staff entry with an evidence reference or note can grant, and a grant never lifts a suppression.
  - DB constraints enforce this, and `suppressions` and `consent_records` are append-only (triggers).
- **Sync safety:**
  - The incremental cursor advances only after a complete listing with no page errors.
  - Archiving missing pages happens only after a complete *full* listing.
  - One sync at a time (advisory lock).
- **Notion access:** `NOTION_MODE=live` requires `NOTION_AUTHORIZATION_REF`. The token lives only encrypted in the DB (`APP_ENCRYPTION_KEY`); never in env files, logs or Git.
- **Notion retries:**
  - 429 and 529 are always retried, using `Retry-After`.
  - Other 5xx are retried only for reads and idempotent property writes.
  - Creates are never retried.
- **Tests use `scripts/notion-mock/` only.** All synthetic addresses are on reserved domains (`example.com/org/net`, `*.example`).

## Template rules (M3; do not break)
- **Structure-preserving editing.** Parse and serialize with cheerio in htmlparser2 mode (`src/lib/templates/html-doc.ts`); never use an HTML5 tree builder (it inserts `<tbody>`). An edit changes only the targeted node.
- **Sanitize on every import and save** (`src/lib/templates/sanitize.ts`).
  - Keep DOCTYPE, tables, inline styles, `<style>`/`@media` and MSO conditional comments.
  - HTML between `<!--[if !mso]><!-->` and `<!--<![endif]-->` **must still be sanitized**: it is visible in non-Outlook clients.
- **Merge fields:** Liquid **output only** (`{{ field | filter }}`), with allowlisted fields and filters, and HTML-escaped values. Liquid tags (`{% %}`) are never executed (file access).
- **Plain-text part:** never change letter case.
- **Preview** runs in a sandboxed iframe with CSP `script-src 'none'`. Editor annotations (`data-emt-id`) never reach stored or exported HTML.
- **Template versions are immutable** (DB trigger). Saving always creates a new version.
- **Real customer templates:** keep inputs under `.local/` (git-ignored). Never commit their content or screenshots.

## Test tooling rules
- Spawn long-running test processes with `spawnOwned` (`scripts/lib/owned-processes.ts`). Clean up with `cleanupOwned`, which targets only this run's PIDs and their descendants. Never kill by name or port.
- Exit codes are regression-tested (`npm run test:tooling`). A deliberately failing test must exit non-zero.

## Windows process hygiene
- Stopping a background task here does **not** stop its child processes (next, worker, postgres, mock server).
- After any manual dev check:
  - stop Postgres with `pg_ctl stop -D .local/postgres`;
  - end the project's node processes;
  - verify that no process or dev port (3000, 3100, 4010, 4011, 54321, 54331, 54332) is left.

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
- Use only fixture addresses at reserved domains (`example.com`, `example.net`, `example.org`, `*.example`) in tests.
- Check exit codes as well as test output. A run that reports failures must exit non-zero (see the M2 report).
