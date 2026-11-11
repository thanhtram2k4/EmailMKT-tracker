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

## Open items (need user input)
- [ ] Confirm assumptions A1–A7 ([DESIGN.md](DESIGN.md) "Assumptions")
- [ ] Wix reference screenshots or a recording (audience, editor, test send, review, schedule picker, scheduled list, stats)
- [ ] Two real builder-exported HTML templates
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
- [ ] Notion internal integration (read, update, insert); CRM database or parent page shared with it; a **separate test database**
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

## Pending compliance changes (proposals; not approved scope)
Proposed in [COMPLIANCE.md](COMPLIANCE.md) §6, to be adopted only after counsel review and the user's confirmation:
- consent-record fields (M2)
- `[QC]`/`[AD]` subject prefix (M4/M5)
- sender identity and opt-out footer (M3/M5)
- refusal-confirmation email (M5)
- frequency cap of 3 per address per 24 hours (M5)
- per-contact tracking consent (M7)
- data-subject request workflow (M8)

## M2: Notion CRM
- [ ] Connect the integration; token encrypted at rest
- [ ] Create the CRM database (fixed schema) **or** map an existing database (property types validated)
- [ ] Full sync, incremental sync (`last_edited_time` with a 5-minute overlap, every 10 minutes), "Sync now", nightly reconcile (trashed pages → archived)
- [ ] Identity by Notion page ID; normalized email; duplicate and invalid detection; Data issues screen
- [ ] Subscription rules: Notion "Unsubscribed" → add suppression; Notion "Subscribed" never removes a suppression
- [ ] Outbox writer: about 2.5 requests/s, honours `Retry-After`, backs off on 5xx/529
- [ ] Contacts screen with filters

**Acceptance:**
- [ ] Repeated syncs create no duplicate contacts (R-SYNC-01)
- [ ] Pages sharing an email are flagged and excluded from audiences (R-SYNC-02)
- [ ] An email change keeps the same contact (R-SYNC-03); a trashed page is archived (R-SYNC-04)
- [ ] A suppressed contact marked "Subscribed" in Notion stays suppressed, and Notion is rewritten (R-SYNC-05)
- [ ] A simulated 429 backs off and the sync succeeds (R-SYNC-06, MOCK)
- [ ] A live sync against the test database matches the counts (S3, LIVE)

## M3: Editor spike → templates
- [ ] Spike: both real templates × (click-to-edit, GrapesJS). Edit headline, paragraph, image, link and button; export; DOM diff; test sends to Gmail web and Android, Outlook desktop and web, iOS Mail → `reports/<date>-editor-spike/`
- [ ] Editor decision recorded in the decisions log
- [ ] Import pipeline: sanitize (keep tables, inline styles and MSO comments; strip scripts, forms, handlers and `javascript:` URLs), re-host images to S3, extract links, lint (102 KB clipping, missing alt text, image-heavy content)
- [ ] Editor, paste of formatted text, plain-text part, desktop (600 px) and mobile (375 px) preview in a sandboxed iframe
- [ ] Reusable templates and saved drafts

**Acceptance:**
- [ ] Both templates show no layout regression after edits in the tested clients (screenshots attached)
- [ ] An XSS payload corpus is stripped (R-TPL-02)
- [ ] An image-only template triggers a warning (R-TPL-03)

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
