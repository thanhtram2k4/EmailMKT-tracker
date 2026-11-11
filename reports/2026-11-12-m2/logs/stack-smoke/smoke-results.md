| ID | Scenario | MOCK/LIVE | Result | Notes |
|---|---|---|---|---|
| S1 | App and worker start; /healthz reports DB ok and worker heartbeat < 60 s | MOCK | PASS | HTTP 200; db=true; worker=true; heartbeat age=0s; build=src-a3d4ec6dbe3a |
| S2a | Allowed staff account can sign in (dev identity provider) | MOCK | PASS | verify → 302 /; dashboard HTTP 200; shows signed-in user: true |
| S2b | Outside-domain account is rejected (dev identity provider) | MOCK | PASS | verify → HTTP 302 → /access-denied?error=ACCESS_DENIED_WRONG_DOMAIN; session cookie set: false |
| S2c | Company-domain account not on allowlist is rejected (dev identity provider) | MOCK | PASS | verify → HTTP 302 → /access-denied?error=ACCESS_DENIED_NOT_ALLOWLISTED; session cookie set: false |
| S2-live | Google OAuth sign-in with a real company Workspace account (allowed) and an outside account (rejected) | LIVE | BLOCKED | No Google OAuth client configured (M0 prerequisite). Requires an interactive Google sign-in on a deployed environment. |
| S3-mock | Notion sync (mock server, synthetic data): contact count matches non-trashed pages; repeat sync creates nothing | MOCK | PASS | run1=succeeded created=39; run2=succeeded created=0; active contacts=39, non-trashed mock pages=39 |
| S3-live | Sync now against the separate Notion TEST database; counts match | LIVE | BLOCKED | No Notion test database or connection token yet (see docs/NOTION_SETUP.md); live Notion access not authorized under M2. |
| S4 | Preview as recipient with no unresolved fields | - | NOT RUN | Feature not implemented yet (M4). |
| S5 | Test send → simulator Delivery event; campaign metrics unchanged | - | NOT RUN | Feature not implemented yet (M4). |
| S6 | Send now to 3 simulator addresses → Sent 3 / Delivered 2 / Bounced 1 | - | NOT RUN | Feature not implemented yet (M5). |
| S7 | Scheduled send (+3 min, Asia/Ho_Chi_Minh) executes with browser closed | - | NOT RUN | Feature not implemented yet (M6). |
| S8 | Open, click, unsubscribe recorded; redirect to snapshot URL | - | NOT RUN | Feature not implemented yet (M7). |
| S9 | Cancelled scheduled campaign never dispatches | - | NOT RUN | Feature not implemented yet (M6). |
