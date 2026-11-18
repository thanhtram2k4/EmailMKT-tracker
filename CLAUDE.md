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
- **M3 (editor) is done, corrected in rev 2.** Branch `m3-editor-trial`; tags `m3-checkpoint` (trial) and `m3-rev2-checkpoint` (paste workflow). See `reports/2026-11-12-m3-rev2/report.md` (Vietnamese).
  - The primary workflow is **Paste HTML → Import → Preview → Edit → Save → Reopen**. Real templates are **not** a requirement; never search the user's folders for templates.
  - Browser (Chromium) validation only. Gmail, Outlook and mobile rendering are NOT RUN.
- **M4 (UI redesign, personalization, test sends) is authorized for local work with mock/fake SES only.** Branch `m4-ui-testsend`. See `reports/2026-11-12-m4/report.md` (Vietnamese). A real SES test send needs separate approval.
- **M5 (send-now engine and compliance) is authorized for local work with a mock transport or fake SES client only.** Branch `m5-send-engine` from `m4-checkpoint`. See `reports/2026-11-13-m5/report.md`. Real sends, AWS calls, deployment and push still need separate approval.
- **M5 and M6 are committed** together on branch `m6-scheduling`; tags `m5-checkpoint` and `m6-checkpoint` point to the same commit. See `reports/2026-11-13-m5/report.md` and `reports/2026-11-13-m6/report.md`.
- **M7 (tracking and analytics) is committed**, tag `m7-checkpoint`. See `reports/2026-11-13-m7/report.md`.
- **M8 (Notion summaries, hardening, backups, release) is authorized in the mock environment** (2026-11-13). Branch `m8-release` from `m7-checkpoint`. The live controlled campaign is BLOCKED until the user provides the M0 accounts and legal answers. Commit each milestone before starting the next.
- **Roles (confirmed by the user):** only admins approve, schedule and send campaigns and resolve uncertain sends; members create, edit, review and pause.
- **No Claude API.** The app uses no LLM API. Never add one; if an AI feature is ever needed, only the free Gemini API, after asking the user (keys never in Git).
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
- **Replies:** **always English** (standing instruction, 2026-11-13). M3–M4 replies and reports were in Vietnamese; that no longer applies.
- **Repository docs and new test reports:** English. Do not rewrite the earlier Vietnamese reports.
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
- SES v2 (`@aws-sdk/client-sesv2`, ap-southeast-1): test sends (M4) and campaign messages (M5), always behind the guard. UI: lucide-react, Be Vietnam Pro (`@fontsource`), axe via `@axe-core/playwright` in E2E.
- Luxon (time zones, M6). Planned: hosting on Render in Singapore.

## Commands
| Task | Command |
|---|---|
| First-time setup | `npm install` · `npm run setup:local` · `npm run playwright:install` |
| Local DB (keep this terminal open) | `npm run db:start` |
| Migrate / staff | `npm run db:migrate` · `npm run staff:add -- admin@example.com admin` |
| Run | `npm run dev:all` (web on :3000 and worker) · `npm run dev:crm` (plus the mock Notion server on :4010) |
| Mock Notion control | `npm run notion:mock:ctl -- list` · `set <key> subscription=Subscribed` · `trash <key>` · `fault 503 3` |
| Checks | `npm run lint` · `npm run typecheck` · `npm run test:unit` · `npm run test:integration` · `npm run test:tooling` |
| Paste workflow / editor trial | `npm run e2e -- tests/e2e/paste-workflow.spec.ts` · `npm run e2e -- tests/e2e/editor-trial.spec.ts` (results in `test-results/editor-trial/`; extra local inputs only via `EDITOR_TRIAL_EXTRA_DIR`) |
| E2E / smoke | `npm run e2e` · `npm run smoke:local` (each starts an isolated stack, runs, then tears it down) |
| Mock test sends | `npm run e2e:mock-send` · `npm run smoke:mock-send` (stack with `SEND_MODE=mock`) |
| Mock campaigns (M5–M7) | `npm run e2e:mock-campaign` (campaign UI, unsubscribe, signed SES event, scheduling incl. a real ~4-minute wait, tracking) |
| Backups (M8) | `npm run backup -- export --out <dir>` · `restore --from <dir> --database-url <url>` · `verify …` · `drill --out <dir>` (local only) |
| Log PII audit (M8) | `tsx scripts/log-audit.ts <stack log dir>…` |
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
- **The SES transport** is built only by the factory, after the guard approves and `SES_FROM_ADDRESS` is set (test sends from M4, campaign messages from M5).
- **Campaign messages outside production are integration tests** (`campaignPurpose`): the guard then allows only mock, SES simulator addresses (`simulator`) or allowlisted addresses (`allowlist`), and review blocks approval otherwise.
- **Not permitted under the M1–M5 authorizations:** any real email sending (including test sends), any AWS call, or deployment.

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
  - Creates are never retried. M8 summary pages: the same create request is never retried; a later run may create a page only after a fresh query by Campaign ID finds none (`src/lib/crm/campaign-summaries.ts`).
