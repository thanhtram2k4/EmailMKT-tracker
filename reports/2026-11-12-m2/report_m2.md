# Test report: M2 Notion CRM (mocked Notion, synthetic contacts)

| | |
|---|---|
| Build | `src-a3d4ec6dbe3a`: content hash of the working tree on branch `m2-notion-crm`, based on commit `3f11649` (tag `m1-checkpoint`). Committed afterwards as the M2 checkpoint; see the commit and tag at the end |
| Environment | Local Windows 11 Pro 10.0.26300 · Node v24.18.1 · npm 11.16.0 · throwaway PostgreSQL 17.10 (embedded-postgres) · Next.js 16.4.6 production build · Graphile Worker 0.18.0 · Playwright 1.65.0 (headless Chromium) · **local mock Notion server** (`scripts/notion-mock/`) |
| Config under test | `APP_ENV=test` · `SEND_MODE=disabled` · `NOTION_MODE=mock` (loopback) · Notion API version `2026-03-11` · per-run random `APP_ENCRYPTION_KEY` |
| Data | **Synthetic only.** 40 fabricated contacts on reserved domains (`example.com/org/net`, `*.example`) plus generated test pages. No real contacts were imported |
| Executed | Final cycle 2026-11-11 18:46:39Z – 18:48:28Z, which is **2026-11-12 01:46:39 – 01:48:28 (Asia/Ho_Chi_Minh, UTC+07:00)** |
| Integrations | **None live.** No Notion workspace, Google, AWS/SES or email traffic. No deployment, no push |

## Commands (final cycle)
| Command | Exit | Duration | Log |
|---|---|---|---|
| `npm run lint` | 0 | 5 s | [logs/lint.log](logs/lint.log) |
| `npm run typecheck` | 0 | 5 s | [logs/typecheck.log](logs/typecheck.log) |
| `npx vitest run --project unit --reporter=verbose` | 0 | 3 s | [logs/unit.log](logs/unit.log) |
| `npx vitest run --project integration --reporter=verbose` | 0 | 36 s | [logs/integration.log](logs/integration.log) |
| `npm run e2e` (DB + production build + worker + mock Notion + Playwright) | 0 | 38 s | [logs/e2e.log](logs/e2e.log), [logs/stack-e2e/](logs/stack-e2e/), [logs/e2e-results.json](logs/e2e-results.json) |
| `npm run smoke:local` | 0 | 22 s | [logs/smoke.log](logs/smoke.log), [logs/stack-smoke/smoke-results.md](logs/stack-smoke/smoke-results.md) |

Totals:
- **Unit: 99/99 passed.** 39 of these are M1 regression tests; 60 are new (7 config, 27 validation/consent/eligibility, 11 mapping, 10 Notion client, 5 encryption).
- **Integration: 37/37 passed.** 15 M1 regression tests and 22 CRM tests.
- **E2E: 15/15 passed.** 8 M1 regression tests and 7 CRM tests.
- **Smoke: 5 PASS, 2 BLOCKED, 6 NOT RUN.**

Exit codes are trustworthy as of this cycle: a deliberately failing test exits 1 (see F4).

## M2 acceptance criteria
| ID | Criterion | Type | Result | Evidence |
|---|---|---|---|---|
| R-SYNC-01 | Repeated syncs create no duplicate contacts | MOCK | **PASS** | Integration "repeated syncs create no duplicate contacts, consent or suppression rows"; E2E "a repeated full sync creates nothing new"; smoke S3-mock (`run2 created=0`) |
| R-SYNC-02 | Pages sharing an email are flagged and excluded from audiences | MOCK | **PASS** | Integration "synthetic CRM import" (5 duplicate contacts, case and whitespace variants); unit "eligibility: duplicates"; E2E "data issues: … choosing a primary" |
| R-SYNC-03 | An email change keeps the same contact | MOCK | **PASS** | Integration R-SYNC-03 (same id; old suppressed address kept; `email_changed_from_suppressed` flagged and audited) |
| R-SYNC-04 | A trashed page is archived | MOCK | **PASS** | Integration R-SYNC-04: trashed → archived; missing → archived only by a *full* sync; restored → reactivated |
| R-SYNC-05 | A suppressed contact marked "Subscribed" in Notion stays suppressed, and Notion is rewritten | MOCK | **PASS** | Integration R-SYNC-05 ×3 (including DB refusal of delete/update/imported grant); E2E "a 'resubscribe' in Notion never removes the suppression and is corrected in Notion" |
| R-SYNC-06 | A simulated 429 backs off and the sync succeeds | MOCK | **PASS** | Integration "recovers from 429 (Retry-After) and 503"; unit retry-policy tests on a virtual clock |
| S3-live | A live sync against the Notion test database matches the counts | LIVE | **BLOCKED** | No separate Notion test database or token. Live access is not authorized under M2. Steps are in `docs/NOTION_SETUP.md` §6 |

