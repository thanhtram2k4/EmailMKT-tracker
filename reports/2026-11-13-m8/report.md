# Test report — M8: Notion summaries, hardening, backups and release (local, mock only)

- **Build:** branch `m8-release` from `m7-checkpoint` (`a3faae3`); M8 changes uncommitted at the time of the runs (see §9).
- **Environment:** local, Windows 11, Node 24, PostgreSQL 17 (embedded), Chromium (Playwright). Isolated stack `scripts/local-stack.ts` (APP_ENV=test, NOTION_MODE=mock, `TRUSTED_PROXY_HOPS=1`); SEND_MODE `disabled` and `mock`.
- **Executed (Asia/Ho_Chi_Minh, UTC+07:00), 2026-11-13:** regression run 1 19:07–19:41 (`logs/run1/`), run 2 20:09–20:53 (`logs/run2-final/`), run 3 20:55–21:17 (`logs/run3/`), final run 4 21:35–21:51 (`logs/run4/`); R-UI-03 reproduction runs and mutation checks between runs 3 and 4 (`logs/repro-r-ui-03-*.txt`, `logs/wrap-check-*.txt`, `logs/mutation-checks.txt`).
- **Executed by:** Claude Code (AI), at the user's request. No AI/LLM API is used by the app or by the tests.
- **Authorized scope:** local, mock environment only. **No** real email, **no** AWS call, **no** deployment, **no** push, **no** live Notion.

> **Summary.** M8 adds the Notion "Email Campaigns" summaries and the Last emailed / Last engagement write-back, a security review that is now pinned by regression tests (it found and fixed one real weakness from M7: the client IP was taken from the forgeable left-most `X-Forwarded-For` entry), provider-independent backups with a restore drill, and a runbook. All PASS results are **MOCK**. The live controlled campaign and the provider (Render) backup drill are **BLOCKED** (no accounts, legal answers pending, not authorized). The final full run (run 4) passed every step with exit code 0. Along the way the regression found one presentation defect (a page wider than a phone screen), which needed two fixes (§5), plus two failures that were the laptop entering standby, not defects.

## 1. What M8 adds
- **Notion campaign summaries** (`src/lib/crm/campaign-summaries.ts`). An admin creates an "Email Campaigns" database under a parent page (Settings → Notion). One page per finished campaign holds name, Campaign ID, subject, status, sent/finished times, recipient and outcome counts, and the filtered open/click rates. The page is rewritten at completion, +24 h, +72 h and +7 days (only the latest due stage runs; missed stages are covered; nothing after +7 days). Before any create, the database is queried by Campaign ID, so a create whose answer was lost is adopted rather than duplicated. A create is never retried as the same request. Failures are recorded on the campaign page (“Notion summary” row) and never touch sending. Worker cron `notion_summaries` runs every 5 minutes when CRM schedules are on.
- **Engagement write-back.** "Last emailed" and "Last engagement" are queued to `notion_outbox` (`set_engagement`, absolute dates, only for contacts whose values changed since the last queue, and only when those Notion properties are mapped as dates). The outbox keeps the M2 retry rules and rate limit.
- **Security hardening** (§4).
- **Backups** (`src/lib/ops/backup.ts`, `npm run backup`): logical export in one repeatable-read snapshot (JSON lines per table in foreign-key order, manifest with migration count, row counts and md5 checksums); restore only into an empty database migrated to the same version; verify (row count + checksum per table); drill against a loopback server only. Provider-independent: it does not depend on Render's backups.
- **Runbook** `docs/RUNBOOK.md`: components, configuration and secrets, first deployment (unverified), go-live gate, daily operations, incidents, backup/restore/drill, release procedure.

## 2. Commands and exit codes (final build, run 4, `logs/run4/`)
| Command | Exit | Time | Result |
|---|---|---|---|
| `npm run lint` · `npm run typecheck` | 0 · 0 | 10 s · 6 s | clean |
| `npm run test:unit` | 0 | 6 s | 270/270 (M7: 201; M8 adds rate-limit and security-static, incl. one test per entry point and Server Function) |
| `npm run test:integration` | 0 | 167 s | 104/104 (M7: 96; +5 summaries, +3 backup/restore) |
| `npm run test:tooling` | 0 | 20 s | 7/7 |
| `npm run smoke:local` (disabled) | 0 | 35 s | 12 PASS · 7 BLOCKED · 0 NOT RUN · 0 FAIL (+OPS-1 restore drill) |
| `npm run e2e` (disabled) | 0 | 186 s | 54 passed, 13 skipped (mock-only) (M7: 50; +SEC-01…04) |
| `npm run e2e:mock-send` | 0 | 40 s | 4 passed, 1 skipped |
| `npm run e2e:mock-campaign` (M5–M7) | 0 | 398 s | 12 passed, 1 skipped (incl. OR-SCH-01, the real ~4-minute scheduled wait) |
| `npm run smoke:mock-send` (mock) | 0 | 104 s | 15 PASS · 7 BLOCKED · 0 NOT RUN · 0 FAIL (+S11-mock, +OPS-1; S7-mock delay 31 ms) |
| `tsx scripts/log-audit.ts` (all five stack log dirs) | 0 | 2 s | 15 log files, 0 unmasked addresses |
| `npm audit` | 1 | — | 11 moderate, 0 high, 0 critical (§4) |

