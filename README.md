# Email MKT Tracker

This is an internal email-marketing tool. **Current state: M1, the foundation.** It provides:
- staff sign-in limited to the company domain and a staff allowlist
- roles
- an audit log
- a background worker with a heartbeat
- a `/healthz` endpoint
- structured logs
- sending-safety guards

No email can be sent: there is no real transport, and `SEND_MODE` defaults to `disabled`.

## Prerequisites
- Node.js 22.18 or later (developed on Node 24).
- No Docker is needed. Local PostgreSQL 17 is provided by the `embedded-postgres` dev dependency, which keeps its data in `.local/`.

## Run locally
```bash
npm install
npm run setup:local          # creates .env.local (APP_ENV=local, SEND_MODE=disabled, dev sign-in on)
npm run playwright:install   # once, for E2E tests (installs Chromium into node_modules)

# Terminal 1: database (leave running; stop with Ctrl+C)
npm run db:start

# Terminal 2: schema + staff, then web and worker
npm run db:migrate
npm run staff:add -- admin@example.com admin
npm run staff:add -- member@example.com member
npm run dev:all              # web at http://localhost:3000 and the worker
```

Then:
1. Open http://localhost:3000. You are redirected to **Sign in**.
2. Google sign-in is disabled until a Google OAuth client is configured.
3. Use the **Dev sign-in** box instead, with `admin@example.com`. Nothing is emailed; you are taken straight in.
4. Try `someone@freemail.example`, an address outside the allowed domain, to see the access-denied page.
5. Try an `@example.com` address that isn't on the staff list to see the same page for a missing allowlist entry.
6. **Staff & audit** is visible to admins only. It lists the allowlist and recent audit events.
7. http://localhost:3000/healthz returns JSON. It is `200` when both the database and the worker are healthy, and `503` otherwise. Stop the worker to watch the dashboard banner appear.

## Checks
```bash
npm run lint && npm run typecheck
npm run test:unit
npm run test:integration     # starts a throwaway PostgreSQL automatically
npm run e2e                  # throwaway DB + production build + worker + Playwright, then tears down
npm run smoke:local          # same isolated stack, runs the smoke suite (results in .local/logs/smoke/)
```

## Configuration
See `.env.example`. Safety rules are enforced at startup, and the web and worker processes refuse to start when they are broken:
- `SEND_MODE=live` is rejected unless `APP_ENV=production`.
- `SEND_MODE=simulator` and `SEND_MODE=allowlist` require `SEND_AUTHORIZATION_REF`.
- `DEV_LOGIN_ENABLED` is rejected in staging and production.
- Staging and production require a Google OAuth client and an `https` base URL.

## Documents
- `PROJECT_BRIEF.md`: requirements
- `docs/DESIGN.md`: approved design
- `docs/PLAN.md`: milestones, checklists and decisions log
- `docs/COMPLIANCE.md`: legal and consent prerequisites
- `reports/`: test evidence
- `CLAUDE.md`: rules for AI-assisted development
