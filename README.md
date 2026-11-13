# Email MKT Tracker

This is an internal email-marketing tool. **Current state: M7** (open/click tracking and analytics on top of the M5–M6 send engine and scheduling), verified locally with a mock transport only. Contacts are synchronized from a Notion CRM; emails are pasted, edited, personalized and test-sent (M3–M4).

M1 foundation:
- staff sign-in limited to the company domain and a staff allowlist
- roles
- an append-only audit log
- a background worker with a heartbeat
- a `/healthz` endpoint
- structured logs
- sending-safety guards

M2 CRM:
- the Notion connection, field mapping and synchronization
- contact validation and duplicate handling
- suppression and consent records
- the Contacts, Data issues and Sync screens

Local development uses a **mock Notion server with synthetic contacts**. No real Notion workspace is contacted unless `NOTION_MODE=live` is set with a recorded authorization (see `docs/NOTION_SETUP.md`). `SEND_MODE` defaults to `disabled`, so no email can be sent. With `SEND_MODE=mock` messages stay inside the process. No real SES send has been made from this project yet.

## Prerequisites
- Node.js 22.18 or later (developed on Node 24).
- No Docker is needed. Local PostgreSQL 17 is provided by the `embedded-postgres` dev dependency, which keeps its data in `.local/`.

## Run locally
```bash
npm install
npm run setup:local          # creates .env.local, or adds missing keys to it (APP_ENV=local, SEND_MODE=disabled, NOTION_MODE=mock)
npm run playwright:install   # once, for E2E tests (installs Chromium into node_modules)

# Terminal 1: database (leave running; stop with Ctrl+C)
npm run db:start

# Terminal 2: schema + staff, then web, worker and the mock Notion server
npm run db:migrate
npm run staff:add -- admin@example.com admin
npm run staff:add -- member@example.com member
npm run dev:crm              # web at http://localhost:3000, the worker, and the mock Notion at 127.0.0.1:4010
```

### Walkthrough: sign-in (M1)
1. Open http://localhost:3000. You are redirected to **Sign in**. Use the **Dev sign-in** box with `admin@example.com`.
2. Try `someone@freemail.example`, an address outside the allowed domain, to see the access-denied page.
3. **Staff & audit** (admins only) lists the allowlist and recent audit events.
4. `/healthz` returns `200` when both the database and the worker are healthy.

### Walkthrough: contacts and synchronization (M2, synthetic data)
1. **Connect.** Open **Notion settings**. In **Connect an existing database**, enter:
   - token `mock-notion-token-not-a-secret` (not a secret; it only works on the mock server);
   - database `11111111-2222-4333-8444-555555555555`.

   Then click **Connect**. Review the suggested **Field mapping** and click **Save mapping**.
2. **Sync.** Open **Sync** and click **Full sync now**. Refresh after a few seconds: the run shows about 39 fetched and created, and 4 suppressions added. The 40th synthetic page is in the Notion trash.
3. **Contacts.**
   - Diacritics are shown correctly, including a name stored in decomposed form: search "Phạm Thị Thu Hà".
   - Every imported contact shows consent **unknown**.
   - Use the filters for duplicates, invalid emails, suppressed contacts, consent and eligibility.
4. **Data issues.**
   - Two duplicate groups (3-way and 2-way): choose a **primary**.
   - Six invalid or missing addresses, each with its reason.
   - Contacts without a greeting name.
5. **Contact detail.** Open "Nguyễn Văn An":
   - The Notion evidence reference is shown, but consent stays **unknown**.
   - As admin, add a consent record. It is refused without evidence, and becomes **granted** with evidence.
6. **Try to resubscribe someone in Notion.** Run `npm run notion:mock:ctl -- set huy subscription=Subscribed`, then **Sync now**.
   - Bùi Đức Huy stays **suppressed**, with consent **withdrawn**.
   - Notion is set back to `Unsubscribed` within about a minute. Check with `npm run notion:mock:ctl -- list`.
7. **More mock controls.** Each takes effect on the next sync; archiving happens on a **full** sync.

   ```bash
   npm run notion:mock:ctl -- set ngoc email=ngoc.moi@example.com   # same contact, new address
   npm run notion:mock:ctl -- trash an                               # archived on the next sync
   npm run notion:mock:ctl -- fault 503 3                            # transient errors; retried
   npm run notion:mock:ctl -- fault 429 2 retry=2                    # rate limited; Retry-After honoured
   npm run notion:mock:ctl -- reset                                  # reseed the synthetic data
   ```