Every stack ended with "cleanup ok: … none left"; test ports 3100, 4011, 54331 and 54332 were free afterwards. The user's own dev stack (ports 3000, 4010, 54321) was left running and untouched.

## 3. Results by scenario
| ID | Scenario | MOCK/LIVE | Result | Evidence |
|---|---|---|---|---|
| R-NOT-01 | Summary stages: latest due stage written; missed stages covered; nothing after +7 days | MOCK | PASS | unit-style `dueStage` test in `tests/integration/campaign-summaries.test.ts` |
| R-NOT-02 | One summary page per campaign across stages (same page rewritten) | MOCK | PASS | integration (completion → +24 h → +7 d; one page in the mock data source) |
| R-NOT-03 | An uncertain create (applied, then failed) is adopted by the next run, not duplicated | MOCK | PASS | integration (mock fault `applyThenFail`); mutation MT1 |
| R-NOT-04 | Engagement write-back: only changed contacts queued; absolute dates; re-queued after new engagement | MOCK | PASS | integration |
| S11-mock | Summaries + write-back on the running stack over HTTP to the mock Notion server | MOCK | PASS | smoke (database created; one page per finished campaign; synced contact's Last emailed set in mock Notion) |
| R-SEC-01 | Security headers on app pages and public endpoints | MOCK | PASS | E2E SEC-01 |
| R-SEC-02 | CSRF: a Server Function form posted from a foreign origin is refused | MOCK | PASS | E2E SEC-02 (Next.js origin check; no state change) |
| R-SEC-03 | Session cookie HttpOnly + SameSite=Lax | MOCK | PASS | E2E SEC-03 |
| R-SEC-04 | Per-client rate limits on `/o`, `/c`, `/u`, `/api/ses-events`; a forged `X-Forwarded-For` entry does not bypass them | MOCK | PASS | unit `rate-limit.test.ts`; E2E SEC-04; mutation MT2 |
| R-SEC-05 | Static: auth on every page/route/Server Function except declared public endpoints; admin-only actions pinned; no tracked secrets | MOCK | PASS | unit `security-static.test.ts`; mutation MT3 |
| R-OPS-01 | Restore drill (export → fresh DB → restore → verify), tamper detection, non-empty target refused | MOCK | PASS | integration `backup-restore.test.ts`; smoke OPS-1 on the populated stack; mutations MT4, MT5 |
| R-OPS-02 | No unmasked email addresses in stack logs | MOCK | PASS | `scripts/log-audit.ts` after the stack suites |
| M1–M7 regression | All earlier suites | MOCK | PASS | run 4 |
| Live controlled campaign | 4 SES simulator addresses + 3 allowlisted inboxes; one send-now, one scheduled; per-recipient results, analytics, Notion summaries | LIVE | BLOCKED | Needs the M0 accounts (SES, Notion, hosting), the legal answers (tracking consent, 3-email cap, `[QC]` label) and separate approval |
| Provider backup drill | Restore a Render backup | LIVE | BLOCKED | No hosting account; deployment not authorized |

## 4. Security review
| Area | Finding | Action |
|---|---|---|
| Authentication | Every page, route handler and Server Function checks the signed-in staff member, except `/u`, `/o`, `/c`, `/api/ses-events`, `/healthz`, the sign-in flow and `/access-denied`. No gap found. | Pinned by `security-static.test.ts`: a new entry point fails the test until it is classified. |
| Roles | Matches the confirmed rule (admins approve, schedule, send, resume, cancel, resolve uncertain sends; members create, edit, review, pause). | Pinned per action in the same test. |
| CSRF | Server Functions rely on Next.js's Origin/Host check; route handlers that change state are either public by design (one-click unsubscribe, SNS) or not exposed. | E2E SEC-02 posts a real Server Function form from a foreign origin. |
| Client IP (**defect, from M7**) | Rate limiting and IP hashing used the **left-most** `X-Forwarded-For` entry, which any client can set. | Fixed: the IP is counted from the right by `TRUSTED_PROXY_HOPS` (0 = no proxy → no IP). Unit + E2E + mutation MT2. |
| Abuse limits | Public endpoints had no limits. | Fixed-window limits per client and endpoint: `/o` 600, `/c` 300, `/u` 60, `/api/ses-events` 3000 per minute; 429 with `Retry-After`. In-process (one web instance); a shared store is needed if the web tier is scaled out (RUNBOOK). |
| Headers | `nosniff`, `X-Frame-Options: SAMEORIGIN`, Referrer-Policy were present. | Added Permissions-Policy, `Cross-Origin-Opener-Policy: same-origin`; HSTS only in production builds. |
| Secrets | No env files other than `.env.example` and no keys or tokens are tracked; Notion token encrypted (AES-256-GCM, M2). The scan covers tracked files, so the new M8 files are covered once they are committed. | Static test (two well-known fake AWS keys in redaction tests allowlisted by value). |
| PII in logs | 0 unmasked addresses across all stack logs. | `scripts/log-audit.ts` (exit 1 on any leak or on no files). |
| Dependencies | `npm audit` (`logs/npm-audit.txt`): **no high or critical**. 11 moderate, all in development tooling: esbuild dev-server advisory GHSA-67mh-4wv8-2f99 via `drizzle-kit` (devDependency, migration generator, never loaded at runtime; npm counts these 4 even with `--omit=dev`, `logs/npm-audit-prod.txt`), and minimatch ReDoS GHSA-g3hv-75wg-m249 via `typescript-eslint` (lint only). | Not changed during the release runs. Recommended: `npm audit fix` (non-breaking, lint toolchain) in the next cycle with a full regression; the drizzle-kit fix offered by npm is a downgrade and is not appropriate. |

## 5. Failures, defects and fixes (first failures kept)
| # | Found by | First failure | Classification | Fix | Retest |
|---|---|---|---|---|---|
| D1 | Run 1, R-UI-03 | `/settings/notion: +11px` at 375 px: long unbreakable `<code>` strings (ids, property names) widened the page | Product defect (presentation) | `code { overflow-wrap: anywhere }` in `globals.css` | Reproduced first with `--repeat-each 2` (failed on attempt 2), then PASS ×2; PASS in run 2 |
| D1b | Run 3, R-UI-03 (**the D1 fix was incomplete**) | `/settings/notion: +1px ()`: the test's diagnostics named no element | Same product defect, plain text: the Connection card shows `by user:<32-character id>` (the connecting staff member's actor id), a random unbreakable string, so the overflow depended on the glyph widths of that run's id (0–6 px) | Diagnostics improved first (text nodes, wrappers themselves), then four full-suite reproductions: +2 px with no element named (`logs/repro-r-ui-03-full.txt`), pass, pass, then +6 px naming `text in p [380.7] "user:DwP9…"` (`logs/repro-r-ui-03-full-4.txt`); crm.spec + ui-shell alone passed (`logs/repro-r-ui-03-run3.txt`). Fix: `.card, .banner { overflow-wrap: break-word }` (wraps only a string that would overflow; tables keep scrolling inside `.table-wrap`) | Deterministic one-off check (a 120-character unbreakable string in the card and a 170-character URL in a banner at 375 px): **before** the fix +1538 px (`logs/wrap-check-before-fix.txt`), **after** 0 px with the table still scrolling (`logs/wrap-check-after-fix.txt`); run 4 |
| D2 | Security review | Client IP from the left-most `X-Forwarded-For` entry (M7) | Product defect (security) | §4 | Unit, E2E SEC-04, MT2 |
| T1 | Run 1, R-UI-04 (axe, light and dark, every page) | Test timeout 30 s exceeded in `page.evaluate` | Test budget too small on a slow machine (this machine ran about 3× slower than in M7) | `test.setTimeout(180_000)` | PASS in runs 2–4 |
| T2 | Run 1, OR-TRK-01 | Test timeout 30 s exceeded | Test budget | `test.setTimeout(120_000)` | PASS in runs 2–4 |
| T3 | Run 2, integration `worker.test.ts` "executes each queued job once" (M1 test) | A job row still present right after its probe row appeared | Test defect (race): the task writes its row before Graphile Worker deletes the finished job | Fail at once on any retried or failed job, then wait for the queue to drain | 5/5 (`logs/worker-test-retest-5x.txt`); full integration suite 104/104 in runs 3 and 4 |
| E1 | Run 2, e2e-disabled, crm.spec "a 'resubscribe' in Notion never removes the suppression…" | Dev sign-in: `current-user` not found; test timeout 30 s | **Environment**: Windows entered Modern Standby 20:22:29–20:23:07 during the test (System log, Kernel-Power 506/507); web log shows no requests 20:22:30–20:23:32 | None needed in code | PASS in runs 3 and 4 (kept awake) |
| E2 | Run 2, e2e-mock-campaign, OR-SCH-01 (S7, real ~4-minute wait) | Status `sending` instead of `completed`; test timeout 8 min | **Environment**: Modern Standby 20:32:55–20:47:39. The worker process was suspended with the machine; on resume it started the campaign 643,837 ms late (inside the 30-minute grace, as designed), sent 3/3 and completed | None needed in code | PASS in runs 3 and 4 (kept awake) |
| T4 | Development, S11-mock | Outbox writes 404 for contacts the smoke inserts directly with fake Notion page ids | Test defect (smoke design) | Send to a contact synced from the mock server; report the expected 404s for inserted contacts separately | PASS |
| T5 | Development, summaries integration | Request count 2 for one create | Test defect: the mock's `applyThenFail` logs a request twice | Assert pages in the data source instead | 5/5 |
| T6 | Development, backup integration | Hard-coded 40 contacts / ≥ 8 messages | Test defect | Exact counts from the source DB; tamper test on a third DB | 3/3 |
| T7 | Development, secret scan | Fake AWS key in `redact.test.ts` flagged | Test defect (false positive) | Allowlist the two well-known fake values only | PASS |

