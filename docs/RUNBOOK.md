# Runbook: operating Email MKT Tracker

For the people who deploy and run the app. Design: [DESIGN.md](DESIGN.md). Legal gate: [COMPLIANCE.md](COMPLIANCE.md). Notion setup: [NOTION_SETUP.md](NOTION_SETUP.md).

> **Status (2026-11-13):** everything here has been exercised **locally with mocks only**. No deployment, real SES send or live Notion connection has happened yet. Steps marked **(unverified)** have never been run against the real service.

## 1. Components
| Part | What it does | Must be always on |
|---|---|---|
| Web (`npm run build` + `npm start`) | Staff UI, server actions, public endpoints `/u`, `/o`, `/c`, `/api/ses-events`, `/healthz` | yes |
| Worker (`npm run worker`) | Dispatching, scheduled starts, sweepers and reapers (every minute), Notion sync (10 min) and nightly reconcile, Notion outbox, summaries (5 min), admin alert emails | **yes** — scheduled campaigns start only if it runs |
| PostgreSQL | All state, the job queue (Graphile Worker) and DB-level safety rules (triggers) | yes |
| Amazon SES (ap-southeast-1) | Sending; events → SNS → `/api/ses-events` | — |
| Notion | CRM (read), app-owned fields and campaign summaries (write) | not required for sending |

Run exactly **one web instance and one worker** unless you also accept: rate limits and the send pacing are per process (each instance counts separately).

## 2. Configuration and secrets
Secrets live in the host's secret store (Render environment), never in Git, chat or tickets. `.env.example` lists every variable.

| Setting | Notes |
|---|---|
| `APP_ENV` | `staging` or `production` on the host. Also set at **build** time (HSTS is added only to production builds). |
| `DATABASE_URL`, `APP_BASE_URL` (https), `TRACKING_BASE_URL` | Tracking subdomain for `/u`, `/o`, `/c` (e.g. `https://t.company.com`) |
| `BETTER_AUTH_SECRET`, `APP_ENCRYPTION_KEY` (+ `APP_ENCRYPTION_KEY_ID`) | Generate per environment (32+ random bytes). Rotating `BETTER_AUTH_SECRET` signs everyone out and changes the tracking IP hashes. `APP_ENCRYPTION_KEY` rotation: add the new key id, keep the old one until the Notion token is re-saved |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAIL_DOMAINS` | Google OAuth client, consent screen **Internal**, scopes `openid email profile` |
| AWS credentials | IAM principal limited to `ses:SendEmail` on the identity and `ses:GetAccount`. Locally an AWS profile; **on the host: decision pending** (host secret store or a role) — CLAUDE.md currently allows only a profile |
| `SES_FROM_ADDRESS`, `SES_CONFIGURATION_SET`, `SES_EVENTS_TOPIC_ARN`, `SES_TIMEOUT_MS` | Verified identity; configuration set with an SNS destination; the topic whose events are accepted |
| `SEND_MODE` | `disabled` (default) · `mock` (never in production) · `simulator` / `allowlist` (+ `SEND_AUTHORIZATION_REF`, `TEST_RECIPIENT_ALLOWLIST`) · `live` (production only) |
| `NOTION_MODE=live`, `NOTION_AUTHORIZATION_REF` | The Notion **token is entered in the app** (Settings → Notion) and stored encrypted |
| `TRUSTED_PROXY_HOPS` | `1` on Render (the load balancer appends the client IP to `X-Forwarded-For`). `0` = no proxy: client IP unknown |
| Never on a host | `DEV_LOGIN_ENABLED`, `SNS_TEST_PUBLIC_KEY_FILE`, `MOCK_TRANSPORT_LOG`, `MOCK_SEND_DELAY_MS` (refused at startup outside local/test) |

Runtime settings (admin, audited, Settings → Sending): rate per second (default 5, capped at 80% of the SES max rate), daily-quota reserve (10%), late-start grace period (30 min), tracking mode (`consented_only` pending counsel), live customer campaigns (production only).

## 3. First deployment (unverified)
1. M0 accounts: Google OAuth client; AWS account, SES domain identity with Easy DKIM and custom MAIL FROM, configuration set → SNS topic (Send, Delivery, Bounce, Complaint, Reject, DeliveryDelay), account-level suppression, production access; DNS (SPF, DKIM, DMARC `p=none` + `rua`); Notion integration + test database; Render web + worker + Postgres (Singapore).
2. Set the environment (§2). Build with `APP_ENV` set; start web and worker.
3. `npm run db:migrate` (app migrations + the job-queue schema). `npm run staff:add -- <email> admin` for the first admin.
4. Subscribe `https://<app>/api/ses-events` to the SNS topic. The app **records** the SubscriptionConfirmation (audit `ses_events.SubscriptionConfirmation`) but never confirms it: confirm it in the AWS console.
5. Check `/healthz` = 200 (database ok, worker heartbeat < 60 s).
6. Run the smoke suite against the environment (`npm run smoke -- --base-url https://… --env staging`); live rows need the approvals listed in PLAN.md.