## What the tests cover (meaningful behaviour, not implementation details)
- **Pagination:** 250 pages are read as 3 queries of `page_size: 100` with cursors.
- **Notion's 10,000-result query cap**, simulated at 120:
  - reading continues in time-ordered chunks;
  - if a chunk makes no progress, the run is `partial` and **nothing is archived**.
- **Incremental sync:**
  - filters on `last_edited_time ≥ cursor − 5 min`;
  - catches an edit made in the *same minute* as the cursor (the fake rounds times to the minute);
  - reads only the overlap window.
- **Rate limiting:**
  - the token bucket paces at 2.5 req/s;
  - 30 requests against a server enforcing 3 req/s produce **0** 429s.
- **Retries:**
  - 429 `Retry-After` honoured (7 s ×2);
  - 529 and 503 backed off (1 s, 2 s, 4 s);
  - gives up after 5 attempts;
  - no retry on 401/404/400;
  - network errors retried on reads;
  - create-database is **never** retried: an uncertain outcome is reported, and a 5xx after the write was applied did not create a second database;
  - a very long `Retry-After` aborts instead of blocking.
- **Partial failures:**
  - Retries exhausted on the 2nd query page: `partial`, 100 fetched, cursor unchanged, nothing archived. The next run completes with 250 contacts and no duplicates.
  - One page failing to write: the others are imported, the run is `partial` with a page-level `sync_issue`, and the page is retried on the next sync.
  - Unexpected property type: recorded as a data issue; the run succeeds.
  - Schema drift (mapped property renamed): run `failed/schema_mismatch`, contacts untouched, error shown on the connection.
- **Concurrency:**
  - A second sync while one is running is `skipped/already_running` (advisory lock).
  - A stale `running` row from a crashed worker is marked `failed/interrupted`.
- **Consent:**
  - Imports create `unknown` records and keep Notion's evidence reference, so 0 `granted` rows after import.
  - Unsubscribed, Bounced or Complained in Notion → suppression plus `withdrawn`.
  - A staff grant needs evidence (unit, DB constraint, E2E).
  - Granting never removes a suppression.
- **Token handling:**
  - The ciphertext does not contain the token, and the audit log does not contain it.
  - A wrong token gives a clear 401 message and nothing is stored.
  - The token field is never pre-filled in the UI.
  - AES-GCM tamper, wrong-purpose and wrong-key cases are refused; key rotation works.
- **Outbox:**
  - 503 → retried later with backoff; 404 → permanently failed and shown on the Sync screen.
  - Writes are coalesced.
  - A value replaced *while a write was in flight* is not marked done; the newer value stays pending.
- **Vietnamese text:**
  - NFD input is stored as NFC, so an NFC search finds it (E2E).
  - Mapping suggestion understands "Họ và tên", "Thư điện tử", "Tên gọi", "Công ty" and "Nhãn".
  - The Contacts list uses Vietnamese collation.
- **Authorization:**
  - Members can read contacts but get no consent form, no Sync buttons, and `/settings/notion` redirects them to `/forbidden`.
  - Every server action re-checks the role.