Run 2 differs from run 3 only by the test fix T3; run 4 differs from run 3 by the D1b CSS fix and the improved R-UI-03 diagnostics (test only). Runs 3 and 4 were executed inside a process that held a Windows keep-awake request (`SetThreadExecutionState`), released when the run ended; no power settings were changed.

## 6. Mutation checks (`logs/mutation-checks.txt`; control run first, then the defect, then revert)
| Mutation | Test | Result |
|---|---|---|
| MT1 summary page created without the Campaign ID lookup | `campaign-summaries.test.ts` (R-NOT-03) | CAUGHT (1 failed / 5) |
| MT2 client IP from the left-most `X-Forwarded-For` entry | `rate-limit.test.ts` (R-SEC-04) | CAUGHT (2 failed / 3) |
| MT3 `resumeAction` opened to members | `security-static.test.ts` (R-SEC-05, role rule) | CAUGHT (1 failed / 66) |
| MT4 restore into a non-empty database allowed | `backup-restore.test.ts` (R-OPS-01) | CAUGHT (1 failed / 3) |
| MT5 verify compares row counts only (no checksums) | `backup-restore.test.ts` (R-OPS-01, tamper) | CAUGHT (1 failed / 3) |

Each control run passed first; every mutation was reverted (anchors re-checked, no backup files left).

