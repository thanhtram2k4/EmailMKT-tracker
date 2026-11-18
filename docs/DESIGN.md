# Email Marketing Tool — Approved Design (plan approved 2026-11-12)

Baseline: `PROJECT_BRIEF.md` rev 2. Status: approved plan. M1 was authorized and implemented on 2026-11-12; later milestones are not yet authorized.

> **Updates since approval.** The text below is unchanged; this note records the deltas. Full details are in the decisions log in [PLAN.md](PLAN.md).
> - `SEND_MODE` also has `disabled` (the default) and `mock`. Customer campaigns are never sent from local or staging environments.
> - Local development uses `embedded-postgres` instead of Docker.
> - A local/test-only dev sign-in exists. It is rejected at startup in staging and production.
> - Assumption A3: the legal research is in [COMPLIANCE.md](COMPLIANCE.md). The Decree 91 subject label is `[QC]` or `[AD]`, not "[ADV]". Compliance is a gate before real customer campaigns can be enabled.
> - **M2 (CRM):**
>   - §3.1 is extended:
>     - `consent_records` (append-only per address and purpose; imports default to unknown and never grant);
>     - `duplicate_resolutions`, `sync_state` and `sync_issues`;
>     - `suppressions` made append-only by trigger.
>   - Contact `state` is `active` or `archived`. Duplicate and invalid status are separate fields (`is_duplicate`, `email_status`) rather than extra states.
>   - Eligibility for audiences also requires recorded marketing consent by default (`crm.require_marketing_consent`, pending counsel). M5 must re-check suppression and consent at send time.
>   - Notion API version `2026-03-11` (data sources). The 10,000-result query cap is handled by time-ordered chunking.
>   - Notion access modes `disabled`, `mock` and `live`. The token is encrypted in the DB; see [NOTION_SETUP.md](NOTION_SETUP.md).
> - **M3 (editor trial):**
>   - §4.4 trial run on synthetic templates A and B, plus one unconfirmed real candidate.
>   - Provisional choice: (a) structure-preserving click-to-edit, plus (c) TipTap for text blocks and paste. (b) GrapesJS is not used for imported HTML.
>   - Merge fields use Liquid output syntax only; tags are never executed.
>   - The preview width is 640/375 px.
>   - Template versions are immutable.
>   - Image re-hosting to S3 is still to do. See `reports/2026-11-12-m3/report.md`.
> - **M5 (send-now engine, implemented locally with mocks; see `reports/2026-11-13-m5/report.md`):**
>   - Campaign statuses in M5: `draft, queued, sending, paused, blocked, cancelling, cancelled, completed, completed_with_issues, failed`. There is no stored `in_review` status: the review is computed on demand, and approval requires the exact `schedule_revision` and recipient count that were reviewed. `scheduled` and `held_overdue` come with M6.
>   - Message `send_status` adds `skipped` (with `skip_reason`: suppressed, consent_withdrawn/refused, consent_missing) instead of `skipped_suppressed`, and `resend_approved` is recorded as `resolution` on a message that returns to `pending` with `attempt_no + 1`. Forward-only transitions are enforced by a DB trigger.
>   - Consent is re-checked at send time, next to suppression. The frequency cap (COMPLIANCE §6) is still a pending proposal and is not enforced.
>   - Every campaign body must link `{{ unsubscribe_url }}` (review blocks otherwise); the plain-text part gets an opt-out line if it lacks one. The `[QC]`/`[AD]` label is a review warning, not enforced.
>   - Outside production, campaign messages are sent with guard purpose `integration_test` (mock, simulator or allowlist only).
>   - The rate limiter is per worker process (default 5/s, capped at 80% of the SES max rate). The quota check (GetAccount) runs at the start of each dispatcher run and every 100 sends; an exhausted budget (after the reserve) blocks the campaign until an admin resumes it.
>   - A custom `Message-ID` header is not set; reconciliation uses the `msg_id` (and `attempt`) SES tags. Whether SES v2 keeps a custom Message-ID must be checked before relying on it.
>   - SNS `SubscriptionConfirmation` messages are verified and recorded, never confirmed automatically (manual step after deployment).
>   - Only admins approve ("Send now"), resume, cancel, resolve uncertain sends and add suppressions; members create, edit, review and pause.
> - **M6 (scheduling, implemented locally with mocks; see `reports/2026-11-13-m6/report.md`):**
>   - Statuses `scheduled` and `held_overdue` added. Scheduling performs the same snapshot freeze as Send now; "edit after scheduling" is an explicit **Unschedule and edit** action (→ draft, revision++, snapshot cleared, unsent messages cancelled). The schedule is admin-only, like Send now.
>   - The fenced start locks the campaign row (`FOR UPDATE`) and checks status, revision and due time in one transaction; the start job and the every-minute sweeper share it. The comparison uses the worker's clock (injected in tests) rather than SQL `now()`.
>   - Scheduling uses whole minutes (HH:mm). The local time as entered and the UTC offset used are stored next to `scheduled_at_utc` and `schedule_tz`.
>   - Execution-time checks (credentials, sending enabled, quota) remain in the dispatcher (M5) and block with a reason; Notion is not required.
>   - Admin alerts (`admin_alerts`) for `held_overdue` and `blocked`: shown on the Dashboard and Scheduled list until acknowledged; emailed to active admins only when the sending guard allows (test-send rules outside production; never in `disabled`).
>   - Worker-down banner on the Scheduled list after 2 minutes without a heartbeat.
> - **M7 (tracking and analytics, implemented locally with mocks; see `reports/2026-11-13-m7/report.md`):**
>   - Tracking is decided per message at send time by the setting `tracking.mode` (`consented_only` by default — `email_tracking` consent required, pending counsel; `all`; `off`) and recorded on the message. Untracked messages keep direct links and get no pixel; their tokens produce no tracking events.
>   - Links are rewritten on the frozen template before merge rendering, with the same selection as the snapshot link table (absolute http(s), no merge field; links inside comments such as MSO conditionals stay direct). The plain-text part is not rewritten. Test sends are never tracked.
>   - **Unique openers include implied opens** (a click without a recorded open); "Opens (recorded)" stays the raw pixel count. CTOR therefore never exceeds 100%.
>   - Automated-activity flags: scanner user agents / no user agent, HEAD requests, clicks < 10 s after delivery (or sending), different links within 2 s (all flagged). Google/Yahoo image-proxy opens are labelled `proxy_open` but not treated as automated. Scanner IP lists and Apple MPP detection are not implemented (no reliable signal without IP ranges).
>   - The IP is stored only as an HMAC (keyed with `BETTER_AUTH_SECRET`); the user agent is truncated to 300 characters.
>   - Both views (all recorded / automated filtered out) are shown side by side; a toggle selects the headline tiles and the link table.
> - **M8 (Notion summaries, hardening, backups; mock environment; see `reports/2026-11-13-m8/report.md`):**
>   - "Email Campaigns" Notion database with a fixed schema (Name, Campaign ID, Status, Summary stage, Scheduled/Started/Finished, Recipients, Sent, Delivered, Bounced, Complaints, Unsubscribes, Uncertain, Unique openers/clickers, open/click rate of Delivered, Last updated). Engagement figures are the filtered ones (automated activity removed).
>   - Summary stages are tracked per campaign (`campaign_notion_summaries`); a run writes the latest due stage (covering missed ones). Contacts' "Last emailed" / "Last engagement" go through the outbox (`set_engagement`).
>   - Public endpoints are rate limited in process memory (single instance assumed); client IP from `X-Forwarded-For` counted from the right (`TRUSTED_PROXY_HOPS`).
>   - Backups: provider-managed backups are primary; a logical JSON-lines export with checksums supports drills and restores into an empty migrated database. The job queue is not backed up (rebuilt by the sweepers).

