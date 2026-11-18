# Test report: M1 Foundation

| | |
|---|---|
| Build | `src-32b211b2cd00`, a SHA-256 content hash (first 12 hex characters) of all project files except `*.md`, `node_modules`, `.next`, `.local`, `reports` and test output. The repository has no commits yet. |
| Environment | Local Windows 11 Pro 10.0.26300 · Node v24.18.1 · npm 11.16.0 · throwaway PostgreSQL 17.10 (embedded-postgres) · Next.js 16.4.6 production build (`next start`) · Graphile Worker 0.18.0 · headless Chromium (Playwright 1.65.0) |
| Config under test | `APP_ENV=test` · `SEND_MODE=disabled` · `DEV_LOGIN_ENABLED=true` · no Google OAuth client · fixture staff at `example.com` / `example.net` only |
| Executed | Final cycle 2026-11-11 17:52:33Z – 17:53:47Z, which is **2026-11-12 00:52:33 – 00:53:47 (Asia/Ho_Chi_Minh, UTC+07:00)** |
| Executed by | Claude Code (automated). Results below are observed outputs, not predictions. |
| Integrations | **No live integrations were exercised.** No Google, AWS/SES, Notion or email traffic. No deployment. |

## Commands (final cycle)
| Command | Exit code | Duration | Log |
|---|---|---|---|
| `npm run lint` | 0 | 4 s | [logs/lint.log](logs/lint.log) |
| `npm run typecheck` | 0 | 3 s | [logs/typecheck.log](logs/typecheck.log) |
| `npx vitest run --project unit --reporter=verbose` | 0 | 2 s | [logs/unit.log](logs/unit.log) |
| `npx vitest run --project integration --reporter=verbose` | 0 | 16 s | [logs/integration.log](logs/integration.log) |
| `npm run e2e` (throwaway DB, `next build`, `next start`, worker, Playwright) | 0 | 28 s | [logs/e2e.log](logs/e2e.log), [logs/stack-e2e/](logs/stack-e2e/), [logs/e2e-results.json](logs/e2e-results.json) |
| `npm run smoke:local` (fresh stack, then `scripts/smoke.ts`) | 0 | 21 s | [logs/smoke.log](logs/smoke.log), [logs/stack-smoke/](logs/stack-smoke/) |

Two earlier full cycles on builds `src-f33555c885aa` and `src-71fed4a10123` also exited 0 for all six commands. They were superseded by the fixes described under "Fixes and retests".

Totals for the final build:
- Unit: **39/39 passed**
- Integration: **15/15 passed**
- E2E: **8/8 passed**
- Smoke: **4 PASS, 1 BLOCKED, 7 NOT RUN**

## M1 acceptance criteria
| # | Criterion (docs/PLAN.md) | MOCK/LIVE | Result | Evidence |
|---|---|---|---|---|
| A1 | Allowed staff sign in; outside-domain and non-allowlisted accounts are rejected (E2E) | MOCK identity (dev sign-in through the same gate) | **PASS** | E2E tests 2–7; integration `auth-gate.test.ts`; screenshots below |
| A1-live | The same, through **Google OAuth** with a real Workspace account | LIVE | **BLOCKED** | No OAuth client (M0 setup). Requires an interactive Google sign-in |
| A2 | A job enqueued before a worker restart runs after it | MOCK (real PostgreSQL + real Graphile Worker; no external services) | **PASS** | `worker.test.ts`: "runs a job that was queued while no worker was running", "…after a worker restart" |
| A3 | Staging reachable over HTTPS | LIVE | **BLOCKED** | No hosting account. Deployment was not authorized for M1 |
| A4 | Smoke S1–S2 pass | S1 and S2a–c MOCK (local stack) · S2-live LIVE | S1 **PASS** · S2a–c **PASS** · S2-live **BLOCKED** | [logs/stack-smoke/smoke-results.md](logs/stack-smoke/smoke-results.md) |

