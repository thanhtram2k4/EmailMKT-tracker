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
| 2026-11-12 | **M4 authorized** (UI redesign, full personalization, SES test send) on branch `m4-ui-testsend`: local development with a mock/fake SES only. Real test sends, AWS calls, deployment, push and live Notion each need separate approval | User |
| 2026-11-12 | Test-send recipients are typed in by staff (1–3), but the server accepts only addresses on `TEST_RECIPIENT_ALLOWLIST`; the list itself is never shown in the UI | User |
| 2026-11-12 | UI redesign scope: design system plus the existing screens; no placeholder screens for future milestones. Plain CSS with custom properties (no Tailwind). From the `ui-ux-pro-max` skill only the data-dense dashboard style, the Be Vietnam Pro font and the accessibility checklist were adopted; its pink palette and "waitlist" page pattern were rejected as unsuitable for an internal tool. The skill does not replace the QA process | User and implementation |
| 2026-11-12 | Test tooling: processes are spawned as "owned" and cleanup targets only those PIDs and their descendants (`scripts/lib/owned-processes.ts`); a stack run fails if any survive | Implementation |
| 2026-11-13 | **M5 authorized for local work only** (send-now engine and compliance) on branch `m5-send-engine` from `m4-checkpoint`. Mock transport or fake SES client only, `SEND_MODE=disabled\|mock`. No real email, no AWS call, no deployment, no push, no live Notion | User |
| 2026-11-13 | Replies are **always in English** (standing instruction); new reports in English | User |
| 2026-11-13 | M5 roles: members create, edit, review and pause campaigns; only admins approve ("Send now" = per-campaign approval), resume, cancel, resolve uncertain sends, add suppressions and change sending settings | Implementation (proposal); **confirmed by the user 2026-11-13** (see below) |
| 2026-11-13 | Every campaign email must link `{{ unsubscribe_url }}` (review blocks otherwise); the `[QC]`/`[AD]` subject label is a warning only until counsel confirms | Implementation |
| 2026-11-13 | Outside production a campaign message is an `integration_test` for the guard: mock, SES simulator or allowlisted recipients only. Real customer campaigns still need production, `SEND_MODE=live`, the admin toggle and the compliance gate | Implementation |
| 2026-11-13 | Defect found in M5: the M4 test-send reaper cron was registered only when `NOTION_MODE` was not `disabled`. Fixed: send maintenance schedules are always registered (R-M5-13) | Implementation |
| 2026-11-13 | **M6 authorized** ("proceed with the work for M6") after a cross-review of the M1–M5 reports. Same constraints as M5: local only, mock transport, no real email, no AWS call, no deployment, no push, no live Notion. Branch `m6-scheduling`, created on top of the **uncommitted** M5 working tree (M5 not yet committed; awaiting the user's go-ahead) | User |
| 2026-11-13 | Luxon 3.7.2 added for time zones (planned in DESIGN §2) | Implementation |
| 2026-11-13 | **No Claude API.** The app uses no LLM API; none may be added. If an AI feature is ever needed, only the free Gemini API, after asking | User |
| 2026-11-13 | **Roles confirmed by the user:** only admins approve, schedule and send campaigns and resolve uncertain sends; members are restricted to creating, editing, reviewing and pausing | User |
| 2026-11-13 | M5 and M6 committed locally in **one** commit on `m6-scheduling`, tagged `m5-checkpoint` and `m6-checkpoint` (same commit: M6 was built on the uncommitted M5 tree, so no separate M5-only snapshot exists). No remote, no push. From now on each milestone is committed before the next one starts | User and implementation |
| 2026-11-13 | **M7 authorized** (tracking and analytics), local with the mock transport. The user is tracking M0 (AWS, Notion, staging) and the legal answers (3-email cap, `[QC]` label) and will provide them before staging | User |
| 2026-11-13 | Tracking mode `consented_only` by default (open/click tracking only with recorded `email_tracking` consent); admins can choose `all` or `off`. **Pending counsel** (COMPLIANCE §3.3) | Implementation (proposal) |
| 2026-11-13 | Unique openers include implied opens (a click without a recorded open), so CTOR never exceeds 100%; found in the M7 visual review | Implementation |
| 2026-11-13 | M7 committed locally, tag `m7-checkpoint` (no push) | User |
| 2026-11-13 | **M8 authorized** (Notion summaries, security hardening, backups, release) in the mock environment. The final live campaign stays BLOCKED until the user provides the M0 accounts and the legal answers (tracking consent, 3-email cap, `[QC]`) | User |
| 2026-11-13 | Summary pages: the same create request is never retried; a later run creates a page only after a fresh query by Campaign ID finds none (refines the M2 "creates are never retried" rule) | Implementation |
| 2026-11-13 | Client IP for rate limits and IP hashes: `X-Forwarded-For` counted from the right by `TRUSTED_PROXY_HOPS` (Render: 1). Fixes M7, which used the forgeable left-most entry | Implementation |
| 2026-11-13 | Backups: provider-managed backups are primary in production; a provider-independent logical export/restore (`npm run backup`) exists for drills and migration | Implementation |
| 2026-11-13 | Open for the user before production: how AWS credentials are supplied on the host (CLAUDE.md allows only an AWS profile today) | Implementation (question) |

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

**Acceptance:** DNS records verify in SES; the test Notion database is shared with the integration. (The "two real templates" item was withdrawn in M3 rev 2.)

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
- consent-record fields (M2): **schema implemented; consent re-checked at send time (M5).** The disclosed-frequency field and the data-subject lookup tool are still open
- `[QC]`/`[AD]` subject prefix (M4/M5): **review warning only (M5)**, not enforced
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

## M4: UI redesign, personalization and test sends — implemented 2026-11-12 with mock/fake SES only (evidence: [reports/2026-11-12-m4/report.md](../reports/2026-11-12-m4/report.md), in Vietnamese)
Branch `m4-ui-testsend` from `m3-rev2-checkpoint`. Not authorized: real email (including test sends), any AWS call, deployment, push, live Notion.

**UI system and screens**
- [x] Design tokens (light/dark), Be Vietnam Pro (self-hosted), lucide icons, shared components, focus/hover/reduced-motion rules
- [x] App shell: grouped sidebar with `aria-current`, mobile drawer, topbar with send-mode badge and theme toggle, skip link, `lang="vi"`
- [x] Re-skin every existing screen; the M3 paste workflow and editor logic stay unchanged (same test hooks and asserted copy)
- [x] `/settings/sending` (admin, read-only): environment, send mode, SES region/From/configuration set, authorization ref present, allowlist **count**

**Personalization**
- [x] `subject` on template versions (saving a subject creates a new version); merge fields in the subject with the same allowlist and filters
- [x] Unknown field/filter, syntax error, CR/LF in a rendered subject, or a missing value without `default:` blocks a test send
- [x] "Personalization check": active, valid-email contacts affected by missing values, with counts
- [x] Preview as any contact (search), rendered subject shown

**Test sends**
- [x] SES v2 transport behind the existing guard and factory; injected client (fake in tests); outcome mapping accepted / rejected / retryable / unknown
- [x] `test_sends` table (no campaign link); write-ahead `claimed`; idempotency key; rate limits; suppression check; `[TEST]` prefix; audit with redacted address
- [x] Manual recipient entry (1–3); the server refuses any address not on `TEST_RECIPIENT_ALLOWLIST` without revealing the list
- [x] Reaper: `claimed` older than 10 minutes → `unknown`; never retried automatically; "Send again" creates a new row

**Acceptance (MOCK unless stated):**
- [x] Baseline suite on `m3-rev2-checkpoint` recorded before changes
- [x] All existing unit, integration, tooling and E2E tests still pass, including `paste-workflow` and `editor-trial`
- [x] R-UI-01…06, R-PERS-01…03 and 05…07, R-TS-01…12 pass
- [x] Smoke S1–S4, S5-mock/S5-disabled and S10 pass on the final build (re-smoke), MOCK
- [~] R-PERS-04 (test-send opens/clicks never count): structural part PASS (MOCK); tracking is M7, so opens/clicks are NOT RUN
- [ ] S5-LIVE (one real test send to an allowlisted inbox): **needs separate authorization**; Delivery event BLOCKED until a public HTTPS SNS endpoint exists

- Not done in M4: the preheader column exists but is not used in sends or the UI; Firefox/Safari not tested; full Vietnamese UI localisation out of scope

### M4 operation reproduction scenarios (written before implementation)
| ID | Prerequisites | Test data | Steps | Expected (source) |
|---|---|---|---|---|
| OR-UI-01 | Local stack, dev sign-in (MOCK identity), admin and member accounts | Synthetic contacts | Visit every sidebar item by mouse, then by keyboard only (Tab/Enter, skip link) at 1440 px and 375 px | Each page opens; current item marked; admin-only items hidden for members; no horizontal page scroll; focus always visible (brief QA §A; this plan) |
| OR-M3-01 | As above | INTERNAL fixture pasted through the clipboard | Paste HTML → Import → Preview → edit text (formatted block), image, link → Save → reopen from the list → Export | Same result as M3 rev 2: only the edited nodes change; formatting kept; merge fields intact (brief §4; M3 rev 2) |
| OR-TS-01 | As above, `SEND_MODE=mock`, allowlist contains a reserved-domain address | Subject `Chào {{ greeting_name \| default: "bạn" }}` | Save subject → preview as a sample without a greeting → enter an allowlisted address → Send test → view history; then enter a non-allowlisted address | First send recorded `accepted` with `[TEST]` prefix and the fallback "bạn"; non-allowlisted address refused without revealing the list; no campaign metric touched (brief §5; DESIGN M4) |

### M4 regression additions
| ID | Scenario |
|---|---|
| R-UI-01 | Every page renders for admin and member without console errors |
| R-UI-02 | Keyboard: skip link, visible focus, `aria-current` on the active item |
| R-UI-03 | No horizontal page scroll at 375, 768, 1024 and 1440 px (tables scroll inside their wrapper) |
| R-UI-04 | axe: no serious or critical violations, light and dark |
| R-UI-05 | `prefers-reduced-motion` disables transitions |
| R-UI-06 | Navigation never links to `/internal`; members do not see admin items |
| R-PERS-05 | The personalization check lists exactly the contacts missing a value without fallback |
| R-PERS-06 | `{% %}` in the subject is not executed |
| R-PERS-07 | CR/LF in a rendered subject is refused |
| R-TS-01 | Guard × environment × SEND_MODE matrix, including the transport factory |
| R-TS-02 | A non-allowlisted address is refused by the server even when the UI is bypassed |
| R-TS-03 | A suppressed address is refused even if allowlisted |
| R-TS-04 | Double submit with one idempotency key → one provider call |
| R-TS-05 | Provider timeout → `unknown`, no automatic retry; "Send again" creates a new row |
| R-TS-06 | SES error mapping: rejected, throttled, credentials |
| R-TS-07 | `[TEST]` subject prefix and message tags |
| R-TS-08 | Rate limits per user and per day |
| R-TS-09 | `test_sends` rows have no campaign link |
| R-TS-10 | Reaper turns stale `claimed` into `unknown` |
| R-TS-11 | Audit rows contain only the redacted address |
| R-TS-12 | `SEND_MODE=disabled`: the button is disabled and the server refuses |

## M5: Send-now engine and compliance — implemented 2026-11-13 with a mock transport / fake SES client only (evidence: [reports/2026-11-13-m5/report.md](../reports/2026-11-13-m5/report.md))
Branch `m5-send-engine` from `m4-checkpoint`. Not authorized: real email, any AWS call, deployment, push, live Notion.

- [x] Snapshot freeze in one transaction (content, link table, recipients with frozen merge values, one `pending` message each); exclusion counts by reason shown at review; approval must match the reviewed revision and recipient count
- [x] Dispatcher with a session advisory lock per campaign; claims via `FOR UPDATE SKIP LOCKED`; write-ahead `claimed` committed before the provider call; time-budgeted runs re-queue themselves
- [x] Pre-send checks per message: campaign still sending, suppression, marketing consent (setting `crm.require_marketing_consent`), sending guard, rate limiter
- [x] SES send with `msg_id`, `attempt`, `campaign` and `purpose` tags; outcome mapping (sent, failed_permanent, pending on throttle, `blocked` on account/credential errors, unknown). **Custom Message-ID: not set** (reconciliation uses the tags; see DESIGN delta)
- [x] Reaper (`claimed` older than 10 minutes → `unknown`) and dispatcher sweeper, every minute (`campaign_maintenance`); reconciliation from SES events; "Resend uncertain" and "Mark not sent" (admin, after 60 minutes, audited)
- [x] Rate-limit and quota-reserve settings (admin, audited); GetAccount check at start and every 100 sends; exhausted budget → `blocked: quota`
- [x] Pause, resume, cancel (partial report: sent / uncertain / not sent)
- [x] SNS endpoint `/api/ses-events`: topic, certificate host, signature (v1/v2) and timestamp verified; deduplication on the SNS MessageId; automatic suppression on hard bounce and complaint (with Notion write-back); subscription confirmations recorded, never auto-confirmed
- [x] Unsubscribe: `List-Unsubscribe` and `List-Unsubscribe-Post` headers; GET `/u/<token>` shows a confirmation page, POST (button or one-click) suppresses, withdraws consent, queues the Notion update; footer link required by review; opt-out line added to the plain-text part
- [x] Suppressions screen (all staff view; admin adds, never removes)
- [x] Campaigns screens: list, create draft, review, send now (admin), live progress, controls, uncertain sends, recipients, history
- [x] DB guards: forward-only `messages` status, append-only snapshots/recipients/links/transitions, campaigns never deleted
- [ ] Frequency cap (3 per address per 24 h) and `[QC]` subject enforcement: **not done** (compliance proposals pending counsel; `[QC]` is a review warning only)
- [ ] Refusal-confirmation email (COMPLIANCE §1.5): **not done** (needs real sending; pending counsel)

**Acceptance (observed 2026-11-13; MOCK unless stated):**
- [x] A 500-recipient run produces no duplicate sends (R-SEND-01). **PASS (MOCK transport).** Against the real SES simulator: **BLOCKED** (not authorized)
- [x] Two concurrent workers produce no duplicate sends (R-SEND-02). **PASS (MOCK)**: four concurrent dispatchers, lock contention observed
- [x] A worker killed mid-batch re-sends nothing; stale claims become `unknown` (R-SEND-03). **PASS (MOCK)**: in-process and with real worker processes hard-killed (cross-process call log)
- [x] A forced timeout gives `unknown` with no automatic retry; a later event reconciles it to `sent` (R-SEND-04). **PASS (MOCK: real SES transport code with a fake client)**
- [x] Throttling backs off and recovers (R-SEND-05); an exhausted quota gives `blocked` (R-SEND-06); invalid credentials give `blocked` (R-SEND-07). **PASS (MOCK)**
- [x] An address unsubscribed while queued is skipped (R-SEND-08). **PASS (MOCK)**
- [x] Bounces and complaints suppress automatically (R-SEND-09). **PASS (MOCK: synthetic SES event payloads)**
- [x] Pause, resume and cancel behave as specified (R-SEND-10). **PASS (MOCK)**
- [~] S6: Sent 3 / Delivered 2 / Bounced 1. **S6-mock PASS** (worker process + signed SNS messages over HTTP with a local test key). **S6-live BLOCKED** (no authorization, no SES setup, no deployed endpoint)

### M5 operation reproduction scenarios
Written during implementation (not before it), from DESIGN §4.1/§4.3 and this plan.
| ID | Prerequisites | Test data | Steps | Expected (source) |
|---|---|---|---|---|
| OR-CMP-01 | Local stack `SEND_MODE=mock`, admin dev sign-in | 5 synthetic tagged contacts: 3 eligible, 1 without consent, 1 suppressed; pasted email with `{{ unsubscribe_url }}` link | Campaigns → New → tag audience → review → tick confirmation → Send now → wait | Review shows 3 / 2 excluded with reasons; status ends `completed`; Sent 3; exactly one provider call per message (DESIGN §4.1) |
| OR-CMP-02 | As above, after OR-CMP-01 | A recipient's token | Open `/u/<token>` without signing in; check DB; press the button; POST one-click for another token | GET changes nothing; button and one-click suppress, withdraw consent; Suppressions lists both (DESIGN §4.3) |
| OR-CMP-03 | As above; stack test SNS key | Signed Delivery event; a tampered copy | POST both to `/api/ses-events` | 200 processed → Delivered 1 on the campaign; tampered → 403 (DESIGN §2 "Event ingestion") |

### M5 regression additions
| ID | Scenario |
|---|---|
| R-M5-01 | Review blocks on no subject, no unsubscribe link, missing value without fallback, empty audience, disabled guard |
| R-M5-02 | Suppressed / no-consent contacts excluded with counts; staging allowlist refuses other recipients |
| R-M5-03 | An edit after review (revision) or a changed audience makes approval fail |
| R-M5-04 | Snapshot freezes merge values; later CRM edits do not apply; snapshot, recipients and approved snapshot id are immutable |
| R-M5-05 | Cancelling a paused campaign finishes immediately |
| R-M5-06 | Uncertain sends: resolvable only after 60 minutes; resend is attempt 2, audited |
| R-M5-07 | Mark-not-sent is audited; later provider evidence still reconciles to sent |
| R-M5-08 | Unsubscribe: lookup (GET) changes nothing; POST suppresses once, withdraws consent, queues Notion, masked audit |
| R-M5-09 | SNS: v1/v2 signatures accepted; bad signature, tampered body, other topic, non-SNS cert host (never fetched), stale timestamp refused |
| R-M5-10 | SNS subscription confirmation recorded, never confirmed automatically |
| R-M5-11 | DB guards: forward-only message status, no deletes, append-only transitions |
| R-M5-12 | Live customer campaigns cannot be enabled outside production; settings validated |
| R-M5-13 | Send maintenance schedules are registered even with `NOTION_MODE=disabled` (M4 defect regression) |

## M6: Scheduling — implemented 2026-11-13 with a mock transport only (evidence: [reports/2026-11-13-m6/report.md](../reports/2026-11-13-m6/report.md))
Branch `m6-scheduling`, on top of the uncommitted M5 work. Not authorized: real email, AWS calls, deployment, push, live Notion.

- [x] Picker (date, time, IANA zone; default Asia/Ho_Chi_Minh) with the zone shown everywhere; confirmation summary (sender, recipients, subject, local + UTC time, processing-start note with the expected sending duration)
- [x] Store `scheduled_at_utc`, `schedule_tz`, the local time as entered and the offset; reject past times and times less than 2 minutes ahead; reject nonexistent DST times (with a suggested time) and ask about ambiguous ones (offset choice)
- [x] `start_campaign` job (`job_key` `start:<id>`, replace mode, revision in the payload); fenced start (row lock + status + revision + due time); sweeper every minute (`campaign_maintenance`)
- [x] Reschedule (revision++), cancel (job removed; pending messages cancelled), edit → explicit "Unschedule and edit" (draft, revision++, snapshot cleared; DB trigger allows only this snapshot change)
- [x] Overdue policy: within the grace period (setting `scheduling.grace_minutes`, default 30) → proceed with the delay logged in the transition; beyond it → `held_overdue` (not sent) with admin send-now / reschedule / cancel
- [x] Execution-time checks → `blocked` with a reason (dispatcher, from M5) — now also raise an admin alert
- [x] Scheduled list (local + UTC, revision, next action, actual start and delay), worker-down banner (2 minutes), admin alerts (in-app until acknowledged; emailed through the guard, never in `disabled`), audit trail (`campaign_transitions` + `audit_log`)

**Acceptance (observed 2026-11-13; MOCK unless stated):**
- [x] R-SCH-01…04 (time conversion, DST, past/too soon): **PASS** (unit, controlled "now")
- [x] R-SCH-05…16: **PASS** (integration, real PostgreSQL, controlled clock; R-SCH-14 also with real worker restarts)
- [x] S7-mock: scheduled at a whole minute in Asia/Ho_Chi_Minh, browser closed, started by the stack's worker 26–58 ms after the target and completed (E2E OR-SCH-01 and smoke). **PASS (MOCK)**
- [x] S9-mock: cancelled before its time, never dispatched, start job removed. **PASS (MOCK)**
- [ ] S7-live (deployed, laptop off): **BLOCKED** (no hosting; deployment not authorized)

### M6 operation reproduction scenarios
Written during implementation (not before it), from DESIGN §4.2.
| ID | Prerequisites | Test data | Steps | Expected (source) |
|---|---|---|---|---|
| OR-SCH-01 | Mock stack, admin | 3 synthetic tagged contacts; pasted email | Schedule card: past date → DST gap (New York) → follow the suggestion → DST overlap → choose second offset → real time ~4 min ahead in Ho Chi Minh → confirm → Scheduled list → close the browser → wait | Clear refusal / suggestion / choice; summary shows zone and UTC; status scheduled; never early; worker starts within 60 s and completes (DESIGN §4.2) |
| OR-SCH-02 | As above | Same | Schedule +30 min → reschedule +90 min → cancel | Revision 0 → 1; one start job; cancelled; no message sent; job removed (DESIGN §4.2 "Reschedule", "Cancel") |
| OR-SCH-03 | As above | Same | Schedule → Unschedule and edit | Draft with "Schedule removed — review and confirm again" (DESIGN §5) |
| OR-SCH-04 | As above | Same; scheduled time moved 40 min into the past in the DB (simulated outage) | Wait for the worker's sweeper → dashboard → campaign → Send now | Held, nothing sent, alert shown; admin release sends it (DESIGN §4.2 "Late-send grace period") |

## M7: Tracking and analytics — implemented 2026-11-13 with the mock transport only (evidence: [reports/2026-11-13-m7/report.md](../reports/2026-11-13-m7/report.md))
Branch `m7-tracking` from `m6-checkpoint`. Not authorized: real email, AWS calls, deployment, push, live Notion.

- [x] `/o/<token>.gif`, `/c/<token>/<idx>` (GET and HEAD), `/u/<token>` (M5) on `TRACKING_BASE_URL`; opaque tokens; redirects only to the snapshot link table; unknown token / index / untracked message → 404, never a redirect; the query string is never a destination
- [x] Link rewriting and open pixel at send time, decided per message by the setting `tracking.mode` (`consented_only` default — pending counsel; `all`; `off`) and recorded on the message; plain text and test sends are never tracked
- [x] Automated-activity flags (fast clicks < 10 s after delivery/sending, different links within 2 s, HEAD requests, scanner / empty user agents; Google/Yahoo proxy opens labelled, not automated). Raw events kept, flags additive; IP stored only as an HMAC
- [x] Metric engine (DESIGN §4.3): unique per message (with implied opens from clicks), totals raw, rates of Delivered and of Sent, CTOR; recorded and filtered both computed
- [x] Views: campaign analytics (both columns + toggle for the headline and link table), per link (unique / total, first / latest), per recipient timeline (first / latest activity); contact `last_engagement_at` updated by non-automated activity
- [ ] Scanner IP lists and Apple MPP detection: **not done** (no reliable signal without provider IP ranges)
- [ ] Per-contact tracking consent UI is the existing consent form (purpose `email_tracking`); counsel's answer on tracking consent (COMPLIANCE §3.3) is **pending**

**Acceptance (observed 2026-11-13; MOCK unless stated):**
- [x] Three clicks on one link count as 1 unique clicker and 3 recorded clicks (R-TRK-01). **PASS** (integration + E2E over HTTP)
- [x] A tampered link index or token returns 404 with no redirect (R-TRK-02). **PASS** (integration + E2E over HTTP)
- [x] Filtered and recorded counts are both shown (R-TRK-03). **PASS** (integration + E2E)
- [x] GET unsubscribe does not unsubscribe; POST does (R-TRK-04). **PASS** (M5 R-M5-08, OR-CMP-02; smoke S8-mock)
- [x] S8-mock: open, click and one-click unsubscribe over HTTP on a worker-sent campaign. **PASS (MOCK)**
- [ ] A live open and click from an allowlisted inbox are recorded (S8, LIVE). **BLOCKED** (needs real sending, SES, deployed tracking domain)
- [x] R-PERS-04 (from M4) completed: test sends carry no tracking and never count. **PASS**

### M7 operation reproduction scenarios
Written during implementation (not before it), from DESIGN §4.3.
| ID | Prerequisites | Test data | Steps | Expected (source) |
|---|---|---|---|---|
| OR-TRK-01 | Mock stack, admin | 2 synthetic contacts with marketing and tracking consent; email with 2 links | Send now → GET pixel → 3 clicks on link 0 (outside the burst and fast-click windows) → `?url=` injection → tampered token / index → HEAD and scanner clicks on the other recipient → analytics (filtered, then recorded) → recipient timelines | Pixel 200 GIF; 302 only to the snapshot URL; 404 for tampering; 1 unique / 3 recorded on link 0; recorded vs filtered differ by the automated events; timeline shows flags (DESIGN §4.3) |
| OR-ROLE-01 | Mock stack, member | Same | Member creates and reviews a draft; opens a sent campaign | No Send now, no Schedule card, no Cancel (confirmed role rule) |

### M7 regression additions
| ID | Scenario |
|---|---|
| R-TRK-05 | Tracking only per `tracking.mode` and `email_tracking` consent; untracked messages have direct links, no pixel, and their tokens give 404 |
| R-TRK-06 | Link index n in the email = snapshot link n (same selection; mailto, merge-field and MSO-comment links untouched) |
| R-TRK-07 | Automation flags: scanner/empty UA, HEAD, fast click, multi-link burst (earlier click flagged too); proxy opens labelled only |
| R-TRK-08 | Rates of Delivered and of Sent; CTOR ≤ 100% with implied opens; "—" for a zero denominator |
| R-TRK-09 | `last_engagement_at` only from non-automated activity; recipient timeline order and first/latest activity |
| R-TRK-10 | IP stored only as a keyed hash |

## M8: Notion summaries, hardening and release — implemented 2026-11-13 in the mock environment (evidence: [reports/2026-11-13-m8/report.md](../reports/2026-11-13-m8/report.md))
Branch `m8-release` from `m7-checkpoint`. Not authorized: real email, AWS calls, deployment, push, live Notion.

- [x] Notion "Email Campaigns" database (created by an admin under a parent page) with one summary page per finished campaign, rewritten on completion, +24 h, +72 h and +7 days; the page is created only after a fresh query by Campaign ID finds none; failures are recorded and never affect sending
- [x] "Last emailed" and "Last engagement" written back to the contacts' Notion pages through the outbox (`set_engagement`, absolute values, coalesced, rate limited)
- [x] Security review, as regression tests:
  - authentication on every page, route and Server Function except the declared public endpoints; the confirmed role rule pinned per action;
  - CSRF: a foreign-origin Server Function post is refused (Next.js origin check), verified end to end;
  - session cookie HttpOnly + SameSite=Lax; security headers (nosniff, SAMEORIGIN, Referrer-Policy, Permissions-Policy, COOP; HSTS in production builds);
  - public-endpoint abuse limits (`/u` 60, `/c` 300, `/o` 600 per minute per client; SNS 3000/min); client IP from `X-Forwarded-For` counted from the right (`TRUSTED_PROXY_HOPS`) — fixes the forgeable left-most entry used in M7;
  - secrets: no env files or keys tracked (test); token encryption unchanged (AES-256-GCM, M2);
  - PII: no unmasked email in stack logs (`scripts/log-audit.ts`, run after the stack suites);
  - dependencies: `npm audit` — no high/critical; 11 moderate, all development tooling (esbuild dev-server advisory via drizzle-kit; minimatch ReDoS via typescript-eslint), none loaded at runtime; documented in the M8 report
- [x] Backups: provider-independent logical export / restore / verify (`npm run backup`), restore drill (integration test + smoke OPS-1 on the populated stack); runbook [RUNBOOK.md](RUNBOOK.md)
- [x] Full release regression and re-smoke on the final build (MOCK)
- [ ] Provider (Render) backups and a restore of them: **BLOCKED** (no hosting account)
- [ ] Live controlled campaign (4 simulator addresses and 3 allowlisted inboxes; one send-now, one scheduled): **BLOCKED** — needs the M0 accounts, the legal answers (tracking consent, 3-email cap, `[QC]`) and separate approval

**Acceptance:**
- [x] The release suite passes on the final build (MOCK). See the M8 report for counts
- [x] A restore drill succeeds (local logical backup; MOCK data). Provider restore drill: **BLOCKED**
- [ ] The live campaign shows correct per-recipient results, analytics and Notion summaries: **BLOCKED** (live)
- [x] The release report is in `reports/` (`reports/2026-11-13-m8/report.md`)

### M8 regression additions
| ID | Scenario |
|---|---|
| R-NOT-01 | Summary stages: latest due stage written; missed stages covered; nothing after +7 days |
| R-NOT-02 | One summary page per campaign across stages (same page rewritten) |
| R-NOT-03 | An uncertain create (applied then failed) is adopted by the next run, not duplicated |
| R-NOT-04 | Engagement write-back: only changed contacts queued; absolute dates written; re-queued after new engagement |
| R-SEC-01…04 | Headers; CSRF; cookie flags; per-client rate limits that a forged X-Forwarded-For cannot bypass |
| R-SEC-05 | Static: auth on every entry point; admin-only actions; no tracked secrets |
| R-OPS-01 | Restore drill (export → fresh DB → restore → verify), tamper detection, non-empty target refused |
| R-OPS-02 | No unmasked email addresses in stack logs |

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
| S7 | Scheduled send (+3 min, Asia/Ho_Chi_Minh) | Runs with no browser open; scheduled and actual timestamps recorded | LIVE (S7-mock locally from M6) |
| S8 | Open, click, unsubscribe | Events recorded; redirect goes to the snapshot URL; suppression added; Notion update queued | LIVE (S8-mock locally from M7) |
| S9 | Cancel a scheduled campaign | Never dispatched | LIVE (S9-mock locally from M6) |

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