## Context

The company wants an internal tool, modelled on Wix Email Marketing, that runs one complete flow:

1. Select contacts from Notion
2. Personalize the email
3. Preview and send a test
4. Review
5. Send now or schedule
6. Process the durable sending queue
7. View analytics
8. Sync summaries back to Notion

The project folder is greenfield. It contains only `PROJECT_BRIEF.md`, so there is no existing plan or code to preserve.

Language: the brief says to respond in Vietnamese, but you asked for English, so this plan is in English. The UI and email content can still be Vietnamese.

### Decisions you made during planning

| Topic | Your answer | Effect on the architecture |
|---|---|---|
| Volume | 500–2,000 recipients per campaign | This exceeds a safe share of one Gmail mailbox's 2,000/day. A sending service fits better. |
| Delivered/Bounced | **Required from day one** | The Gmail API cannot report delivery. Campaigns need a sending service with delivery webhooks. |
| Templates | HTML exported from a builder | The HTML is table-based, with inline CSS and Outlook conditional comments. The editor has to preserve structure. |
| Transport | **SES for campaigns; Gmail sending deferred** | Amazon SES sends from the company domain. Replies go to the company Gmail inbox. Gmail sending becomes a later optional mode. |

### Contradictions with the brief

These come from the decisions above and need your sign-off.

1. **Brief §1 (Gmail OAuth sending) moves to Phase 2.** In the MVP, Google OAuth is used only for signing in to the app (scopes `openid email profile`). Gmail send permission is not requested.
   - **Benefit:** no sensitive Gmail scope, no Trusted-app requirement for sending, no 7-day token expiry, and the company mailbox quota is untouched.
2. **Brief §6, "reserve capacity for ordinary company email":** this is met structurally, because SES quota is separate from Gmail. A configurable reserve is still kept on SES quota.
3. **Brief §7, "use Sent as denominator for Gmail-only":** with SES there is a real Delivered signal. Rates can therefore use Delivered as the denominator, labelled explicitly. Rates over Sent are shown too.
4. **Brief §12, "Gmail reconnection handling":** the MVP applies the same pattern to SES (credentials, identity and account checked at execution time). The Gmail-specific design is kept in Phase 2 below.
5. **"Delivered" means the recipient's server accepted the message, not inbox placement.** This is the meaning of SES's Delivery event, and the UI will say so.

### Assumptions (please confirm or correct)

- **Scope and scale**
  - A1: One company, one Google Workspace domain for staff sign-in, one Notion workspace, and one SES sending domain with one From address.
  - A2: Up to about 10 campaigns and 20k emails per month, about 10k contacts, and 2–5 internal users.
  - A3: Contacts have opted in, and Vietnamese advertising-email rules apply. Decree 91/2020/NĐ-CP covers consent, unsubscribe and possibly a subject label such as "[QC]". **This is unverified and needs your legal confirmation.**
- **Accounts and setup**
  - A4: You can create an AWS account, change DNS for the company domain, and get a Notion workspace owner to create an integration.
  - A5: A marketing subdomain for sending is acceptable, for example `news.company.com` (see the improvements section).
- **Product**
  - A6: Only Asia/Ho_Chi_Minh is used in practice. Any IANA zone can be selected, with DST validation.
  - A7: No Wix screens have been inspected. To mirror its UX closely, I need **screenshots or a screen recording** from your authorized account of: audience selection, the editor, test send, review, the schedule picker, the scheduled list, and stats.

---

## 1. MVP scope and later phases

**MVP**
- Staff sign-in with Google, restricted to the company domain and an allowlist.
- Roles: `admin` and `member`.
- Notion CRM: create the CRM database or map an existing one; sync inbound; write app-owned fields back to Notion.
- Templates:
  - import builder HTML;
  - edit text, images, links and buttons while preserving structure;
  - paste formatted text;
  - desktop and mobile previews;
  - reusable templates and saved drafts.
- Personalization:
  - merge fields with fallbacks in the subject and body;
  - preview as a specific recipient;
  - unresolved fields block review;
  - test sends are excluded from campaign metrics.
- Sending:
  - SES with a durable queue;
  - rate limiting;
  - pause, resume and cancel;
  - snapshot frozen at approval;
  - suppression checked at send time;
  - explicit "unknown" outcomes with reconciliation.
- One-time scheduling with an explicit timezone, reschedule and cancel, an overdue-hold policy, and an audit trail.
- Tracking: opaque tokens for the open pixel and click redirects (no open redirects); RFC 8058 one-click unsubscribe; a suppression list.
- Events: SES Delivery, Bounce and Complaint, which feed automatic suppression.
- Analytics by campaign, recipient and link: recorded versus filtered events, and first and latest timestamps.
- Campaign summaries written to Notion.

**Phase 2, in order**
1. Gmail API transport as an optional low-volume mode. This brings back brief §1 in full.
2. Notion webhooks, to sync sooner than polling.
3. A drag-and-drop builder for new layouts.
4. Inbox-placement seed testing.

**Later**
- Recurring campaigns
- Per-recipient local-time sending
- A/B tests
- Automation sequences
- Multi-company support

---

## 2. Technology stack

All of it is TypeScript on Node 22 or later. It runs as one repository with two processes and one database, and no Redis.