## Scenario results
### Unit (Vitest): 39 passed
| Area | What is verified | Result |
|---|---|---|
| Config safety (`config.test.ts`, 13) | `live` rejected in local, test and staging; `mock` rejected in production; simulator and allowlist modes require `SEND_AUTHORIZATION_REF`; allowlist mode requires recipients; dev sign-in rejected in staging and production; staging and production require Google OAuth and https; short secrets and missing domains rejected | PASS |
| Sending guard (`sending-guard.test.ts`, 14) | Customer campaigns are never allowed through a real transport from local, test or staging; production requires `live` plus admin enablement; simulator mode allows only `@simulator.amazonses.com`; allowlist mode allows only allowlisted recipients (case-insensitive); `disabled` refuses everything; **the transport factory refuses any real transport in M1** | PASS |
| Identity checks (`access.test.ts`, 9) | Verified-email requirement; exact domain match. Rejected: `gmail.com`, `example.com.evil.io`, `sub.example.com`, `notexample.com`, `example.com@gmail.com`, no `@` | PASS |
| Redaction (`redact.test.ts`, 2) | Emails masked as `n***@domain`; bearer tokens, cookies, AWS keys, Notion and Google tokens, and `token=` / `state=` query values removed | PASS |
| Clock (`clock.test.ts`, 1) | Controllable clock for time-dependent tests | PASS |

### Integration (Vitest, real PostgreSQL 17, one fresh database per file): 15 passed
| Test | Result |
|---|---|
| Migrations create the app, Better Auth and `graphile_worker` schemas, and are idempotent | PASS |
| `audit_log` rejects UPDATE, DELETE and TRUNCATE at the database level (trigger) | PASS |
| Health is degraded before any worker has run | PASS |
| A job queued with **no worker running** is executed once worker `w1` starts | PASS |
| After `w1` stops, a job queued **during downtime** is executed by a new worker `w2` (restart) | PASS |
| 20 jobs with two concurrent workers: all execute and the queue drains | PASS |
| A stale heartbeat (clock advanced 5 minutes) is reported degraded | PASS |
| Allowlisted admin: 302 to `/`, session cookie, session row created | PASS |
| Allowlisted member (normalized email) signs in | PASS |
| Company-domain address not on the allowlist: `/access-denied?error=ACCESS_DENIED_NOT_ALLOWLISTED`; no user or session row; audit row written | PASS |
| Outside domain: `ACCESS_DENIED_WRONG_DOMAIN`; the audit row carries the request's `x-request-id` | PASS |
| Revoked staff: `ACCESS_DENIED_DISABLED`; no session | PASS |
| Revoking an existing user deletes their sessions; the next sign-in redirects to `/access-denied?error=failed_to_create_session`; the audit row records `{reason: disabled, stage: session.create}` | PASS |
| Audit entries exist for `auth.sign_in`, `staff.added` and `staff.disabled` | PASS |

### E2E (Playwright against a production build, with worker): 8 passed
| # | Scenario | Result |
|---|---|---|
| 1 | An unauthenticated visit to `/` redirects to `/sign-in`; the Google button is disabled (no OAuth client) | PASS |
| 2 | Admin signs in, sees role `admin`, the `SEND_MODE=disabled` banner and worker "running"; opens Staff & audit; signs out; `/` then redirects to sign-in | PASS |
| 3 | Member signs in; `/staff` redirects to `/forbidden` | PASS |
| 4 | `stranger@example.com` is rejected with `ACCESS_DENIED_NOT_ALLOWLISTED` and no session | PASS |
| 5 | `outsider@example.net` is rejected with `ACCESS_DENIED_WRONG_DOMAIN` and no session | PASS |
| 6 | `revoked@example.com` is rejected with `ACCESS_DENIED_DISABLED` and no session | PASS |
| 7 | A signed-in member is revoked mid-session: their next request goes to sign-in, and re-sign-in shows the access-denied page (`failed_to_create_session`) | PASS |
| 8 | `/healthz` returns 200 with DB ok and worker ok (age ≤ 60 s) and no connection string in the body | PASS |

Screenshots (fixture data only): [admin-dashboard](screenshots/admin-dashboard.png), [admin-staff-and-audit](screenshots/admin-staff-and-audit.png), [member-forbidden](screenshots/member-forbidden.png), [denied-not-allowlisted](screenshots/denied-access_denied_not_allowlisted.png), [denied-wrong-domain](screenshots/denied-access_denied_wrong_domain.png), [denied-disabled](screenshots/denied-access_denied_disabled.png), [revoked-midsession-denied](screenshots/revoked-midsession-denied.png).

Playwright traces were recorded locally in `test-results/` (git-ignored). They are **not** copied here because traces contain session cookies.