### Walkthrough: your own email (M3)
1. Open **Emails**. Paste your email's complete HTML into **Paste HTML** and click **Import**. No selector or file is needed; the name defaults to the email's `<title>`. (File upload, and importing only part of a web page, are under **More import options**.)
2. The editor opens with a **preview** of the imported email (sanitized: scripts, forms, event handlers and `javascript:` links removed; layout, styles, Outlook comments and merge fields kept).
3. **Edit text:** click text in the preview and type. Only the text changes; colours, fonts, links and merge fields around it are kept, and the panel says "Only the text changed. All formatting is kept."
   - **Insert merge field** puts e.g. `{{ greeting_name | default: "Quý khách" }}` at the cursor.
   - If an edit would remove formatting (e.g. you replaced a whole coloured word), saving is blocked until you choose **Undo changes to this block**, **Keep this change** or **Edit HTML source instead**.
   - **Formatting toolbar** (bold, italic, link) first lists what it cannot keep; **HTML source** edits the block's inline HTML directly.
4. **Edit an image or link:** click it in the preview and change the URL / alt text / destination.
5. **Save as new version.** Reopen the email any time from **Emails → Your emails**; older versions stay listed.
6. **Preview as a recipient** (e.g. "Mẫu: thiếu tên gọi") to see fallbacks; **Desktop 640px / Mobile 375px** are your browser's rendering only, not Gmail, Outlook or a phone mail app.
7. **Export HTML / plain text** from the Versions panel.

### Walkthrough: subject, personalization check and test send (M4)
1. On an email's page, enter a **Subject** (merge fields allowed, e.g. `{{ greeting_name | default: "bạn" }}`) and click **Save subject (new version)**. The rendered subject is shown for each sample recipient.
2. **Find a contact to preview as** searches the synced CRM contacts for the preview list.
3. **Personalization check** lists contacts that would get an unresolved field (a field used without `default:`) and any problem that blocks sending.
4. **Gửi thử (test send):** type 1–3 addresses and choose whose data fills the merge fields. Only addresses on `TEST_RECIPIENT_ALLOWLIST` (or SES simulator addresses) are accepted; the subject gets `[TEST]`.
   - With `SEND_MODE=disabled` (default) the button is off.
   - With `SEND_MODE=mock`, the message stays in-process (nothing leaves the machine).
   - Real SES test sends need `SEND_MODE=allowlist` or `simulator`, `SEND_AUTHORIZATION_REF`, `SES_FROM_ADDRESS` and an AWS profile, plus the user's explicit approval. "Accepted" means SES accepted the message, not that it reached the inbox; an uncertain result is shown as such and never retried automatically.
5. **Sending** (admin) shows the sending configuration, and lets an admin set the campaign rate and the daily-quota reserve.