| Concern | Choice | Reason |
|---|---|---|
| Web app, API, tracking endpoints | **Next.js 16 (App Router)** route handlers | One deployable unit for the UI, the API, the public `/o` `/c` `/u` endpoints and the SNS webhook. |
| Background work | **Graphile Worker** in a separate always-on `worker` process | Postgres-backed. `run_at` gives delayed jobs, and `job_key` replace/remove fits reschedule and cancel. No extra infrastructure. |
| Database | **PostgreSQL 16+** and **Drizzle ORM** with SQL migrations | Holds transactional state, row locks (`FOR UPDATE SKIP LOCKED`) and the queue in one place. |
| App sign-in | **Better Auth**, Google provider with `hd` set to the company domain, plus a server-side allowlist | NextAuth v5 is in maintenance mode, and its maintainers recommend Better Auth. |
| Sending | **Amazon SES v2** (`@aws-sdk/client-sesv2`), region ap-southeast-1 | Delivery, Bounce, Complaint and Reject events. Costs about $0.10 per 1k emails. Has a mailbox simulator for safe live tests. |
| Event ingestion | SES configuration set → SNS → HTTPS endpoint, with the SNS signature verified | Simplest push path. Events carry our message tag, which lets us reconcile. |
| Merge fields | **LiquidJS** with `strictVariables`, an allowlisted field set and HTML-escaping | Its `default:` filter gives fallbacks, and it has no code execution. Example: `{{ greeting_name \| default: "Quý khách" }}`. |
| HTML handling | `parse5`/`cheerio` for structure-preserving edits, `sanitize-html` with an email allowlist (keeps MSO conditional comments), `juice` for CSS inlining, `html-to-text` for the plain-text part | Builder HTML has to survive editing. Nothing promises lossless editing of arbitrary HTML. |
| Editor UI | Decided in the **M3 spike** (see §4.4). Candidates: (a) a structure-preserving "click-to-edit" editor on a sandboxed preview iframe, (b) GrapesJS with preset-newsletter (BSD), (c) TipTap for formatted-text paste. | The brief requires testing two real templates first. Unlayer and Beefree turn HTML into their own JSON and are paid, so they are rejected unless you have budget for them. |
| Time | **Luxon** with IANA zones | Explicit handling of nonexistent and ambiguous local times. |
| Images | S3 bucket (same AWS account) with public read through CloudFront | Images from builder CDNs are re-hosted on import, so emails don't break later. |
| Observability | `pino` JSON logs with correlation ids (`campaign_id`, `snapshot_id`, `schedule_revision`, `job_id`, `message_id`); `/healthz`; worker heartbeat; Sentry free tier (optional) | Gives the evidence the QA reports need. |
| Tests | **Vitest**, against a real Postgres (Docker), with an injectable `Clock`; **Playwright** for E2E, with traces | Controlled clocks for scheduling tests. Traces become report evidence. |
| Hosting | **Render**, Singapore region: web service, background worker, managed Postgres; staging and production | Always on (no sleep), predictable pricing, managed backups. Railway is an equivalent alternative. |

---

## 3. Data model, ownership and sync

### 3.1 Tables

**Auth and audit**
- `users` (role, allowlisted) and the auth library's tables.
- `audit_log(actor, action, entity, entity_id, before, after, at)`.

**Integrations**
- `notion_connection`: encrypted token, data_source_id, API version, field mapping as JSON.
- `sending_identity`: From, Reply-To, SES config set.
- AWS keys live in environment variables, never in the DB.

**Contacts and suppression**
- `contacts`
  - Key: `notion_page_id` (UNIQUE).
  - Contact fields: `email`, `email_normalized`, `full_name`, `greeting_name`, `company`, `tags[]`.
  - Sync metadata: `notion_last_edited_at`.
  - `state`: `active`, `archived`, `duplicate_conflict` or `invalid_email`.
  - App-owned: `last_emailed_at`, `last_engagement_at`.
- `suppressions`
  - Key: `email_normalized` (PK).
  - `reason`: `unsubscribe`, `hard_bounce`, `complaint`, `manual` or `notion_unsubscribed`.
  - Also `source`, `campaign_id`, `created_by` and `at`.
  - **Never deleted by automation.**
- `sync_runs`: cursor, counts and errors.
- `notion_outbox(kind, target_page, payload, status, attempts, next_attempt_at)`: coalesced per page.

**Templates and campaigns**
- `templates`, `template_versions` (html, text, editor metadata) and `assets`.
- `campaigns`
  - Content and audience: `status`, `draft_content` (subject, html, text), `audience_definition`, `sending_identity_id`.
  - Approval: `approved_snapshot_id`.
  - Schedule: `scheduled_at_utc`, `schedule_tz`, `schedule_revision`.
  - Delays and holds: `hold_reason`, `processing_started_at`.
  - Ownership: `created_by`.
- `campaign_snapshots`: **immutable**. Holds the revision, subject template, HTML and text, the link table, `content_hash`, `approved_by` and `approved_at`.
- `campaign_recipients(snapshot_id, contact_id, email_normalized, merge_values jsonb)` with UNIQUE(snapshot_id, email_normalized). These are the frozen values.
- `messages`
  - Identity: `id uuid`, `snapshot_id`, `recipient_id`, `tracking_token` (128-bit random).
  - `send_status`; `delivery_status` (separate column).
  - Provider and attempts: `provider_message_id`, `attempt_no`, `claimed_by`, `claimed_at`.
  - Timing and errors: `send_started_at`, `sent_at`, `last_error`.
  - UNIQUE(snapshot_id, recipient_id).
- `links(snapshot_id, idx, url, label)`.
- `message_events`
  - `type`: `send`, `delivery`, `bounce_hard`, `bounce_soft`, `complaint`, `reject`, `delay`, `open`, `click`, `unsubscribe`.
  - `provider_event_id`, UNIQUE for deduplication.
  - Click detail and timing: `link_id`, `occurred_at`, `received_at`.
  - Bot evidence: `ip_hash`, `user_agent`, `suspected_automated`, `filter_reason`.
- `test_sends`: a separate table with its own tokens. It never touches campaign metrics.
- `campaign_transitions(campaign_id, from, to, actor, reason, schedule_revision, at)`.

### 3.2 Contact identity rules

- The stable key is the **Notion page ID**. If the email on a page changes, it is the same contact with a new address.
- Normalization is trim plus lowercase only. Gmail dots and `+` tags are not collapsed.
- **Duplicates:**
  - If two or more active pages share a normalized email, all of them are marked `duplicate_conflict`, excluded from audience selection, and listed on a "Data issues" screen.
  - The admin chooses the primary page. The app never deletes Notion pages.
- **Send-time dedupe:** within a snapshot, recipients are deduplicated on `email_normalized`, which is enforced by a constraint.
- **Suppression follows the email, not the page.** It still applies if a duplicate or re-created page reuses that address.

### 3.3 Field ownership and Notion sync rules (API version pinned to `2026-03-11`, data-sources model)