### Smoke (`npm run smoke:local`)
| ID | Scenario | MOCK/LIVE | Result | Notes |
|---|---|---|---|---|
| S1 | App and worker start; `/healthz` reports DB ok and heartbeat < 60 s | MOCK (local stack) | PASS | HTTP 200; heartbeat age 0 s; build `src-32b211b2cd00` |
| S2a | Allowed staff account signs in (dev identity provider) | MOCK | PASS | verify → 302 `/`; dashboard 200 shows the user |
| S2b | Outside-domain account rejected | MOCK | PASS | → `/access-denied?error=ACCESS_DENIED_WRONG_DOMAIN`; no session cookie |
| S2c | Company-domain account not on allowlist rejected | MOCK | PASS | → `ACCESS_DENIED_NOT_ALLOWLISTED`; no session cookie |
| S2-live | Google OAuth sign-in (allowed and outside accounts) | LIVE | BLOCKED | No Google OAuth client; needs an interactive sign-in on a deployed environment |
| S3–S9 | Notion sync, preview, test send, send now, schedule, tracking, cancel | — | NOT RUN | Features belong to M2–M7 |

### Manual and ad-hoc checks (executed, observed)
| Check | Observed | Result |
|---|---|---|
| Developer setup following README: `setup:local`, `db:start`, `db:migrate`, `staff:add` ×2, `staff:list`, `dev:all`, `/healthz`, `GET /` | `.env.local` created with a generated secret and `SEND_MODE=disabled`; health 200 (DB 1 ms, worker heartbeat 4 s); `GET /` → 307 `/sign-in`; smoke against the dev server: 4 PASS, 1 BLOCKED, 7 NOT RUN | PASS |
| `staff:add -- bad-email admin` | Rejected: "invalid email: bad-email" | PASS |
| Worker with `SEND_MODE=live` (APP_ENV=local) | Exit 1: "SEND_MODE=live is forbidden when APP_ENV=local" | PASS |
| Worker with `DEV_LOGIN_ENABLED=true` and APP_ENV=staging | Refused: "dev sign-in can only be enabled when APP_ENV is local or test" | PASS |
| Worker with `SEND_MODE=simulator` and no authorization reference | Refused: "requires SEND_AUTHORIZATION_REF" | PASS |
| Web (`next start`) with `SEND_MODE=live` in local | First attempt: "Failed to prepare server", **but the process kept running** with no port open (finding F4). After the fix: exit code 1 | PASS after fix |
| Mutation check: allowlist gate changed to allow unknown users | `auth-gate.test.ts` failed ("rejects a company-domain account that is not on the allowlist"), proving the test detects that regression; the code was then restored | Test sensitivity confirmed |

## Failures, fixes and retests (first failures kept)
| # | Found by | Initial failure (observed) | Root cause | Fix | Retest |
|---|---|---|---|---|---|
| F1 | New E2E test 7 | The 8th sign-in in about 6 s showed `{"message":"Too many requests. Please try again later."}` on the magic-link verify URL. [initial-failure/rate-limit-error-context.md](logs/initial-failure/rate-limit-error-context.md), [screenshot](screenshots/initial-failure-rate-limit.png) | Better Auth's magic-link plugin limits verifications to 5 per 60 s when NODE_ENV=production. The limiter worked as designed; the test pace exceeded it | Raised the limit to 100 per 60 s **only on the dev/test-only magic-link plugin**. Google and other sign-in paths keep Better Auth's defaults | The original case now gets past the first sign-in; F2 then surfaced |
| F2 | The same E2E test, at re-sign-in | A revoked user who already had an account saw raw JSON `{"message":"disabled","code":"ACCESS_DENIED_DISABLED"}` instead of the access-denied page. Access *was* correctly refused. (Observed in Playwright's error context; that artifact was overwritten by a later run, so the observed text is recorded here) | The session-creation hook **threw**. Better Auth's magic-link verify does not convert a thrown session-hook error into a redirect; its Google callback does | The session hook now **returns false**, which makes both paths redirect to `/access-denied?error=failed_to_create_session`. The access-denied page explains it, and the precise reason stays in `audit_log` | E2E 7 PASS; integration test PASS |
| F3 | Review of F2 | The integration test had accepted "redirect **or** any 4xx", so it passed while users saw raw JSON | The assertion was too permissive | Now requires 302 to `/access-denied` with `error=failed_to_create_session` and an audit reason of `disabled`/`session.create` | PASS |
| F4 | Manual unsafe-config check | The web server logged a ConfigError but **did not exit**; it stayed alive with no port open, and a host would see a hung process | Next.js logs instrumentation errors but keeps the process running | `src/instrumentation.ts` exits with code 1 on a ConfigError | Exit 1 observed |
| F5 | Review of logs from run 1 | Sign-in denial log lines and audit rows had no `request_id`, a gap against the "correlation ids" deliverable | The auth hooks did not read `x-request-id` | Hooks read `x-request-id` (set by `src/proxy.ts`) into logs and `audit_log.correlation_id`; a test was added | PASS (integration), and `request_id` is visible in [logs/stack-e2e/web.log](logs/stack-e2e/web.log) |
| F6 | Review of report evidence | Screenshots named "denied" showed the sign-in page, because Playwright keeps only each test's final screen | Wrong evidence capture point | Explicit screenshots at the asserted states | Screenshots verified by viewing |

Flaky-test history: none observed. Every failure above was deterministic and reproduced on rerun before it was fixed.

## Not run, and why
| Item | Status | Reason |
|---|---|---|
| Google OAuth sign-in (real Workspace account, `hd` enforcement by Google) | BLOCKED | No OAuth client (M0) |
| Staging deployment and staging smoke | BLOCKED | No hosting account; deployment not authorized for M1 |
| CI workflow (`.github/workflows/ci.yml`) | NOT RUN | No remote repository; the workflow has never executed |
| Linux and macOS local runs | NOT RUN | Only Windows was available. The embedded-postgres install scripts for linux-x64 and darwin are allowed in `package.json` but untested |
| SES, Notion, email sending | NOT APPLICABLE (M1) | No real transport exists; the factory refuses one by design |

## Known limitations and risks
- **Rate limits:** Better Auth's rate-limit state is in memory, which is fine for one web instance; multiple instances will need database storage. A 429 page shows raw JSON, which is a UX issue for later.
- **Staff management** is CLI-only (`npm run staff:*`). The Staff page is read-only.
- **npm audit:** 11 moderate advisories, all in dev-only tooling: drizzle-kit's bundled esbuild (GHSA-67mh-4wv8-2f99, dev server only, which we don't use) and minimatch through typescript-eslint (GHSA-g3hv-75wg-m249). There are **no advisories in runtime dependencies**.
- **Harmless warning:** `[core] WARNING: Executable file detection not yet supported on 'win32'` appears at stack start (from a test-tooling dependency).
- The build ID is a content hash because nothing is committed yet. Committing the work would give a proper commit SHA; I did not commit, because no commit was requested.

