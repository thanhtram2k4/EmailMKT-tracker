# Plan: milestones and test checklists

The design lives in [DESIGN.md](DESIGN.md). Requirements live in [../PROJECT_BRIEF.md](../PROJECT_BRIEF.md). Test evidence goes in [../reports/](../reports/).

Legend: `[ ]` todo · `[x]` done (with a link to evidence) · results are PASS / FAIL / BLOCKED / NOT RUN, each tagged MOCK or LIVE.

## Decisions log
| Date | Decision | Source |
|---|---|---|
| 2026-11-12 | Expected volume: 500–2,000 recipients per campaign | User |
| 2026-11-12 | Delivered/Bounced required from day one, so campaigns send through **Amazon SES** | User |
| 2026-11-12 | Gmail API sending deferred to Phase 2; Google OAuth used for app sign-in only in the MVP | User |
| 2026-11-12 | Templates are HTML exported from a builder; editor chosen by the M3 spike | User and plan |
| 2026-11-12 | Replies in English (overrides the brief's request for Vietnamese) | User |
| 2026-11-12 | Plan approved. Implementation **not** yet authorized; docs only | User |
| 2026-11-12 | **M1 authorized**: app code, project-local dependencies, local DB and worker, local tests. **No real email sending and no deployment.** Stop after M1 | User |
| 2026-11-12 | Transport question settled: SES was the user's explicit choice ("Sending service + Gmail (Recommended)"), not only a recommendation. M1 still ships only a provider-neutral `MailTransport` interface and a mock | User (earlier answer) |
| 2026-11-12 | Sending rules clarified: no customer campaigns from local or staging. Real non-production tests need explicit authorization (`SEND_AUTHORIZATION_REF`) and a recipient allowlist or the SES simulator. `SEND_MODE` gains `disabled` (default) and `mock` | User and implementation |
| 2026-11-12 | Local Postgres uses `embedded-postgres` (real PostgreSQL 17 binaries, project-local). Docker Desktop is installed but its daemon was not running, and starting it was out of scope | Implementation |
| 2026-11-12 | The local/test-only dev sign-in uses the Better Auth magic-link plugin, with the link returned on screen and never emailed. It goes through the same domain and allowlist gate as Google, and is rejected at startup in staging and production | Implementation |
| 2026-11-12 | Legal and consent verification is a prerequisite for enabling real customer campaigns ([COMPLIANCE.md](COMPLIANCE.md) gate). Nothing is confirmed by the company yet | User |
| 2026-11-12 | M1 checkpointed in local Git: commit `3f11649`, tag `m1-checkpoint`. No remote, no push | User and implementation |
| 2026-11-12 | **M2 authorized** with synthetic contacts and mocked Notion only. No live CRM, no real contacts, no deployment, no email | User |
| 2026-11-12 | SES for campaigns plus Gmail as the Phase 2 option is a **confirmed** decision (re-confirmed when M2 was authorized) | User |
| 2026-11-12 | Consent records are append-only per address and purpose. Imports default to **unknown** and can never grant consent (app rule plus DB constraint). Granted consent requires a staff entry with evidence and never lifts a suppression | User and implementation |
| 2026-11-12 | Eligibility requires recorded marketing consent by default (setting `crm.require_marketing_consent`, default true). **Pending counsel**; enforced at send time from M5 | Implementation (proposal) |
| 2026-11-12 | `NOTION_MODE=disabled\|mock\|live`. `live` requires `NOTION_AUTHORIZATION_REF` and the official API host. `mock` is loopback only and refused in production. The Notion token is entered in the admin UI and stored AES-256-GCM-encrypted (`APP_ENCRYPTION_KEY`); it is never an env var | Implementation |
| 2026-11-12 | Notion API version pinned to 2026-03-11 after re-verifying the official docs (query is `POST /v1/data_sources/{id}/query`; 10,000-result cap per query handled) | Implementation |
| 2026-11-12 | Client pacing set to 2.5 req/s with burst 1, so there are at most about 3 requests in any second. Found by an M2 test; the earlier burst of 3 could exceed a strict 3/s | Implementation |
| 2026-11-12 | M2 checkpointed: commit `63cad42`, tag `m2-checkpoint`, branch `m2-notion-crm` | Implementation |
| 2026-11-12 | **M3 authorized** (editor trial), on branch `m3-editor-trial` from `m2-checkpoint`. `SEND_MODE=disabled`; no email, no deployment, no real Notion | User |
| 2026-11-12 | **Confirmed by the user:** contacts with *unknown* consent stay **ineligible for marketing sends by default**, but remain fully manageable in the CRM (`crm.require_marketing_consent=true`) | User |
| 2026-11-12 | Reply language switched to **Vietnamese** at the user's request (M3 onwards); repository docs stay English | User |
| 2026-11-12 | **Editor recommendation (PROVISIONAL):** (a) structure-preserving editor for imported builder HTML, with (c) TipTap for text blocks and paste. (b) GrapesJS is **not** used for imported templates: its no-edit export changed Chromium rendering by 2.9–13.8% and collapsed fixture B's columns. Provisional because only one unconfirmed real template was available and no real email client was tested | Trial result, pending user |
| 2026-11-12 | **M3 requirement corrected by the user.** The primary workflow is Paste HTML → Import → Preview → Edit text/images/links → Save → Reopen. The two-real-templates prerequisite is **withdrawn**; templates are not searched for on the user's machine. The product UI has no fixture gallery or GrapesJS controls; internal fixtures and the GrapesJS comparison live in `/internal/editor-lab` (admins, APP_ENV local/test only) | User |
| 2026-11-12 | **Text editing preserves formatting by default (M3 rev 2).** Text is edited in the preview; a text-only edit rewrites text nodes only. Any edit that would remove formatting needs an explicit choice (undo, keep, or HTML source); the toolbar (TipTap) is an opt-in conversion that first lists what it removes. The server refuses a formatting removal without `acceptFormatChange` | Implementation |
| 2026-11-12 | M3 rev 2 checkpointed on `m3-editor-trial`: tag `m3-rev2-checkpoint` (the original `m3-checkpoint` is kept) | Implementation |
| 2026-11-12 | Test tooling: processes are spawned as "owned" and cleanup targets only those PIDs and their descendants (`scripts/lib/owned-processes.ts`); a stack run fails if any survive | Implementation |

## Open items (need user input)
- [ ] Confirm assumptions A1–A7 ([DESIGN.md](DESIGN.md) "Assumptions")
- [ ] Wix reference screenshots or a recording (audience, editor, test send, review, schedule picker, scheduled list, stats)
- [x] ~~Two real builder-exported HTML templates~~ **Withdrawn by the user (M3 rev 2)**: not an M3 prerequisite. The user pastes their own HTML into the app
- [ ] Authorization for test sends to designated inboxes, or a rendering service (Litmus / Email on Acid), to validate Gmail/Outlook/mobile rendering
- [ ] Legal: research recorded in [COMPLIANCE.md](COMPLIANCE.md). Counsel review is still needed (8 questions). Correction: the Decree 91 subject label is `[QC]` or `[AD]`, not "[ADV]" (secondary source)
- [ ] Choice of sending subdomain (e.g. `news.company.com`) and tracking subdomain

---

## M0: Setup and discovery (user tasks, run in parallel with M1–M2)
- [ ] Google Cloud project, OAuth consent screen set to **Internal**, web client with staging and production redirect URIs (`openid email profile` only)
- [ ] Allowlist of staff emails and their roles (admin or member)
- [ ] AWS account with billing alerts; SES in ap-southeast-1
  - [ ] Domain verified with Easy DKIM; custom MAIL FROM set
  - [ ] Configuration set with an event destination → SNS topic (Send, Delivery, Bounce, Complaint, Reject, DeliveryDelay)
  - [ ] Account-level suppression enabled
  - [ ] Production access requested
  - [ ] IAM principal limited to `ses:SendEmail` on the identity, plus `ses:GetAccount`
  - [ ] S3 bucket for images
- [ ] DNS: SPF, DKIM, DMARC (`p=none` with `rua`); app, tracking and From subdomains; Google Postmaster Tools
- [ ] Notion internal connection (read, update, insert; no user information) by a Workspace Owner; a **separate TEST page or database** shared with it. Exact steps: [NOTION_SETUP.md](NOTION_SETUP.md)
- [ ] Render account with staging and production
- [ ] Test inboxes: personal Gmail, Outlook, iPhone with Apple Mail; 20–50 sample contacts (missing greeting names, duplicates, diacritics)

**Acceptance:** DNS records verify in SES; the test Notion database is shared with the integration; both templates are received.

## M1: Foundation — implemented 2026-11-12 (evidence: [reports/2026-11-12-m1/report.md](../reports/2026-11-12-m1/report.md))
- [x] Repository scaffold (Next.js 16.4, TypeScript, ESLint), `.env.example`, CI workflow (`.github/workflows/ci.yml`; written but **not run**, since there is no remote repository)
- [x] Postgres with Drizzle migrations: Better Auth tables, `staff_allowlist`, `audit_log` (append-only via DB trigger), `app_settings`, `worker_heartbeats`, `system_probes`
- [x] Better Auth with Google; company domain enforced (`hd` plus our own server-side check); allowlist; roles (admin, member); access re-checked on every request; revoking access ends sessions
- [x] Worker process (Graphile Worker), heartbeat table, `/healthz` (200 or 503)
- [x] pino logging with correlation ids (`x-request-id` from the proxy, carried into auth logs and audit rows; `job_id` and `task` for jobs); secret-path redaction; free-text evidence redaction
- [x] `SEND_MODE` guard (disabled, mock, simulator, allowlist, live) enforced at startup (web and worker exit), per send, and in the transport factory. No real transport exists
- [x] Smoke harness (`npm run smoke`, `npm run smoke:local`) and report template
- [ ] Staging deploy over HTTPS: **BLOCKED** (no Render account; deployment not authorized)

**Acceptance (observed 2026-11-12):**
- [x] An allowed staff account signs in; an account from outside the domain or the allowlist is rejected (E2E). **PASS (MOCK identity: dev sign-in).** Google OAuth itself: **BLOCKED**
- [x] A job enqueued before a worker restart runs after it. **PASS** (integration, real PostgreSQL)
- [ ] Staging is reachable over HTTPS: **BLOCKED**
- [~] Smoke S1–S2: S1 **PASS** and S2a–c **PASS**, against the local stack (MOCK identity). S2-live (Google) **BLOCKED**. Staging smoke **NOT RUN**

**Carried to M0/M2:** Google OAuth client (Internal), a staging environment, a live Google sign-in check, and a first CI run once a repository remote exists.

**Corrections to M1, found during M2** (details in the M2 report):
- Integration-test failures exited **0**: `embedded-postgres`'s exit hook overrode Vitest's exit code. M1's integration tests did genuinely pass (each result was observed), but a failure would not have failed CI. **Fixed in M2.**
- The M1 report said no servers were left running after the developer check. That was wrong: the `db:start`, `next dev` and worker processes were still running and were stopped during M2. On Windows, stopping a background task does not stop its child processes.

## Pending compliance changes (proposals; not approved scope)
Proposed in [COMPLIANCE.md](COMPLIANCE.md) §6, to be adopted only after counsel review and the user's confirmation:
- consent-record fields (M2): **schema implemented.** The disclosed-frequency field and the data-subject lookup tool are still open
- `[QC]`/`[AD]` subject prefix (M4/M5)
- sender identity and opt-out footer (M3/M5)
- refusal-confirmation email (M5)
- frequency cap of 3 per address per 24 hours (M5)
- per-contact tracking consent (M7)
- data-subject request workflow (M8)

## M2: Notion CRM — implemented 2026-11-12 with mocks and synthetic data (evidence: [reports/2026-11-12-m2/report.md](../reports/2026-11-12-m2/report.md))
- [x] Connect the integration; token encrypted at rest (AES-256-GCM with associated data, versioned key, rotation support; only the last 4 characters are shown)
- [x] Create the CRM database (fixed schema) **or** map an existing database (property types validated; mapping suggested in English or Vietnamese; admin reviews and saves)
- [x] Full sync, incremental sync (`last_edited_time` with a 5-minute overlap, every 10 minutes), "Sync now", nightly full reconcile (19:00 UTC = 02:00 Asia/Ho_Chi_Minh): trashed or missing pages are archived, never deleted
- [x] Identity by Notion page ID; normalized email (trim plus lowercase); NFC-normalized Vietnamese text; duplicate and invalid detection; Data issues screen; admin chooses a duplicate's primary
- [x] Subscription rules: Notion `Unsubscribed`/`Bounced`/`Complained` adds a suppression and records consent as withdrawn. Notion `Subscribed` or blank never removes a suppression; the app writes the suppressed value back through the outbox
- [x] Consent records: append-only; status, source, effective and recorded time, recorder, evidence reference and note, consent text version. Imports never grant (DB constraint)
- [x] Outbox writer: shared 2.5 req/s limiter, honours `Retry-After`, backs off on 5xx/529, coalesces per page, race-safe, failures visible on the Sync screen
- [x] Contacts screen with filters (search, tag, state, issue, suppression, consent, eligibility), Vietnamese collation; contact detail with consent history; Sync screen (runs, counts, errors, outbox)
- [x] Sync status and error reporting: `sync_runs` (status, counts, cursor, error), `sync_issues` (page-level data and processing problems), audit events
- [x] Local mock Notion server, 40 synthetic contacts, control CLI (`npm run notion:mock`, `npm run notion:mock:ctl`)
- [x] Setup guide for the real test database: [NOTION_SETUP.md](NOTION_SETUP.md)

**Acceptance (observed 2026-11-12; all MOCK except S3-live):**
- [x] R-SYNC-01: repeated syncs create no duplicate contacts, consent or suppression rows. **PASS (MOCK)**
- [x] R-SYNC-02: pages sharing an email are flagged and excluded from audiences until a primary is chosen. **PASS (MOCK)**
- [x] R-SYNC-03: an email change keeps the same contact; the old suppressed address stays suppressed and is flagged. **PASS (MOCK)**
- [x] R-SYNC-04: trashed pages are archived; pages missing from a complete full listing are archived; incremental syncs never archive; restored pages reactivate. **PASS (MOCK)**
- [x] R-SYNC-05: a suppressed contact marked `Subscribed` in Notion stays suppressed and Notion is rewritten; this is echo-free. **PASS (MOCK)**
- [x] R-SYNC-06: simulated 429 (`Retry-After`) and 5xx are backed off and the sync succeeds; exhausted retries end partial, with the cursor kept and nothing archived. **PASS (MOCK)**
- [ ] S3-live: a live sync against the separate Notion test database matches the counts. **BLOCKED** (no test database or token; live access not authorized)

## M3 rev 2: Paste workflow (corrected requirement) — run 2026-11-12 (evidence: [reports/2026-11-12-m3-rev2/report.md](../reports/2026-11-12-m3-rev2/report.md), in Vietnamese)
Primary workflow, tested through the UI in Chromium with a labelled INTERNAL fixture pasted via the real clipboard (`tests/e2e/paste-workflow.spec.ts`):
- [x] A visible **Paste HTML** box and **Import** button are the main entry point (Emails page). File upload is optional, under "More import options". **PASS**
- [x] A normal email document needs **no CSS selector**; the whole document is imported (DOCTYPE, head styles, MSO kept). The selector is an advanced option only. **PASS**
- [x] No synthetic-fixture buttons, template gallery or GrapesJS controls in the product UI. Internal tools are at `/internal/editor-lab` (admin only, 404 outside APP_ENV local/test; members get the forbidden page). **PASS**
- [x] Import → preview → edit text (two blocks, one with a coloured `<span>`, a `<font>` and a merge field), an image and a link inside a text block → save → reopen from the list → export. **PASS**: the exported v2 equals v1 with exactly those four changes; every other byte is identical
- [x] Personalization placeholders are intact (all v1 merge fields present plus the inserted one); recipient previews show values and fallbacks after reopening. **PASS**
- [x] Formatting loss is handled with real alternatives, not a warning: in-place text edits keep formatting; a formatting-removing edit blocks saving until the user chooses **Undo**, **Keep** (recorded in the version note) or **HTML source**; the toolbar conversion lists what it removes first and can be undone. **PASS**
- [x] Sanitization unchanged in strength: HTML-source edits are sanitized on save (script, `onerror`, `javascript:` removed); text typed in the preview is stored as text (`&lt;b&gt;`). **PASS**
- [x] A pasted fragment (no `<html>`/`<body>`) imports and edits. **PASS**
- [ ] Gmail, Outlook and mobile mail-app rendering. **NOT RUN** (sending not authorized). Browser validation is Chromium only
- [ ] Image hosting (relative or local images are flagged, not re-hosted). **NOT DONE** (planned with S3)

## M3: Editor trial — run 2026-11-12 (evidence: [reports/2026-11-12-m3/report.md](../reports/2026-11-12-m3/report.md), in Vietnamese)
> Superseded in part by **M3 rev 2** above: the real-template inputs below are no longer required, and the TipTap span loss is fixed by formatting-preserving editing.
- [~] Trial on templates × (a) structure-preserving, (b) GrapesJS, (c) TipTap paste:
  - edited headline/paragraph, image, link and button; saved; reopened; exported;
  - DOM and pixel comparison in **Chromium**;
  - inputs: SYNTHETIC A, SYNTHETIC B, and **real candidate #1** (`wildcats-email-gmail.html`, sha256 `3c781d16…`, not yet confirmed by the user);
  - **real template #2 BLOCKED** (not found);
  - **test sends to Gmail/Outlook/iOS: NOT RUN** (sending not authorized).
- [x] Editor recommendation recorded (decisions log). **PROVISIONAL**
- [~] Import pipeline:
  - sanitize: keeps tables, inline styles, `<style>`, DOCTYPE and MSO comments; strips scripts, forms, handlers, `javascript:`, meta refresh and CSS expressions;
  - link and image extraction; lint (102 KB clipping, missing alt, image-heavy, relative/http/localhost images, phishing-like link text, missing unsubscribe);
  - optional "import only `#selector`";
  - **image re-hosting to S3: NOT DONE** (relative images are flagged only).
- [x] Editor: click-to-edit regions in a sandboxed preview (no scripts; CSP; SAMEORIGIN), TipTap text blocks with merge-field picker, plain-text part, desktop 640 px and mobile 375 px preview, preview as recipient with fallbacks
- [x] Templates with immutable versions (each save is a new version, DB trigger); reopen any version; export HTML or TXT

**Acceptance (observed 2026-11-12):**
- [~] No layout regression after import and edits: **Chromium only**.
  - Import is pixel-identical (0.00%) for A and the real candidate. Edits change only edited nodes.
  - In real email clients: **NOT RUN**.
- [x] R-TPL-02: an XSS payload corpus is stripped (fixture B + unit tests). **PASS**
- [x] R-TPL-03: an image-heavy template triggers a warning (unit). **PASS**
- [x] Regression coverage for the M1/M2 tooling defects: exit code (a failing test exits non-zero) and owned-process cleanup. **PASS**, each proven by a mutation check

## M4: Personalization and test sends
- [ ] LiquidJS with strict variables and allowlisted fields, in subject and body; `default:` fallbacks; HTML escaping
- [ ] Preview as a chosen recipient
- [ ] Unresolved fields block review and list the affected recipients
- [ ] Test sends to the allowlist or simulator; a separate `test_sends` table; `[TEST]` subject prefix

**Acceptance:**
- [ ] A missing greeting name renders its fallback (R-PERS-01); Vietnamese diacritics render correctly (R-PERS-02)
- [ ] An unknown field blocks review (R-PERS-03)
- [ ] Test sends and their opens and clicks never change campaign metrics (R-PERS-04; S5 LIVE)

## M5: Send-now engine and compliance
- [ ] Snapshot freeze in one transaction (content, links, recipients with frozen merge values); exclusion counts shown at review
- [ ] Dispatcher with an advisory lock; claims via `FOR UPDATE SKIP LOCKED`; write-ahead `claimed` state
- [ ] Pre-send checks: campaign still sending, suppression, token bucket
- [ ] SES send with a `msg_id` tag and a custom Message-ID; outcome mapping (sent, failed_permanent, pending on throttle, unknown)
- [ ] Reaper (`claimed` older than 10 minutes → `unknown`); reconciliation from SES events; UI for "Resend uncertain" and "Mark not sent" (audited)
- [ ] Rate limit setting; quota check with a reserve → `blocked: quota`
- [ ] Pause, resume, cancel (partial report)
- [ ] SNS endpoint with signature verification; event deduplication; automatic suppression on hard bounce and complaint
- [ ] Unsubscribe: `List-Unsubscribe` and `List-Unsubscribe-Post`; GET shows a confirmation page, POST is one-click; footer link
- [ ] Suppressions screen

**Acceptance:**
- [ ] A 500-recipient run against the simulator produces no duplicate sends (R-SEND-01)
- [ ] Two concurrent workers produce no duplicate sends (R-SEND-02)
- [ ] A worker killed mid-batch re-sends nothing; stale claims become `unknown` (R-SEND-03)
- [ ] A forced timeout gives `unknown` with no automatic retry; a later event reconciles it to `sent` (R-SEND-04)
- [ ] Throttling backs off and recovers (R-SEND-05); an exhausted quota gives `blocked` (R-SEND-06); invalid credentials give `blocked` (R-SEND-07)
- [ ] An address unsubscribed while queued is skipped (R-SEND-08)
- [ ] Bounces and complaints suppress automatically (R-SEND-09)
- [ ] Pause, resume and cancel behave as specified (R-SEND-10)
- [ ] Simulator Delivered and Bounced counts are correct (S6, LIVE)

## M6: Scheduling
- [ ] Picker (date, time, IANA zone; default Asia/Ho_Chi_Minh) with the zone shown everywhere; confirmation summary
- [ ] Store `scheduled_at_utc` and `schedule_tz`; reject past times and times less than 2 minutes ahead; reject nonexistent DST times and ask about ambiguous ones
- [ ] `start_campaign` job (`job_key`, revision in the payload); fenced start; sweeper every minute
- [ ] Reschedule (revision++), cancel (job removed), edit → draft
- [ ] Overdue policy: within the 30-minute grace period → proceed and log the delay; beyond it → `held_overdue`
- [ ] Execution-time checks → `blocked` with a reason
- [ ] Scheduled list, worker-down banner, admin alert emails, audit trail

**Acceptance:** R-SCH-01…R-SCH-16 PASS (MOCK, with a controlled clock). Live check S7: a campaign scheduled 5 minutes ahead runs with the browser closed and the laptop off, within 60 seconds of the target.

## M7: Tracking and analytics
- [ ] `/o`, `/c`, `/u` endpoints on the tracking subdomain; opaque tokens; redirects only to snapshot links
- [ ] Automated-activity flags (fast clicks, multi-link bursts, HEAD requests, scanner user agents and IPs, proxy opens)
- [ ] Metric engine (definitions in DESIGN §4.3); toggle between recorded and filtered events
- [ ] Views by campaign, recipient (timeline) and link; first and latest activity

**Acceptance:**
- [ ] Three clicks on one link count as 1 unique clicker and 3 recorded clicks (R-TRK-01)
- [ ] A tampered link index or token returns 404 with no redirect (R-TRK-02)
- [ ] Filtered and recorded counts are both shown (R-TRK-03)
- [ ] GET unsubscribe does not unsubscribe; POST does (R-TRK-04)
- [ ] A live open and click from an allowlisted inbox are recorded (S8, LIVE)

## M8: Notion summaries, hardening and release
- [ ] Notion "Email Campaigns" database with summaries (on completion, +24 h, +72 h, +7 d); last-emailed and last-engagement written back
- [ ] Security review: auth, CSRF, secrets, token encryption, PII redaction, public-endpoint abuse limits
- [ ] Backups and a restore drill; runbook
- [ ] Full release regression; re-smoke on the final build
- [ ] Live controlled campaign (4 simulator addresses and 3 allowlisted inboxes; one send-now, one scheduled) — **needs separate approval from the user**

**Acceptance:** the release suite passes; the restore drill succeeds; the live campaign shows correct per-recipient results, analytics and Notion summaries; the release report is in `reports/`.

## Phase 2: Gmail transport (not scheduled yet)
- [ ] OAuth connect and disconnect (`gmail.send`); encrypted refresh token with a versioned key; quota with a reserve for company email; `invalid_grant` → `blocked: reconnect`; transport chosen per campaign

---

## Scenario catalogue

### Smoke suite (also the re-smoke for every final build)
| ID | Scenario | Pass criteria | Type |
|---|---|---|---|
| S1 | App and worker start | `/healthz` reports the DB ok and a worker heartbeat under 60 s old | LIVE (staging) |
| S2 | Sign-in | An allowed account signs in; an outsider is rejected | LIVE |
| S3 | Notion sync now | Finishes; counts match the test database | LIVE |
| S4 | Preview as recipient | No unresolved fields; fallbacks render | LIVE |
| S5 | Test send | Simulator success → Delivery event; campaign metrics unchanged | LIVE |
| S6 | Send now (3 simulator addresses) | Sent 3, Delivered 2, Bounced 1 | LIVE |
| S7 | Scheduled send (+3 min, Asia/Ho_Chi_Minh) | Runs with no browser open; scheduled and actual timestamps recorded | LIVE |
| S8 | Open, click, unsubscribe | Events recorded; redirect goes to the snapshot URL; suppression added; Notion update queued | LIVE |
| S9 | Cancel a scheduled campaign | Never dispatched | LIVE |

Pass rule: every scenario must PASS. Any FAIL blocks the release. A BLOCKED scenario needs a stated reason and the user's acceptance. If the tech lead supplies their own checklist, it replaces this interpretation of "re-smoke".

### Scheduling regression (controlled clock, isolated queue)
| ID | Scenario |
|---|---|
| R-SCH-01 | Asia/Ho_Chi_Minh local time → UTC → display round trip |
| R-SCH-02 | Non-default zone round trip |
| R-SCH-03 | DST gap rejected; DST overlap requires an offset choice (America/New_York) |
| R-SCH-04 | Past time and times less than 2 minutes ahead are rejected |
| R-SCH-05 | No early dispatch: still `scheduled` at T−1 s |
| R-SCH-06 | Starts within the 60 s target after T |
| R-SCH-07 | Reschedule invalidates the old job; only the latest revision runs |
| R-SCH-08 | Cancel before T → never dispatched |
| R-SCH-09 | Cancel at the moment of dispatch → a single consistent outcome; in-flight sends reported |
| R-SCH-10 | An edit after scheduling → draft; a new snapshot is required |
| R-SCH-11 | A Notion name edit after approval → the frozen value is used |
| R-SCH-12 | A recipient who unsubscribes before T is excluded at send time |
| R-SCH-13 | Duplicate triggers and sweeper overlap → started exactly once |
| R-SCH-14 | Worker restart while scheduled → still executes; restart while sending → nothing sent twice |
| R-SCH-15 | Outage within the grace period → sent late with the delay logged; beyond it → `held_overdue`, not sent |
| R-SCH-16 | At execution, revoked or invalid SES credentials or an exhausted quota → `blocked` with a reason, never shown as sent; recovery does not repeat uncertain sends |

### Bug reproduction template
Prerequisites · Test data · Steps · Expected (cite the brief or design section) · Actual · Reproduced? (yes / no, with attempts) · Fix commit · Retest of the original case · Regressions rerun