| Field | Owner | Direction |
|---|---|---|
| Full name, Greeting name, Email, Company, Tags | **Notion** | Notion → App |
| Subscription status | **App (suppression list)** | Notion "Unsubscribed" → App adds a suppression. Notion "Subscribed" while suppressed → ignored, and Notion is rewritten to "Unsubscribed". **No automatic resubscribe.** |
| Last emailed, Last engagement | App | App → Notion |
| Campaign summaries | App | App → Notion "Email Campaigns" database |

- **Inbound sync**
  - The first sync is full.
  - After that, incremental sync runs every 10 minutes, plus a manual "Sync now".
  - Incremental sync uses a `last_edited_time` filter from the cursor minus 5 minutes, then upserts by page ID.
  - A nightly full reconcile catches pages that were moved to the trash; those contacts are archived, not deleted.
  - When the only change is to app-owned fields, it is treated as an echo and ignored.
- **Outbound writes**
  - Writes go through `notion_outbox` jobs, idempotent PATCHes coalesced per page.
  - A shared limiter holds them to about 2.5 requests per second. 429 responses honour `Retry-After`, and 5xx and 529 responses back off.
  - Failures don't block sending; they appear on a sync-health panel.
- **Schema setup:**
  - "Create CRM database" builds a defined schema under a parent page you choose.
  - "Map existing database" validates each property's type: email, rich_text, multi_select, select, date.
  - App-owned columns are marked "(managed by app)".
- **Rate limits:** about 3 requests per second per integration; pages are fetched 100 at a time.
- **Webhooks:** not used in the MVP. They deliver at most once, so polling would be needed anyway.

### 3.4 Campaign status model

```
draft ──validate──▶ in_review ──"Send now"──▶ queued ──▶ sending ──▶ completed | completed_with_issues
  ▲                    │                        ▲          │  ▲
  │ (edit)             └─"Schedule"─▶ scheduled ┘(due)     │  └ resume
  └──────── edit ─────────────────────┤  │                 ├─▶ paused (user)
                                      │  ├─▶ reschedule (revision++)
                                      │  ├─▶ cancelled
                                      │  └─▶ held_overdue ──▶ queued | rescheduled | cancelled
                    sending ─▶ blocked (quota / credentials / identity / account paused) ─▶ sending
                    sending ─▶ cancelling ─▶ cancelled (partial: reports sent / in-flight / unsent)
                    any non-terminal ─▶ failed (unrecoverable, with reason)
```

- Editing content or recipients in `in_review` or `scheduled` returns the campaign to `draft` and increments `schedule_revision`. This invalidates the old job, and the campaign must be reviewed again.
- `completed_with_issues` means some messages ended as `unknown`, `failed` or `bounced`. The campaign is never shown as a clean success in that case.

**Message `send_status`**

```
pending ─▶ claimed ─▶ sent (SES accepted, id stored)
pending ─▶ skipped_suppressed | cancelled
claimed ─▶ failed_permanent (definitive rejection)
claimed ─▶ pending (retryable error *known* not to be accepted: throttling, with backoff)
claimed ─▶ unknown (timeout, network error after the request was sent, worker crash) ─▶ sent (reconciled) | resend_approved | marked_not_sent
```

**Message `delivery_status`** (from SES events): `none`, then `delivered`, `bounced_soft`, `bounced_hard`, `complained` or `delayed`.

---

## 4. Key designs

### 4.1 Durable sending and duplicate prevention

1. **Approval (send now or schedule)**
   - In one transaction, freeze an immutable snapshot: content, link table, and recipients with their merge values.
   - Recipients that are suppressed, invalid or in `duplicate_conflict` are excluded, and the review screen shows the counts.
   - Then create one `pending` message per recipient.
2. **Single dispatcher per campaign:** the `dispatch_campaign` job holds `pg_try_advisory_lock(campaign_id)`, so a second worker cannot run the same campaign.
3. **Claim**
   - `UPDATE … SET send_status='claimed', claimed_by, claimed_at WHERE id IN (SELECT … WHERE status='pending' … FOR UPDATE SKIP LOCKED LIMIT n)`.
   - This runs only while the campaign is `sending`; the status is re-read each batch.
   - The claimed state is committed **before** the SES call (write-ahead).
4. **Per-message pre-checks, immediately before the send:**
   - the campaign is still `sending`;
   - the address has no suppression;
   - the SES token bucket allows it.
5. **SES call**
   - The request carries the `msg_id` email tag and a custom `Message-ID`.
   - **Success** → `sent`, with the provider id stored.
   - **Definitive 4xx, for example MessageRejected** → `failed_permanent`.
   - **Throttling** → back to `pending` with backoff.
   - **Timeout or network error after sending** → `unknown`. **It is never retried automatically.**
6. **Crash recovery:** a reaper job moves `claimed` rows older than 10 minutes to `unknown`, not back to `pending`.
7. **Reconciliation**
   - When a SES Send, Delivery or Bounce event arrives with our `msg_id` tag, an `unknown` message is resolved to `sent`.
   - After 60 minutes, any message still unresolved stays `unknown`.
   - The campaign page then offers "Resend N uncertain" (with a duplicate-risk warning) or "Mark not sent". Either action is audited.
8. **Rate limiting**
   - Configurable messages per second, with a default of 5 that is capped below the SES account's max rate.
   - A daily-quota check (`GetAccount`) runs at start and every 100 sends.
   - The quota keeps a reserve (default 10%). If the remaining quota falls short, the campaign moves to `blocked: quota`, with the expected resume time and a "Resume" action.
9. **No promise of exactly-once delivery.** The guarantee is at-most-once per automatic attempt, with explicit `unknown` states.

### 4.2 Scheduling

- **Picker:** date, time and an IANA timezone, defaulting to `Asia/Ho_Chi_Minh (UTC+07:00)`. The zone is shown in the picker, on the review screen and in the scheduled list.
- **Storage:** the time is stored as `scheduled_at_utc`, with the zone kept for display and audit.
- **Validation:**
  - Past times, and times under 2 minutes ahead, are rejected.
  - For DST zones, a nonexistent local time is rejected with a suggested alternative.
  - An ambiguous local time asks the user to choose between the two offsets.
- **Confirmation screen:** shows the sender, recipient count, subject, content preview, date, time and zone. It also states that the time is when processing starts; delivery continues at the configured rate, so the last message arrives later.
- **Job:** `start_campaign` with `run_at = scheduled_at_utc`, `job_key = campaign:{id}` in replace mode, and payload `{campaign_id, schedule_revision}`.
- **Fenced start.** The queue is not trusted on its own; the start is a conditional update:
  ```sql
  UPDATE campaigns SET status='queued', processing_started_at=now()
  WHERE id=$1 AND status='scheduled' AND schedule_revision=$2 AND scheduled_at_utc <= now()
  ```
  - If it updates 0 rows, the job is stale, a duplicate or early. It is a logged no-op.
  - This covers duplicate triggers, concurrent workers and cancel or reschedule races.