## Smoke
| ID | Scenario | Type | Result | Notes |
|---|---|---|---|---|
| S1 | App and worker start; `/healthz` ok | MOCK (local stack) | PASS | heartbeat age 0 s |
| S2a–c | Allowed sign-in; outsider and non-allowlisted rejected (dev identity) | MOCK | PASS | |
| S2-live | Google OAuth sign-in | LIVE | BLOCKED | no OAuth client |
| S3-mock | Sync against the mock server: count matches non-trashed pages; repeat sync creates nothing | MOCK | PASS | 39 = 39; run 2 created 0 |
| S3-live | Sync against the separate Notion TEST database | LIVE | BLOCKED | no test database or token; not authorized |
| S4–S9 | Preview, test send, send now, schedule, tracking, cancel | — | NOT RUN | M4–M7 not implemented |

## Screenshots (synthetic data)
- [Notion settings, after connecting to the mock](screenshots/m2-notion-settings.png)
- [Sync runs](screenshots/m2-sync-runs.png)
- [Contacts list](screenshots/m2-contacts.png)
- [Data issues](screenshots/m2-data-issues.png)
- [Contact detail with consent history](screenshots/m2-contact-consent.png)

## Failures, fixes and retests (first failures kept)
First-run logs are in [logs/first-runs/](logs/first-runs/).

| # | Found by | Initial failure (observed) | Root cause | Fix | Retest |
|---|---|---|---|---|---|
| F1 | Unit, first run ([unit-run1.log](logs/first-runs/unit-run1.log)) | 30 paced requests against a server enforcing 3 req/s got **9× 429** | **Design defect.** The client allowed a burst of 3 and then 2.5/s, so it could send about 5 requests in one second. Notion documents an *average* of 3/s, but we should not depend on its tolerance for bursts | Limiter burst set to 1, which keeps at most about 3 requests in any one-second window | PASS ([unit-run2.log](logs/first-runs/unit-run2.log)) |
| F2 | Unit, first run | "Uncertain create" test expected 0 recorded requests, but the fake recorded 1 | **Test defect.** The fake logs simulated network failures | Assert exactly 1 attempt and no database created | PASS |
| F3 | Unit, first run | M1 test "accepts SEND_MODE=live only in production" failed | **Intended requirement change.** Production now requires `APP_ENCRYPTION_KEY` (encrypts the Notion token) | Added a key to the production fixture; a new test covers the missing-key case | PASS |
| F4 | Integration, first run ([integration-run1.log](logs/first-runs/integration-run1.log)) | **A failing integration run exited 0** (reproduced in isolation: [exitcode-check.log](logs/first-runs/exitcode-check.log)) | **Latent M1 tooling defect.** `embedded-postgres` → `async-exit-hook` calls `process.exit(0)` on `beforeExit`, overriding Vitest's failure code. Once that was removed, its `exit` hook threw `done is not a function`, causing exit 1 after successful runs ([integration-run2.log](logs/first-runs/integration-run2.log)) | Remove only the `beforeExit`, `message` and `exit` hooks (`scripts/lib/embedded-pg.ts`); keep the signal clean-up hooks; every caller stops Postgres explicitly | Failing run → exit 1 ([exitcode-check-after.log](logs/first-runs/exitcode-check-after.log)); passing run → exit 0 ([integration-run3.log](logs/first-runs/integration-run3.log)); deliberate failure → exit 1 (test restored) |
| F5 | Integration, first run | "records data problems" expected 1 issue, got 0 | **Test defect.** The test swapped Email to `rich_text`, which is a valid alternative type for Email | The test now uses a type no mapping accepts (`number`) | PASS |
| F6 | Manual developer-flow check ([devcheck-worker-config-error.log](logs/first-runs/devcheck-worker-config-error.log)) | The worker refused to start: `NOTION_API_BASE_URL: Invalid URL` | **Product defect.** `.env.example` contains `NOTION_API_BASE_URL=` (blank), which was validated as a URL. The tests never used blank values | Blank `KEY=` values are treated as unset; regression tests parse the committed `.env.example` | PASS (unit); the developer flow then started cleanly |
| F7 | Manual developer-flow check | Port 3000 and 4010 "already in use"; pages were served by an **old M1 dev server** | **Process hygiene.** On Windows, stopping a background task left `next dev`, the worker and `db:start` from the **M1** check running; the M1 report wrongly said none were left (corrected in its addendum) | All 15 leftover processes identified (started by my own checks) and stopped; Postgres stopped with `pg_ctl`; the developer flow was rerun from a clean state; process listing added to the checklist (CLAUDE.md) | Clean rerun: no port conflicts; afterwards 0 processes and 0 listening dev ports |
| F8 | Review of E2E screenshots | Contacts sorted Â/Đ/Ô names last | Database uses C (byte-order) collation | Sort with `Intl.Collator("vi")` | Verified on sample names; E2E rerun PASS |
| F9 | Review of the E2E test | A token assertion was meaningless (compared against a string that could never appear) | Test defect | Asserts the token field is empty after reload, and only the last-4 hint is shown | PASS |

