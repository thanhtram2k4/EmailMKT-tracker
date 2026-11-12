# Email MKT Tracker

This is an internal email-marketing tool. **Current state: M2.** Contacts are synchronized from a Notion CRM, and the foundation from M1 is in place.

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

Local development uses a **mock Notion server with synthetic contacts**. No real Notion workspace is contacted unless `NOTION_MODE=live` is set with a recorded authorization (see `docs/NOTION_SETUP.md`). No email can be sent: there is no real transport, and `SEND_MODE` defaults to `disabled`.

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

### Walkthrough: template editor trial (M3)
1. Open **Templates**. Click **Import TỔNG HỢP A…** (table newsletter with Outlook conditional comments and merge fields) or **Import TỔNG HỢP B…** (unsafe markup, to see sanitization).
2. To try your own file, use **HTML file**:
   - If the email sits inside a tool page, set **Only import part of the page** to its selector, e.g. `#email`.
   - The file stays in your local database. Nothing is sent anywhere.
3. In the editor:
   - **Edit regions.** Click a text block, image, link or button in the preview, or pick one from **Editable regions**.
     - Text uses a rich-text field with a **merge-field picker**.
     - Images take a URL and alt text; links and buttons take a destination, and buttons also take their text.
     - A warning appears if a block has formatting the rich-text field cannot keep.
   - **Save as new version.** Earlier versions stay listed and can be reopened.
   - **Preview as a recipient**, e.g. "Mẫu: thiếu tên gọi", to see the fallbacks (`Quý khách`) and any "missing values without fallback".
   - **Desktop 640px / Mobile 375px.** These are **your browser's** rendering only, not Gmail, Outlook or a phone mail app.
   - **Side panels:** checks (images, links, size, merge fields), the sanitization report, **Export HTML / plain text**, and **Open in GrapesJS (trial)** for comparison.

**Stopping:** press Ctrl+C in both terminals. On Windows, check that no `node`/`postgres` processes from this folder remain if a terminal was closed abruptly (see `CLAUDE.md` → "Windows process hygiene").

## Checks
```bash
npm run lint && npm run typecheck
npm run test:unit
npm run test:integration     # starts a throwaway PostgreSQL automatically
npm run e2e                  # throwaway DB + production build + worker + mock Notion + Playwright, then tears down
npm run smoke:local          # same isolated stack, runs the smoke suite (results in .local/logs/smoke/)
```

## Configuration
See `.env.example`. Safety rules are enforced at startup, and the web and worker processes refuse to start when they are broken:
- `SEND_MODE=live` is rejected unless `APP_ENV=production`.
- `SEND_MODE=simulator` and `SEND_MODE=allowlist` require `SEND_AUTHORIZATION_REF`.
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