- **Sweeper:** a cron job every minute runs the same fenced start for due campaigns, in case a job was lost.
- **Reschedule:** increments the revision and replaces the job. Any old job that still fires fails the fence.
- **Cancel:** sets `cancelled` and removes the job. A job that is already running sees the status on its next batch.
- **Cancel during sending:** stops unsent work and reports sent, in-flight and unsent counts. Messages already sent are not recalled.
- **Execution-time checks:**
  - SES credentials and identity verified;
  - account sending enabled;
  - quota;
  - Notion is **not** required.
  - If any check fails → `blocked` with an actionable reason. The campaign is never marked as sent.
- **Dispatch-delay target:** processing starts within 60 seconds of the scheduled time (p95), with the measured delay recorded.
- **Late-send grace period:** 30 minutes, configurable.
  - Within the grace period, the campaign proceeds and the delay and its reason are logged.
  - Beyond it, after an outage, the campaign moves to `held_overdue`. An admin decides to send now, reschedule or cancel. **The default is not to send.**
- **Audit trail:** who created, changed or cancelled the schedule; the scheduled time; the actual start; per-message `sent_at`; and the reasons for delay, blocking or failure. All of these go in `campaign_transitions` and `audit_log`.
- **Visibility:**
  - A Scheduled list showing status, local and UTC time, revision and next action.
  - A worker-heartbeat banner when the worker has been missing for more than 2 minutes.
  - Admin email alerts through SES for `blocked` and `held_overdue`.
- **Phase 2, Gmail reconnection:**
  - `invalid_grant` or a revoked token → `blocked: reconnect Gmail`.
  - After reconnecting, sending resumes from `pending` only.
  - Gmail uncertain sends would need a restricted read scope (`gmail.readonly`) to search the Sent folder by `rfc822msgid`. Internal apps don't need verification for it.

### 4.3 Tracking, unsubscribe and analytics

- **Public endpoints** (HTTPS, on the tracking subdomain, hosted so they keep working with every office computer off):
  - `/o/{token}.gif`: the open pixel.
  - `/c/{token}/{linkIdx}`: a click.
    - It redirects **only** to the URL stored in the snapshot's link table.
    - An unknown token or link returns 404, never a redirect taken from the query string.
  - `/u/{token}`, GET: shows a confirmation page, so security scanners can't unsubscribe people.
  - `/u/{token}`, POST: RFC 8058 one-click unsubscribe, set through `List-Unsubscribe` and `List-Unsubscribe-Post`.
  - Unsubscribing adds a suppression immediately and queues the Notion update.
  - The visible footer link is always present.
  - Tokens are opaque and random. No email addresses appear in URLs.
- **Automated-activity flags.** Raw events are kept; flags are additive.
  - A click less than 10 seconds after delivery.
  - Several links clicked within 2 seconds.
  - HEAD requests, or user agents and IPs of known scanners.
  - Apple MPP or Google proxy opens, labelled "proxy open".
  - An open recorded only after a click.
- **Metric definitions.** Test sends are always excluded.
  - Sent = SES accepted.
  - Delivered = SES Delivery event, meaning the recipient's server accepted it.
  - Bounced (hard and soft, shown separately) and Complaints.
  - Failed = rejected before acceptance.
  - Also shown: Skipped (suppressed) and Unknown.
  - Unique openers and unique clickers are counted **per message**, so per recipient per campaign. Total recorded opens and clicks are raw counts.
  - Example: 3 clicks on the same link = 1 unique clicker and 3 recorded clicks.
  - Rates are labelled "of Delivered", with "of Sent" alongside.
  - CTOR = unique clickers / unique openers.
  - A toggle switches between all recorded events and events with automated activity filtered out.
- **Views:** per campaign, per recipient (a timeline), and per link (unique and total clicks). Each shows first and latest activity.
- **Documented limitations:**
  - image blocking;
  - Gmail image-proxy caching, which makes repeat opens unreliable;
  - Apple MPP prefetching;
  - security-scanner clicks;
  - forwarded emails, which are attributed to the original recipient;
  - Delivered is not inbox placement.

### 4.4 Templates and editor (decided by the M3 spike)

- **Import pipeline**
  1. Sanitize against an allowlist: scripts, forms, iframes, event handlers and `javascript:` URLs are removed; tables, inline styles and MSO conditional comments are kept.
  2. Re-host images to S3.
  3. Extract links.
  4. Run lint warnings:
     - Gmail clips messages over 102 KB;
     - images without alt text;
     - a high image-to-text ratio, which suggests "text inside an image is not editable";
     - absolute positioning.
- **Spike** (two of your real templates, about 2 days)
  1. Import both templates.
  2. Edit a headline, a paragraph, an image, a link and a button.
  3. Export.
  4. Compare against the original with a DOM diff.
  5. Send tests to Gmail web and Android, Outlook desktop and web, and Apple Mail on iOS.
  6. Compare structure-preserving click-to-edit against GrapesJS.
- **Selection rule:** choose the option that keeps the layout identical in every client after edits. The likely result is click-to-edit for imported builder HTML, with TipTap blocks for pasted formatted text.
- **Previews:** desktop (600 px+) and mobile (375 px) in a sandboxed iframe with scripts disallowed, plus a plain-text part that can be edited.
- **No promise of lossless editing of arbitrary HTML.** Unsupported constructs are shown as read-only regions.

### 4.5 Personalization and test sends (M4)

- **Subject.** Stored on each template version (`subject`, nullable for pre-M4 versions). Saving a subject stores a new immutable version with the same HTML. The same field and filter allowlist as the body applies. The subject is rendered as plain text (no HTML escaping). Line breaks in the template or in a merged value are refused (header injection). `{% %}` tags are never executed, and `unsubscribe_url` is not allowed in a subject.
- **Blocking rules.** A test send, and later campaign review, is refused on: an unknown field or filter, a syntax error, a missing subject, or a missing value with no `default:` fallback for the chosen recipient.
- **Personalization check.** For every active contact with a valid email, the check lists those missing a value for a field used without a fallback. Campaign audience and eligibility rules are applied later, in M5.
- **Test sends** (`src/lib/sending/test-send.ts`):
  - staff type 1–3 addresses. In every send mode, including mock, each address must be on `TEST_RECIPIENT_ALLOWLIST` or be an SES simulator address. Refusals never reveal the list;
  - suppressed addresses are refused even when allowlisted; the sending guard then decides the transport (`disabled` refuses);
  - each address is a `test_sends` row, committed as `claimed` before the provider call (write-ahead), with a unique (idempotency key, address). A double submit therefore calls the provider once;
  - outcomes are `accepted`, `rejected`, `retryable` or `unknown`. `retryable` and `unknown` are never retried automatically. "Send again" is an explicit, audited new row (`resend_of`);
  - a DB trigger allows only `claimed → final` and `unknown → accepted` (later reconciliation) and blocks deletes;
  - a worker reaper turns claims older than 10 minutes into `unknown`;
  - the subject gets a `[TEST] ` prefix. Rate limits default to 10 per person per hour and 50 per day;
  - there is no campaign id, so test sends can never be counted in campaign metrics;
  - the audit log stores masked addresses only.