No flaky tests were observed. Every E2E test passed on its first run ([e2e-run1.log](logs/first-runs/e2e-run1.log)) and again in the final cycle.

## Manual checks (executed, observed)
| Check | Observed | Result |
|---|---|---|
| `setup:local` on the existing M1 `.env.local` | Added 6 missing keys (`APP_ENCRYPTION_KEY` generated, `NOTION_MODE=mock`, …) without changing existing values; a second run reported "unchanged" | PASS |
| `db:migrate` on the existing M1 dev database | M2 migrations applied; existing staff rows intact | PASS |
| Clean `dev:crm`: web, worker, mock | `/healthz` 200; worker "schedules configured (notion_mode mock)"; mock serving 40 synthetic pages; `/`, `/contacts`, `/contacts/issues`, `/sync`, `/settings/notion` all 200 with an admin session; mock hint shown; `notion:mock:ctl list` works | PASS |
| Clean-up after all checks | 0 project processes, 0 listening dev ports | PASS |

## Not run, and why
| Item | Status | Reason |
|---|---|---|
| Live Notion (S3-live) and real contacts | BLOCKED | No test database or token; not authorized |
| Google OAuth, staging, live smoke (carried from M1) | BLOCKED | No OAuth client or host; deployment not authorized |
| CI workflow | NOT RUN | No remote repository (not to be created under this authorization) |
| Linux and macOS runs | NOT RUN | Only Windows available |
| Behaviour of the real Notion API for: trashed pages in queries, minute rounding of `last_edited_time`, status-option writes | UNVERIFIED | The code handles both possibilities; the fake follows the documented behaviour where documented |

## Known limitations
- **Search** is accent-sensitive. Searching "Pham" does not find "Phạm"; a folding search can be added later.
- **Eligibility consent rule:** eligibility requires recorded marketing consent by default (`crm.require_marketing_consent`), so every imported contact is ineligible until consent is recorded. This is deliberate and pending counsel. Changing the setting requires direct DB access; there is no UI toggle yet.
- **Consent model gaps:** there is no disclosed-frequency field yet, and no data-subject lookup tool (Decree 91 Art. 11.3). Both are listed in COMPLIANCE §6.
- **Duplicate primary:** a primary choice becomes invalid automatically if that contact is archived; the group then shows as unresolved again.
- **Dependencies:** no new packages were added in M2. The npm audit status is unchanged from M1 (dev-only advisories).

## Redaction
- Text logs were passed through `src/lib/redact.ts`.
- A manual scan found no session tokens, bearer tokens, Notion/AWS/Google keys, auth secrets, the local DB password or encrypted token values.
- Every email address in the logs is masked, and all addresses are synthetic or on reserved domains.
- The mock token `mock-notion-token-not-a-secret` is a fixed, non-secret value accepted only by the local mock server.

## Release recommendation
M2 is functionally complete against **mocks and synthetic data**. It is **not** validated against a live Notion workspace and is not production-ready.

Before M2 can be accepted as verified:
1. Create the separate Notion test database and connection (`docs/NOTION_SETUP.md`).
2. Authorize live test access, recorded in `NOTION_AUTHORIZATION_REF`.
3. Run S3-live.
4. Get counsel's decisions on consent, including whether unknown consent should block eligibility, and on cross-border transfer (COMPLIANCE §3.4, §5).
