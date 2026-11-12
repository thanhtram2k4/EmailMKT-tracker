| ID | Scenario | MOCK/LIVE | Result | Notes |
|---|---|---|---|---|
| S1 | App and worker start; /healthz reports DB ok and worker heartbeat < 60 s | MOCK | PASS | HTTP 200; db=true; worker=true; heartbeat age=1s; build=local-stack |
| S2a | Allowed staff account can sign in (dev identity provider) | MOCK | PASS | verify → 302 /; dashboard HTTP 200; shows signed-in user: true |
| S2b | Outside-domain account is rejected (dev identity provider) | MOCK | PASS | verify → HTTP 302 → /access-denied?error=ACCESS_DENIED_WRONG_DOMAIN; session cookie set: false |
| S2c | Company-domain account not on allowlist is rejected (dev identity provider) | MOCK | PASS | verify → HTTP 302 → /access-denied?error=ACCESS_DENIED_NOT_ALLOWLISTED; session cookie set: false |
| S2-live | Google OAuth sign-in with a real company Workspace account (allowed) and an outside account (rejected) | LIVE | BLOCKED | No Google OAuth client configured (M0 prerequisite). Requires an interactive Google sign-in on a deployed environment. |
| S3-mock | Notion sync (mock server, synthetic data): contact count matches non-trashed pages; repeat sync creates nothing | MOCK | PASS | run1=succeeded created=39; run2=succeeded created=0; active contacts=39, non-trashed mock pages=39 |
| S3-live | Sync now against the separate Notion TEST database; counts match | LIVE | BLOCKED | No Notion test database or connection token yet (see docs/NOTION_SETUP.md); live Notion access not authorized under M2. |
| S4-m3 | Import SYNTHETIC template A; preview for a recipient without greeting name uses the fallback; no unresolved fields | MOCK | PASS | errors=0; missing without fallback=none; fallback used=true |
| S4 | Subject + body with fallbacks; preview as a synced CRM contact without a greeting name has no unresolved fields | MOCK | PASS | subject="Chào bạn — bản tin"; body errors=0; missing=none; check: 33 contacts, 0 affected, 0 blocking |
| S5-mock | Test send in SEND_MODE=mock to the allowlisted reserved-domain inbox: accepted by the in-process transport, [TEST] prefix, no network, no campaign link | MOCK | PASS | status=accepted; transport calls=1; subject="[TEST] Smoke Công ty An Phát"; to=q***@example.com |
| S5-live | Real test send through SES to an allowlisted inbox / the SES simulator; Delivery event; campaign metrics unchanged | LIVE | BLOCKED | Not authorized: needs the user's separate approval, SES setup (verified identity, credentials) and SEND_AUTHORIZATION_REF. Delivery events also need a public HTTPS SNS endpoint (no deployment). |
| S10 | UI shell: each sidebar page returns 200 with the <main id="main"> landmark for a signed-in admin (dev sign-in) | MOCK | PASS | 8 pages ok |
| S6 | Send now to 3 simulator addresses → Sent 3 / Delivered 2 / Bounced 1 | - | NOT RUN | Feature not implemented yet (M5). |
| S7 | Scheduled send (+3 min, Asia/Ho_Chi_Minh) executes with browser closed | - | NOT RUN | Feature not implemented yet (M6). |
| S8 | Open, click, unsubscribe recorded; redirect to snapshot URL | - | NOT RUN | Feature not implemented yet (M7). |
| S9 | Cancelled scheduled campaign never dispatches | - | NOT RUN | Feature not implemented yet (M6). |