- **SES transport** (`src/lib/sending/ses-transport.ts`): SES v2 `SendEmail` (simple content, UTF-8, custom headers, `msg_id` tag, optional configuration set). SDK retries are off (`maxAttempts: 1`) and a timeout gives `unknown`. Credentials come from the AWS default chain (an AWS profile outside the repository). `accepted` is not proof of inbox delivery. Delivery and bounce events need SNS and a public HTTPS endpoint (M5, after deployment is authorized). Customer campaigns are still refused by the factory until M5.

### 4.6 UI system (M4)

- **Approach.** Plain CSS with custom properties (`src/app/globals.css`), layered as tokens → base → shell → components → editor. No CSS framework, so the DOM the tests rely on is unchanged.
- **Tokens.**
  - Light: slate neutrals, primary `#1D4ED8`, muted text `#475569` (4.5:1 or better).
  - Dark: a matching set.
  - Theme follows the system by default. A toggle stores `light`, `dark` or `system` in a cookie, so the server renders the theme without a flash.
- **Type and icons.**
  - Be Vietnam Pro, self-hosted through `@fontsource` (no Google Fonts request), with tabular numbers for data.
  - lucide SVG icons; no emoji icons.
- **Shell.**
  - Grouped sidebar (Overview, CRM, Content, Admin) with `aria-current`; a drawer below 860 px.
  - Topbar with the send-mode badge, the user, the theme toggle and sign-out.
  - A skip link, then `<main id="main">`.
  - `/internal` is never linked.
- **Accessibility and interaction rules.**
  - Visible focus rings.
  - Hover changes colour or border only, never scale.
  - Transitions of 150–200 ms, all disabled under `prefers-reduced-motion`.
  - Touch targets of 44 px or more on phones.
  - Status is never shown by colour alone: badges carry text.
- **Sources.** From the `ui-ux-pro-max` skill only the data-dense dashboard style, the font pairing and the checklist were adopted. The skill is a design aid, not a substitute for the QA process.
- **Copy.** Existing English copy that tests assert is unchanged. A full Vietnamese localisation is a separate decision.

---

## 5. Screens and end-to-end flow

**Screens**
1. Sign-in
2. Dashboard: upcoming scheduled campaigns, recent results, health banners
3. Contacts: filter by tags, company or status; Data issues
4. Notion connection and mapping
5. Templates: list, import, editor
6. Campaign wizard: Audience → Content → Personalize & preview-as → Test send → Review
7. Scheduled campaigns
8. Campaign detail (live progress, pause, resume, cancel, uncertain sends)
9. Analytics: campaign, recipient, link
10. Suppressions
11. Settings: sending identity, rate limit, grace period, users and roles, send mode
12. Audit log

**Paths**
- **Send now:** Review → confirm dialog (sender, count, subject, preview) → `queued` → `sending` with live progress → `completed`.
- **Schedule:** Review → "Schedule for later" → pick date, time and zone → confirm summary → `scheduled` → appears in the Scheduled list → at the due time, the worker runs a fenced start → `sending` → `completed`.
- **Reschedule:** Scheduled list → "Reschedule" → new time → confirm → revision increments and the old job is invalidated.
- **Cancel:**
  - Scheduled → "Cancel" → `cancelled` and never dispatched.
  - During sending → "Cancel" → `cancelling` → a partial report.
- **Edit after scheduling:** editing returns the campaign to `draft`. A banner reads "Schedule removed — review and confirm again".

---

## 6. Setup you must complete (tracked as M0 checklists)

- **Google Workspace / Cloud:**
  - Create a Cloud project.
  - Set up the OAuth consent screen as **Internal**.
  - Create a web OAuth client with staging and production redirect URIs. Scopes: `openid email profile` only.
  - Give me the list of allowed staff emails.
  - For Phase 2 only:
    - enable the Gmail API;
    - add the `gmail.send` scope;
    - mark the app Trusted in Admin console → API controls;
    - use a dedicated sending mailbox;
    - confirm it isn't a trial account (trial accounts are limited to 500 emails a day).
- **AWS:**
  - Create an account with billing alerts.
  - In SES ap-southeast-1:
    - verify the sending domain with Easy DKIM (3 CNAMEs);
    - set a custom MAIL FROM (MX + SPF);
    - request **production access** (sandbox = verified recipients only), describing opt-in, unsubscribe and bounce handling;
    - create a configuration set with an event destination that sends Send, Delivery, Bounce, Complaint, Reject and DeliveryDelay to an SNS topic, which posts to the app over HTTPS;
    - enable account-level suppression.
  - Create an IAM user or role limited to `ses:SendEmail` on that identity and `ses:GetAccount`.
  - Create the S3 bucket for images.
- **DNS:**
  - SPF, DKIM and DMARC. Start at `p=none` with `rua` reports, then tighten.
  - Subdomains: `app.`, the tracking subdomain (for example `t.`), and the marketing From subdomain.
  - Register the domain in Google Postmaster Tools.
- **Notion:**
  - A workspace owner creates an **internal integration** with read, update and insert capabilities.
  - Share the CRM database, or the parent page if I am to create the database, with the integration.
  - Provide a **separate test database** for QA.
- **Hosting:** a Render account with staging and production environments, and someone to own the secrets.
- **Reference and test material:**
  - Wix screenshots or a recording.
  - Two real templates.
  - Allowlisted test inboxes: a personal Gmail address, an Outlook address, and an iPhone with Apple Mail.
  - 20–50 sample contacts covering missing greeting names, duplicates and Vietnamese diacritics.
- **Legal:** confirm the consent basis and the Decree 91 requirements.

---

## 7. Milestones

Each milestone includes its tests and acceptance criteria. Mocked tests and live tests are reported separately, and a milestone is "ready" only after its regression subset and the smoke suite pass on staging.