- **Tests use `scripts/notion-mock/` only.** All synthetic addresses are on reserved domains (`example.com/org/net`, `*.example`).

## Template rules (M3; do not break)
- **Structure-preserving editing.** Parse and serialize with cheerio in htmlparser2 mode (`src/lib/templates/html-doc.ts`); never use an HTML5 tree builder (it inserts `<tbody>`). An edit changes only the targeted node.
- **Sanitize on every import and save** (`src/lib/templates/sanitize.ts`).
  - Keep DOCTYPE, tables, inline styles, `<style>`/`@media` and MSO conditional comments.
  - HTML between `<!--[if !mso]><!-->` and `<!--<![endif]-->` **must still be sanitized**: it is visible in non-Outlook clients.
- **Merge fields:** Liquid **output only** (`{{ field | filter }}`), with allowlisted fields and filters, and HTML-escaped values. Liquid tags (`{% %}`) are never executed (file access).
- **Text edits keep formatting** (`src/lib/templates/text-runs.ts`).
  - The default edit is in the preview; a text-only change is saved as a `text-runs` op that rewrites text nodes only (typed text is escaped, never parsed as HTML).
  - An edit that **removes** formatting must never be saved silently: the editor blocks saving until the user chooses undo, keep or HTML source, and the server refuses it without `acceptFormatChange`. A warning alone is not enough.
  - The TipTap toolbar is an opt-in conversion that first lists exactly what it removes, with undo.
- **Product UI vs internal tools:** the Emails page shows Paste HTML + Import and the user's own saved emails only. Fixtures and the GrapesJS comparison stay in `/internal/editor-lab` (admin, APP_ENV local/test).
- **Plain-text part:** never change letter case.
- **Preview** runs in a sandboxed iframe with CSP `script-src 'none'`. Editor annotations (`data-emt-id`) never reach stored or exported HTML.
- **Template versions are immutable** (DB trigger). Saving always creates a new version.
- **Real customer templates:** keep inputs under `.local/` (git-ignored). Never commit their content or screenshots.

## Test-send rules (M4; do not break)
- Code: `src/lib/sending/test-send.ts`, `src/lib/sending/ses-transport.ts`.
- In every send mode (mock included), each typed address must be on `TEST_RECIPIENT_ALLOWLIST` or be an SES simulator address. Refusals never reveal the list. Suppressed addresses are refused even if allowlisted.
- Write-ahead `claimed` row per address, unique on (idempotency key, address). `retryable` and `unknown` are never retried automatically; "Send again" is a new, audited row with `resend_of`. A DB trigger enforces forward-only status and blocks deletes. The worker reaper turns claims older than 10 minutes into `unknown`.
- SES SDK retries stay off (`maxAttempts: 1`). AWS credentials come only from an AWS profile outside the repo; never in env files, logs, chat or Git.
- `test_sends` has no campaign link. Audit rows store masked addresses only. Subjects get `[TEST] `.
- The local stack accepts only `--send-mode disabled|mock`.
- Unresolved personalization (unknown field or filter, syntax, no subject, a missing value without `default:`, a line break in the subject) blocks a test send.

## Campaign rules (M5; do not break)
- Code: `src/lib/campaigns/` (service, dispatcher, events, sns, unsubscribe, suppression). Design: DESIGN §3.4 and §4.1.
- **Approval** freezes the snapshot, links, recipients (with merge values) and one `pending` message each, in ONE transaction. The approver confirms the exact `schedule_revision` and recipient count they reviewed. Only admins approve, resume, cancel and resolve uncertain sends.
- **Review blocks** on: no subject, unresolved personalization, no `{{ unsubscribe_url }}` link in the body, no recipients, or a guard refusal. The `[QC]`/`[AD]` subject label is a warning only (pending counsel).
- **Dispatcher:** session advisory lock per campaign; claims with `FOR UPDATE SKIP LOCKED` are committed before the provider call; per message it re-checks campaign status, suppression, consent and the guard. Throttling → back to `pending` with backoff; account/credential problems → `pending` + campaign `blocked`; anything uncertain → `unknown`. SES SDK retries stay off.
- **DB guards:** `messages` status is forward-only (trigger `messages_guard`); snapshots, recipients, links and `campaign_transitions` are append-only; campaigns are never deleted.
- **Uncertain sends** may be resent or marked not sent only by an admin, after 60 minutes, audited; a resend is `attempt_no + 1`.
- **Events:** `/api/ses-events` accepts only verified SNS messages for `SES_EVENTS_TOPIC_ARN` (cert host `sns.<region>.amazonaws.com`, signature v1/v2, 24 h window). It never calls `SubscribeURL`. Events dedupe on the SNS MessageId. Hard bounce and complaint suppress automatically.
- **Unsubscribe:** `GET /u/<token>` only confirms; `POST` (button or RFC 8058 one-click) suppresses. The token is opaque; the page shows a masked address.
- **Test-only hooks** (`SNS_TEST_PUBLIC_KEY_FILE`, `MOCK_TRANSPORT_LOG`, `MOCK_SEND_DELAY_MS`) are refused outside APP_ENV local/test.
- Send maintenance cron (`campaign_maintenance`, `test_send_reaper`) is registered whatever `NOTION_MODE` is.