## 4. Go-live gate for customer campaigns
All of: `APP_ENV=production`, `SEND_MODE=live`, an admin enables live campaigns, every item in the [COMPLIANCE.md](COMPLIANCE.md) gate is checked (consent basis, `[QC]` label, sender block and opt-out, refusal confirmation, frequency cap, tracking consent, data-subject procedure), and the **live controlled campaign** (PLAN M8: 4 simulator addresses + 3 allowlisted inboxes, one send-now and one scheduled) has passed. Until then the guard refuses customer campaigns.

## 5. Daily operations
- **Dashboard:** worker status, admin alerts (held / blocked campaigns), upcoming schedules.
- **Scheduled** page: banner when the worker has not reported for 2 minutes.
- **Sync** page: Notion sync runs and failed outbox writes (status, last emailed / engagement, summaries do not block sending).
- **Suppressions:** add an address on request (admin, with a note). Suppressions are never removed by the app.
- **Data-subject requests** (COMPLIANCE §3.6): no tool yet — suppress the address, record consent as withdrawn on the contact page, and remove the person in Notion; deletion from the database needs a manual, audited procedure (to be designed with counsel).

## 6. Incidents
| Symptom | What it means | Do |
|---|---|---|
| `/healthz` 503, worker banner | Worker down | Restart the worker. Scheduled campaigns that are late but within the grace period start on their own; later ones become **held** |
| Campaign **held (overdue)** | Started later than the grace period; nothing sent | Admin decides on the campaign page: Send now, Reschedule or Cancel |
| Campaign **blocked: quota** | SES daily quota (minus the reserve) used up | Wait for the rolling 24 h window or raise the quota; then Resume |
| **blocked: credentials / account_paused / send_refused** | Keys revoked, SES paused, guard refused | Fix the cause (keys, SES account, configuration), then Resume. Nothing was sent for the waiting messages |
| **Uncertain** messages | Provider did not answer; may or may not be sent | Wait: SES events reconcile them. After 60 min an admin may Resend (duplicate risk) or Mark not sent. Never automatic |
| No Delivered/Bounce counts | Events not arriving | Check the SNS subscription is confirmed, `SES_EVENTS_TOPIC_ARN`, and audit rows `ses_events.rejected` (signature / topic / timestamp) |
| Notion errors on Sync page | Token revoked, sharing removed, rate limits | Re-enter the token / share the database; outbox writes retry with backoff; summaries retry on the next run (looking the page up first) |
| HTTP 429 on `/u`, `/o`, `/c` | Per-client abuse limit (60 / 600 / 300 per minute) | Expected under scanning; check `TRUSTED_PROXY_HOPS` if every visitor is limited together |

## 7. Backups and restore
- **Primary:** the hosting provider's managed backups for Postgres (Render daily snapshots / point-in-time recovery, depending on the plan) **(unverified)**. Restore those with the provider's tools.
- **Logical backup (provider-independent):** `npm run backup -- export --out <dir>` writes every table as JSON lines with a manifest (row counts, checksums, migration count). Restore: migrate an **empty** database to the same version (`DATABASE_URL=<new> npm run db:migrate`), then `npm run backup -- restore --from <dir> --database-url <new>` (verifies automatically). `npm run backup -- verify …` re-checks.
- Not in the backup: the job queue (the minute sweepers recreate dispatch jobs and start due scheduled campaigns) and the migrations table. The encryption key is **not** in the backup: keep `APP_ENCRYPTION_KEY` (and its id) separately, or the Notion token must be re-entered.
- A backup contains personal data and the encrypted Notion token: store it encrypted with restricted access; delete old exports.
- **Drill** (quarterly, and before go-live): `npm run backup -- drill --out <dir>` on a local copy (export → fresh database → restore → verify → drop). The smoke suite runs the same drill (OPS-1) on the local stack. A drill of the provider's restore on staging is still to do.

## 8. Release procedure
1. `npm run lint`, `npm run typecheck`, `npm run test:unit`, `npm run test:integration`, `npm run test:tooling`.
2. `npm run e2e`, `npm run e2e:mock-send`, `npm run e2e:mock-campaign`.
3. `npm run smoke:local` and `npm run smoke:mock-send` (re-smoke on the final build), then `tsx scripts/log-audit.ts <stack log dirs>` (no unmasked addresses in logs).
4. On staging: deploy the same commit, run the smoke suite, then the live checks that are authorized.
5. Write the report in `reports/<date>-<cycle>/` (PASS / FAIL / BLOCKED / NOT RUN, MOCK / LIVE). Never mark a mocked check as live.