| # | Milestone | Deliverables | Acceptance criteria |
|---|---|---|---|
| M0 | Setup & discovery (mostly your tasks, runs alongside M1–M2) | §6 checklists; Wix references; template samples; SES sandbox working | DNS records verify in SES. The test Notion database is shared. The two templates are received. |
| M1 | Foundation | Repo, CLAUDE.md, docs/PLAN.md, Next.js, Postgres and Drizzle migrations, Better Auth with domain and allowlist, roles, audit log, worker with Graphile Worker and heartbeat, `/healthz`, pino logging, CI, staging deploy, `SEND_MODE` guard, smoke-suite harness | Allowed staff sign in and others are rejected (E2E). The worker runs a test job after a restart. Staging is reachable over HTTPS. Smoke S1–S2 pass. |
| M2 | Notion CRM | Connect, create or map database, full and incremental sync, nightly reconcile, duplicate and invalid detection, Contacts and Data issues screens, outbox writer with rate limiting | Repeated syncs create no duplicates. Duplicate emails are flagged and excluded. Notion "Subscribed" never overrides a suppression. Simulated 429s back off. Live sync against the test database matches the counts. |
| M3 | Editor spike → templates | Spike report (both templates, all clients) and editor decision; import pipeline (sanitize, re-host, lint); editor; previews; templates and drafts | Both real templates render after edits with no layout regression in the tested clients (screenshots in the report). XSS payloads are stripped. Lint flags image-only content. |
| M4 | Personalization & test sends | LiquidJS fields and fallbacks in subject and body, preview-as-recipient, unresolved-field blocking, test sends to an allowlist (SES simulator plus real inboxes) | A missing greeting name uses its fallback. An unknown field blocks review and lists the affected recipients. Test sends appear in no campaign metric. |
| M5 | Send-now engine + compliance | Snapshot freeze, queue, claim/send/unknown/reaper, rate limit and quota reserve, pause/resume/cancel, send-time suppression, SES event ingestion with signature check, automatic suppression on hard bounce and complaint, one-click unsubscribe, suppressions screen | A 500-recipient run against the simulator has no duplicate sends. A forced timeout gives `unknown` and no automatic retry; a later event reconciles it. An address unsubscribed mid-queue is skipped. A killed worker leaves no message re-sent. Delivered and Bounced counts match the simulator. |
| M6 | Scheduling | Picker with zone, confirmation, Scheduled list, reschedule, cancel, fenced start, sweeper, overdue hold, blocked states, alerts, audit | All the scheduling tests in §8 pass with a controlled clock. A live check: a campaign scheduled 5 minutes ahead runs with the browser closed and the laptop off, within 60 seconds of the target. |
| M7 | Tracking & analytics | Open and click endpoints, no open redirect, bot flags, metric engine, views by campaign, recipient and link, filtered toggle | A test with 3 clicks on one link shows 1 unique clicker and 3 recorded clicks. A modified link index returns 404. The filtered and recorded counts are both shown. Live real-inbox opens and clicks are recorded. |
| M8 | Notion summaries, hardening, release | "Email Campaigns" Notion database, last-emailed and last-engagement writeback, security review (auth, CSRF, secrets, token encryption, PII redaction), backups and restore drill, runbook, full release regression, live controlled campaign | The release suite passes. A restore drill succeeds. A live campaign of 4 simulator addresses and 3 allowlisted inboxes, sent now and scheduled, shows correct per-recipient results, analytics and Notion summaries. The release report has been produced. |

**Phase 2: Gmail transport.** Covers OAuth connect and disconnect, encrypted refresh tokens (AES-256-GCM with a versioned key), quota with a reserve for company email, `invalid_grant` blocking and reconnect, and a choice of transport per campaign. About 1–1.5 weeks.

---

## 8. QA: reproduction, regression, re-smoke and reports

- **Operation reproduction.** Each critical flow has a written scenario in `docs/PLAN.md`: prerequisites, test data, steps, expected result taken from the brief and this plan (not from the code), and the actual result.
  - For a reported bug, I reproduce it first and record the attempt, including when it **cannot** be reproduced. Then I fix it and rerun the original case.
- **Test layers**
  1. Unit tests: rendering, metrics, time conversion, state transitions.
  2. Integration tests: real Postgres, Graphile Worker run explicitly, a fake SES transport, SNS event fixtures, a Notion HTTP mock, and an injected `Clock`.
  3. E2E: Playwright against staging.
  4. **Live checks:** the SES mailbox simulator (`success@`, `bounce@`, `complaint@`, `suppressionlist@simulator.amazonses.com`), allowlisted real inboxes, and the Notion test database. These run only with your approval, and they are labelled **LIVE**.
- **Regression suite**, grown with each milestone, with tests that check behaviour rather than mirror the code:
  - **Contact sync:** repeated sync, duplicate emails, email changes, pages moved to trash, and no resubscribe.
  - **Personalization:** missing names, Vietnamese diacritics, fallbacks, unresolved fields.
  - **Templates:** both real templates render; sanitization.
  - **Sending:** immediate sends; pause, resume and cancel; duplicate prevention under two concurrent workers; worker killed mid-batch; send timeout gives `unknown`; reconciliation; throttling backoff; an exhausted quota gives `blocked`; invalid SES credentials give `blocked`; an address unsubscribed while queued is skipped; automatic suppression on bounce and complaint.
  - **Scheduling (controlled clock):**
    - Conversion and display:
      - Asia/Ho_Chi_Minh to UTC and back;
      - a non-default zone;
      - a DST gap and overlap (America/New_York);
      - past times rejected;
      - **no early dispatch** (t−1 s stays scheduled);
      - starts within the target after the due time.
    - Reschedule, cancel and edit:
      - reschedule invalidates the old job, so only the newest revision runs;
      - cancel before the due time means no dispatch;
      - cancel exactly at dispatch time (race) means at most one outcome, with in-flight sends reported;
      - an edit after scheduling requires a new snapshot.
    - Frozen snapshot:
      - a Notion name edit after approval leaves the frozen value in place;
      - an unsubscribe before execution excludes that recipient.
    - Duplicates and restarts:
      - duplicate `start_campaign` triggers and sweeper overlap still start once;
      - a worker restart while scheduled still executes;
      - a worker restart while sending sends nothing twice.
    - Outages:
      - an outage within the grace period sends late, with the delay logged;
      - beyond the grace period, the campaign is `held_overdue` and not sent.
  - **Tracking:** open and click recording, unique versus total counts, bot flags, open-redirect attempts, GET unsubscribe confirmation, POST one-click, test-send isolation.