## Redaction
- Text logs were passed through `src/lib/redact.ts`.
- A manual scan then found no session tokens, bearer tokens, AWS, Notion or Google keys, `BETTER_AUTH_SECRET`, local DB password, or unmasked email addresses.
- All addresses in this cycle are fixtures on reserved domains, shown masked (e.g. `a***@example.com`).
- Screenshots contain fixture addresses only.

## Release recommendation
**M1 is complete for local scope; it is not a release.** The foundation behaves as specified locally, with automated evidence. Before M1 can be called fully accepted:
1. Configure the Google OAuth client (Internal), then run S2-live.
2. Provide a staging environment, then deploy and run the staging smoke. Deployment needs separate authorization.
3. Push to a repository so the CI workflow runs once.

No real email can be sent by this build.

## Addendum: M1 Git checkpoint (2026-11-12)
Before the checkpoint commit, test-only fixture addresses at non-reserved domains (`gmail.com`, `company.com`) were changed to reserved `.example` domains in the tests, docs and CLI comments. No application code changed.
- Re-ran on the checkpoint tree: `npm run lint` (exit 0), `npm run typecheck` (exit 0), unit (39/39 passed), integration (15/15 passed).
- E2E was not re-run because no E2E input changed. The E2E evidence above is from build `src-32b211b2cd00`.

**Still unverified, and not production-validated:**
- Google OAuth sign-in: BLOCKED.
- Staging deployment over HTTPS: BLOCKED.
- CI workflow: NOT RUN.
- Live smoke S2-live: BLOCKED.
- Smoke S3–S9: NOT RUN.

M1 is a locally verified foundation only.

## Addendum: corrections found during M2 (2026-11-12)
1. **Integration exit codes were unreliable.**
   - `embedded-postgres` registers `async-exit-hook`, which calls `process.exit(0)` on `beforeExit`. That overrode Vitest's exit code, so a *failing* integration run exited 0.
   - The integration results in this report were genuinely observed passes: each test is marked ✓ in [logs/integration.log](logs/integration.log). But the "exit 0" there would not have revealed a failure.
   - Fixed in M2, with evidence in the M2 report.
2. **"No servers left running" (manual checks section) was incorrect.**
   - The developer-setup check left `db:start`, `next dev` and the worker running. They were found and stopped during M2.
   - Cause: on Windows, stopping a background task does not stop its child processes, and the port check used then did not detect them.
   - Process listings are now part of every manual check.