## Scheduling rules (M6; do not break)
- Code: `src/lib/campaigns/schedule.ts` (schedule, reschedule, unschedule, fenced start), `schedule-time.ts` (zone/DST logic), `alerts.ts`.
- Store `scheduled_at_utc` + `schedule_tz` (+ the local time as entered and the offset). Default zone Asia/Ho_Chi_Minh. Show the zone and UTC everywhere a schedule appears.
- Reject past times, times less than 2 minutes ahead, nonexistent DST times (suggest the next valid time); an ambiguous DST time needs an explicit offset.
- Scheduling uses the same snapshot freeze as Send now (`approveCampaign`). Admin only.
- **Fenced start:** `startScheduled` locks the row and moves `scheduled → queued` only if still scheduled, at the payload's revision, and due. The start job (`start:<id>`, replace mode) and the every-minute sweeper both use it; never rely on the queue.
- Reschedule increments `schedule_revision`; unschedule returns to draft (revision++, snapshot cleared, unsent messages cancelled — the only snapshot change the DB trigger allows).
- Late start beyond `scheduling.grace_minutes` (default 30) → `held_overdue`, not sent, admin alert. Default is NOT to send.
- Admin alerts are emailed only through the guard (never in `disabled`).

## Tracking rules (M7; do not break)
- Code: `src/lib/campaigns/tracking.ts`, `analytics.ts`, routes `src/app/o/[file]`, `src/app/c/[token]/[idx]`.
- Click redirects go ONLY to the URL at that index in the message's snapshot link table; anything else is 404. Never take a destination from the request.
- Tracking is decided per message at send time (`tracking.mode`, default `consented_only` pending counsel) and stored in `messages.tracking_enabled`; untracked tokens give 404. Test sends are never tracked.
- Link rewriting runs on the frozen template before merge rendering with the same selection as `extractLinks()`.
- Raw events are kept; automation flags are additive. Store IPs only as an HMAC; truncate user agents.
- Metrics count only the current snapshot; unique openers include implied opens from clicks.

## Notion summaries, security and backups (M8; do not break)
- Summaries (`src/lib/crm/campaign-summaries.ts`): one page per finished campaign in the "Email Campaigns" database, rewritten on completion, +24 h, +72 h, +7 days; failures never affect sending. "Last emailed" / "Last engagement" go through `notion_outbox` (`set_engagement`, absolute values).
- Every page, route and Server Function checks the signed-in staff member, except the public endpoints declared in `tests/unit/security-static.test.ts`; admin-only actions are pinned there too. A new action or route must be classified in that test.
- Public endpoints (`/u`, `/o`, `/c`, `/api/ses-events`) are rate limited per client. The client IP comes from `X-Forwarded-For` counted from the right by `TRUSTED_PROXY_HOPS`; never use the left-most entry.
- Logs must not contain unmasked email addresses (`scripts/log-audit.ts` runs after the stack suites).
- Backups (`npm run backup`): restore only into an empty database migrated to the same version; the drill only against a local server. Backups contain personal data: never commit them.

## UI rules (M4)
- Plain CSS tokens in `src/app/globals.css` (light/dark, cookie theme). No Tailwind. lucide icons, no emoji icons.
- Staff pages render inside `AppShell` (`src/app/app-shell.tsx`). Never link `/internal` from the chrome.
- Keep every existing `data-testid` and the copy that tests assert. Never add a test id starting with `region-` (the editor tests prefix-match it). Test ids must stay unique per page (`getByTestId` is strict).
- Do not change the editor's logic for styling purposes (`template-editor.tsx`, `preview/route.ts`).
- E2E screenshots go to the folder named by `PASTE_WORKFLOW_SHOTS`, `UI_SHOTS`, `TEST_SEND_SHOTS` or `CAMPAIGN_SHOTS`. Never overwrite committed evidence from an earlier cycle.
- Some checked-out files use CRLF. When scripting edits, normalize line endings first, and prefer the Edit/Write tools for code that contains backslashes.

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