- **Smoke suite** (`npm run smoke -- --env staging`, about 10 minutes). Used as the re-smoke on every final build, and as the pre-check before a long regression run.
  - S1: the app and worker start, and `/healthz` reports DB ok and the worker heartbeat is under 60 seconds old.
  - S2: an allowed staff account can sign in, and an outside account is rejected.
  - S3: "Sync now" against the Notion test database finishes, and the counts match.
  - S4: a campaign built from a template has no unresolved fields in preview-as.
  - S5: a test send to `success@simulator` produces a Delivery event, and campaign metrics stay unchanged.
  - S6: a send-now to 3 simulator addresses gives Sent 3, Delivered 2, Bounced 1 (Complaint 0 or 1, as configured).
  - S7: a campaign scheduled 3 minutes ahead in Asia/Ho_Chi_Minh executes with no browser open, and the scheduled and actual timestamps are recorded.
  - S8: an open and a click on an allowlisted inbox are recorded, the redirect goes to the snapshot URL, and one-click unsubscribe adds a suppression and queues the Notion update.
  - S9: a cancelled scheduled campaign never dispatches.
  - **Pass criterion:** all of them PASS. Any FAIL blocks the release, and a BLOCKED check must be explained.
  - This interpretation of "re-smoke" changes if the tech lead supplies their own checklist.
- **Reports** go in `reports/<YYYY-MM-DD>-<cycle>/report.md`, with `logs/` and `traces/` beside it. Each report includes:
  - the commit SHA, environment, run time and timezone;
  - commands and exit codes;
  - each scenario marked PASS, FAIL, BLOCKED or NOT RUN, with MOCK or LIVE;
  - expected versus actual results, and reproduction steps for failures;
  - logs filtered by correlation id, and Playwright traces and screenshots;
  - for scheduling: campaign id, revision and job id, zone, scheduled and actual timestamps, the state changes, and redacted errors;
  - fixes and retest results, with the first failures and flaky-test history kept;
  - blockers, untested areas, and a release recommendation.
- **Redaction and sharing:** a redaction step masks tokens, cookies, AWS keys and email addresses (`n***@domain`). Reports are prepared for you to share and **never sent automatically**.
- **Honesty rules:** nothing is marked PASS unless it was executed and the result observed. Mocked passes are never presented as live passes. Checks without the needed access are marked BLOCKED or NOT RUN.
- **Safety guard:**
  - `SEND_MODE=simulator|allowlist|live`. Staging can never use `live`.
  - Production `live` needs an admin toggle **plus** per-campaign approval.

---

## 9. Effort and operating cost

**Effort.** Assumes one experienced full-stack developer working with Claude Code, and that M0 access arrives on time.

| Milestone | Days |
|---|---|
| M1 | 3–4 |
| M2 | 4–5 |
| M3 | 7–9 (including a 2-day spike) |
| M4 | 3 |
| M5 | 6–8 |
| M6 | 4–5 |
| M7 | 5–6 |
| M8 | 4–5 |
| **Total** | **36–45 days, about 8–10 weeks** |

- Add 20–30% contingency, mainly for the editor and SES production approval.
- Phase 2 Gmail: 5–7 days.

**Monthly operating cost.** Assumes up to 20k emails and 10k contacts, with a production and a staging environment. Prices are as researched in Nov 2026; verify them before committing.
- Render production: web $7, worker $7, Postgres about $6–20, so **about $20–35**. Staging about $15–20.
- SES: about $0.10 per 1k emails, **about $2**. SNS, S3 and CloudFront together are about $1.
- Google Workspace and Notion: your existing plans. The Notion API is free.
- Optional: Litmus or Email on Acid (about $100+/month) for rendering tests across more clients; Sentry free tier.
- **Total about $40–60 a month** without the optional tools.

---

## 10. REA, MCP servers, skills, agents

- **REA (morluto/rea): optional, leaning unnecessary.**
  - What it is: an MIT-licensed reverse-engineering MCP server and CLI, actively maintained.
  - For web apps, it records a scripted browser session or a HAR into a request log, a route inventory and a replayable API manifest.
  - What it could do here: map the screens and network calls of Wix flows **in your own authorized Wix account**.
  - Limitations:
    - It can't see Wix's backend logic for sending, scheduling or tracking.
    - Captures contain session tokens and must be scrubbed.
    - Recording write actions changes real account data.
    - Wix's terms of service may restrict reverse engineering.
  - **It is not a foundation for this app**; it has nothing for sending, Notion or tracking.
  - Screenshots, a screen recording and a DevTools HAR give most of the UX insight with less risk.
- **MCP servers:**
  - **None is needed at runtime**; the app uses the official Notion and AWS APIs.
  - Optional during development:
    - the Notion MCP, to inspect the test database;
    - a Playwright or browser MCP, for exploratory checks. The Playwright test runner is enough for evidence.
- **Skills / custom agents: unnecessary for the MVP.** A small project skill such as "run smoke and write report" may be worth adding after M1 to keep reports consistent. That is optional.

---

## 11. Project documentation after approval

- `CLAUDE.md` (concise) covers:
  - the stack and commands;
  - how to run tests and smoke;
  - the invariants:
    - never resubscribe automatically;
    - never retry `unknown` sends automatically;
    - live sends only with `SEND_MODE` and approval;
    - redact evidence;
    - Notion API version pinned.
- `docs/PLAN.md`: milestones, with acceptance-criteria and test checklists per milestone, plus the scenario catalogue (reproduction, regression and smoke).
- `reports/`: real test evidence only, one folder per cycle.

Approving this plan approves **documentation and implementation of M0–M1 only if you say so**. Approval to send live campaigns (outside the simulator and allowlist) is a separate, explicit step.

---

## 12. Improvements over the brief's technical approach

1. **SES for campaigns** gives real Delivered, Bounced and Complaint data from day one. It also isolates the company mailbox's quota and reputation, and removes the need for sensitive Gmail scopes in the MVP.
2. **Fencing in the database** (`schedule_revision` with conditional updates, advisory locks and write-ahead claims) instead of trusting queue deduplication. Stale and duplicate jobs become harmless.
3. **Reconciliation from the event stream:** our `msg_id` tag on SES events resolves `unknown` sends without a restricted Gmail read scope.
4. **Structure-preserving editing** for builder HTML, instead of converting it into another editor's JSON.
5. **Unsubscribe safe from scanners:** GET shows a confirmation page, and one-click works over POST.
6. **A separate marketing subdomain** protects the main domain's reputation. Replies still go to the company inbox.
7. **The SES mailbox simulator** allows repeatable live tests of bounces and complaints without real recipients.
8. **The `SEND_MODE` guard** stops accidental live sends from staging or during development.
9. **No Redis and no separate API service:** one Next.js app, one worker and one Postgres database.

## Verification of this plan (once implementation is approved)

- After each milestone, run `npm test` (unit and integration) and `npm run e2e` (Playwright against staging), then `npm run smoke -- --env staging`.
- Write the report to `reports/`.
- The release gate is M8: the full regression suite, re-smoke on the final build, and a live controlled campaign that you approve, labelled LIVE in the report.