## 7. Not proven / not done
- **LIVE:** nothing in M8 ran against real Notion, SES, Google or a host. The summaries were tested against the mock Notion server only; the real "Email Campaigns" database properties and Notion's handling of `data_source_id` parents are unverified.
- **Live controlled campaign:** BLOCKED (M0 accounts, legal answers, separate approval).
- **Provider backups and a restore of them:** BLOCKED (no hosting account). The logical backup was drilled locally only, with synthetic data.
- **Rate limits** are per process; with more than one web instance they would need a shared store. `TRUSTED_PROXY_HOPS` must be set for the real host (Render: expected 1; verify on staging).
- **Staging, CI, Google OAuth:** still unverified (as in M1–M7).
- **Email client rendering** (Gmail, Outlook, mobile): NOT RUN (as in M3).

## 8. Redaction
Reports and logs contain only reserved-domain fixture addresses (masked in logs; the log audit found none unmasked). No tokens, cookies or keys appear in the evidence; manual check done on `logs/` and this report. Nothing was sent to anyone.

## 9. Recommendation
- **M8 is complete for the mock environment.** Commit it locally with tag `m8-checkpoint` (not pushed) when the user asks.
- Before the live campaign, outside M8's code: run `npm audit fix` for the lint toolchain and a full regression; set `TRUSTED_PROXY_HOPS` for the host and verify it on staging; consider showing the connecting staff member's email instead of the `user:<id>` actor id on Settings → Notion (cosmetic; it now wraps).
- **The release is not proven LIVE.** The final M8 item, a live controlled campaign, stays BLOCKED until the accounts, legal answers and approvals below exist. That run would also be the first LIVE check of SES, SNS events, Notion summaries and the host's backups.

**Before the live campaign the user needs to provide (never in Git, chat or env files where noted):**
- AWS: SES in ap-southeast-1 out of the sandbox, a verified sending domain, an SNS topic for events. Credentials come from an AWS profile on the host (open question in PLAN: how the host provides them, e.g. Render secret files or an IAM role); never pasted into chat.
- Notion: an internal integration shared with the **test** database and the parent page for "Email Campaigns"; the token is entered in Settings → Notion (stored encrypted), and `NOTION_AUTHORIZATION_REF` recorded.
- Hosting (Render, Singapore): web + worker + PostgreSQL; secrets in the host's environment (RUNBOOK §2).
- Legal answers: tracking consent basis, the 3-email cap, the `[QC]` label.
- Approvals: `SEND_AUTHORIZATION_REF` for simulator/allowlist sends, then the go-live gate in `docs/COMPLIANCE.md`.