### Walkthrough: campaigns (M5)
1. **Campaigns → New campaign:** a name, an email (its latest version) and an audience (all eligible contacts, or contacts with some tags). Nothing is sent.
2. The campaign page shows the **review**: matched / will receive / excluded, with the reason for every exclusion (archived, invalid, duplicate, suppressed, no recorded consent), the From address, the subject for the first recipient, and anything that blocks sending (no subject, no `{{ unsubscribe_url }}` link, a missing value without fallback, a sending-guard refusal).
3. An **admin** ticks the confirmation and clicks **Send now**. This freezes an immutable snapshot (content, links, recipients and their merge values) and queues the worker. Suppression and consent are checked again immediately before each message.
4. While sending: live progress, **Pause** (any staff), **Resume** and **Cancel** (admin). A blocked campaign (quota, credentials, account) shows why and waits for an admin to resume it.
5. **Uncertain** messages (no answer from the provider) are never retried automatically. After 60 minutes an admin may resend them (accepting the duplicate risk) or mark them as not sent; both are audited.
6. Every message carries a footer link and `List-Unsubscribe` / one-click headers to `/u/<token>`. Opening the link only shows a confirmation; the button (or a mail client's one-click POST) suppresses the address, records consent as withdrawn and queues the Notion update.
7. **Suppressions** lists every suppressed address; an admin can add one manually (never remove).
8. SES Delivery / Bounce / Complaint events arrive at `/api/ses-events` (SNS, signature-verified). Hard bounces and complaints suppress automatically. This needs a deployed HTTPS endpoint, so locally it is exercised only with signed test messages.

Internal test tooling (labelled fixtures, GrapesJS comparison) is at `/internal/editor-lab` for admins when APP_ENV is local or test; it is not part of the user workflow.

**Stopping:** press Ctrl+C in both terminals. On Windows, check that no `node`/`postgres` processes from this folder remain if a terminal was closed abruptly (see `CLAUDE.md` → "Windows process hygiene").

### Walkthrough: scheduling (M6)
1. On a draft that passes review, an **admin** uses **Schedule for later**: date, time and time zone (default Asia/Ho_Chi_Minh) → **Review schedule**.
2. Invalid times are explained: in the past, less than 2 minutes ahead, a time skipped by daylight saving (with a suggested alternative), or a time that happens twice (choose the offset).
3. The confirmation shows the sender, recipient count, subject, local time with zone, UTC, and how long sending will take. Confirming freezes the campaign exactly like Send now.
4. **Scheduled** lists every scheduled campaign with local and UTC time, revision and next action; it warns when the worker has not reported for 2 minutes.
5. On a scheduled campaign an admin can **reschedule** (the revision increases), **Unschedule and edit** (back to draft) or **cancel**.
6. The background worker starts the campaign at the scheduled time (no browser needed). If it starts more than the grace period late (default 30 minutes, Settings → Sending), the campaign is **held** and admins are alerted; nothing is sent until an admin chooses send now, reschedule or cancel.

### Walkthrough: tracking and analytics (M7)
1. **Settings → Sending → Open/click tracking:** only addresses with tracking consent (default, pending counsel), all recipients, or off. It is decided per message when it is sent.
2. Tracked messages get rewritten links (`/c/<token>/<n>`) and an invisible open pixel (`/o/<token>.gif`); a click always redirects to the URL frozen in the campaign snapshot.
3. A sent campaign's page shows **Analytics**: unique openers and clickers, rates of Delivered and of Sent, click-to-open, unsubscribes, per-link clicks, and both "all recorded" and "automated filtered out" numbers (scanners, link pre-checks, very fast or burst clicks are flagged).
4. Click a recipient's name for their **timeline** (sent, delivery events, opens, clicks, unsubscribe, with flags).
5. Test sends are never tracked or counted.

## Checks
```bash
npm run lint && npm run typecheck
npm run test:unit
npm run test:integration     # starts a throwaway PostgreSQL automatically
npm run e2e                  # throwaway DB + production build + worker + mock Notion + Playwright, then tears down
npm run smoke:local          # same isolated stack, runs the smoke suite (results in .local/logs/smoke/)
npm run e2e:mock-send        # stack with SEND_MODE=mock: test-send UI flow (nothing leaves the machine)
npm run smoke:mock-send      # smoke suite with SEND_MODE=mock (S5-mock, S6-mock)
npm run e2e:mock-campaign    # stack with SEND_MODE=mock: campaign UI flow, unsubscribe, signed SES event
```
The local stack only accepts `--send-mode disabled|mock`; it never starts a real send mode.

## Configuration
See `.env.example`. Safety rules are enforced at startup, and the web and worker processes refuse to start when they are broken:
- `SEND_MODE=live` is rejected unless `APP_ENV=production`.
- `SEND_MODE=simulator` and `SEND_MODE=allowlist` require `SEND_AUTHORIZATION_REF`.
- `SEND_MODE=simulator`, `allowlist` and `live` require `SES_FROM_ADDRESS` (a verified SES identity, no line breaks). AWS credentials come from an AWS profile, never from this repository.
- `DEV_LOGIN_ENABLED` is rejected in staging and production.
- Staging and production require a Google OAuth client, an `https` base URL and `APP_ENCRYPTION_KEY`.
- `NOTION_MODE=mock` only accepts a loopback base URL and is rejected in production.
- `NOTION_MODE=live` requires `NOTION_AUTHORIZATION_REF` and the official API host.
- The Notion **token** is entered in the admin UI and stored encrypted. It is never an environment variable.

## Documents
- `PROJECT_BRIEF.md`: requirements
- `docs/DESIGN.md`: approved design
- `docs/PLAN.md`: milestones, checklists and decisions log
- `docs/COMPLIANCE.md`: legal and consent prerequisites
- `docs/NOTION_SETUP.md`: connecting the separate Notion test database
- `reports/`: test evidence
- `CLAUDE.md`: rules for AI-assisted development
