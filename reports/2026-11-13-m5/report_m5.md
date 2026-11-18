# Test report — M5: send-now engine and compliance (local, mock only)

- **Build / commit:** branch `m5-send-engine`, from `m4-checkpoint` (`6faab6c`). The M5 changes are uncommitted in the working tree at the time of these runs (see §9).
- **Environment:** local, Windows 11, Node 24, PostgreSQL 17 (embedded), Chromium (Playwright 1.65). Isolated stack `scripts/local-stack.ts` (APP_ENV=test, NOTION_MODE=mock).
  - **SEND_MODE:** `disabled` (`e2e`, `smoke:local`) and `mock` (`e2e:mock-send`, `e2e:mock-campaign`, `smoke:mock-send`). Integration tests also use a **fake SES client** (the real SES transport code with an in-memory client; no network).
  - SES events: signed with a **throwaway RSA key generated per stack run**, standing in for the AWS SNS certificate (`SNS_TEST_PUBLIC_KEY_FILE`, refused outside local/test).
- **Executed (Asia/Ho_Chi_Minh, UTC+07:00), 2026-11-13:** run 1 16:13–16:21; run 2 (full, final source) 16:24–16:32; mutation checks 16:33–16:39 (attempt 1 invalid at 16:33, valid run 16:34–16:39); run 3 (final build after a CSS-only fix: stack suites and re-smoke) 16:39–16:44.
- **Executed by:** Claude Code (AI), at the user's request.
- **Authorized scope:** local work with a mock transport / fake SES only. **No** real email, **no** AWS call, **no** deployment, **no** push, **no** live Notion.

> **Summary.** Every PASS below is **MOCK**. No email was sent through SES and no AWS endpoint was contacted. The live checks (S6-live, a real 500-recipient simulator run, real SNS delivery) are **BLOCKED** until you authorize real sends, set up SES and a deployment. Run 1 found 2 defects introduced by M5 (one UI, one test-isolation); both were reproduced, fixed and retested. One pre-existing M4 defect was found and fixed (§5.3).

## 1. Process
1. Read DESIGN §3.4/§4.1/§4.3, COMPLIANCE, and the existing send/guard/test-send code. Recorded the authorization in the PLAN decisions log.
2. Implemented schema + DB guards, engine, events, unsubscribe, UI. Wrote integration tests against real PostgreSQL first, then unit, E2E and smoke additions.
3. Full regression (run 1) → 2 failures → reproduced, fixed → full regression again (run 2: all pass).
4. Mutation checks (§6): proved the key tests catch real defects. The first attempt was invalid and is kept as evidence.
5. Visual review of screenshots → one cosmetic CSS fix → run 3 on the final build (stack suites + re-smoke).
6. The operation-reproduction scenarios (OR-CMP-01…03) were written **during** implementation, not before it (deviation from the usual order; noted in PLAN).

## 2. Commands and exit codes

**Run 2 — full regression on the final source (logs: `logs/run2-final/`)**

| Command | Exit | Time | Result |
|---|---|---|---|
| `npm run lint` | 0 | 10 s | clean |
| `npm run typecheck` | 0 | 5 s | clean |
| `npm run test:unit` | 0 | 5 s | 175/175 (M4: 163) |
| `npm run test:integration` | 0 | 91 s | 75/75 (M4: 52; +22 campaign engine, +1 real-process worker kill) |
| `npm run test:tooling` | 0 | 21 s | 7/7 |
| `npm run smoke:local` (SEND_MODE=disabled) | 0 | 35 s | 10 PASS · 4 BLOCKED · 3 NOT RUN · 0 FAIL |
| `npm run e2e` (SEND_MODE=disabled) | 0 | 164 s | 48 passed, 7 skipped (mock-only tests) |
| `npm run e2e:mock-send` (M4 test sends) | 0 | 41 s | 4 passed, 1 skipped |
| `npm run e2e:mock-campaign` (new) | 0 | 42 s | 4 passed, 1 skipped (disabled-only test) |
| `npm run smoke:mock-send` (SEND_MODE=mock) | 0 | 33 s | 10 PASS · 4 BLOCKED · 3 NOT RUN · 0 FAIL |

**Run 3 — final build after the CSS-only fix in §5.4 (16:39–16:44; logs: `logs/run3-final-build/`).** Unit/integration/tooling were not rerun: the change was one CSS selector, which only the stack suites exercise.

| Command | Exit | Time | Result |
|---|---|---|---|
| `npm run lint` · `npm run typecheck` | 0 · 0 | 10 s · 5 s | clean |
| `npm run smoke:local` (re-smoke, disabled) | 0 | 32 s | 10 PASS · 4 BLOCKED · 3 NOT RUN · 0 FAIL |
| `npm run e2e` (disabled) | 0 | 158 s | 48 passed, 7 skipped |
| `npm run e2e:mock-campaign` | 0 | 42 s | 4 passed, 1 skipped |
| `npm run smoke:mock-send` (re-smoke, mock) | 0 | 33 s | 10 PASS · 4 BLOCKED · 3 NOT RUN · 0 FAIL |

Every stack run ended with "cleanup ok: … owned process(es) stopped, none left".

## 3. Results by scenario

| ID | Scenario | MOCK/LIVE | Result | Evidence / notes |
|---|---|---|---|---|
| R-SEND-01 | 500 recipients: each sent exactly once, campaign completes | MOCK | PASS | 500 provider calls, 500 distinct ids; transitions draft→queued→sending→completed; a second run sends nothing |
| R-SEND-01 (simulator) | Same against the SES mailbox simulator | LIVE | BLOCKED | Real sends not authorized |
| R-SEND-02 | Four concurrent dispatchers (200 recipients) | MOCK | PASS | Lock contention observed; 200 calls, 0 duplicates. Mutation M3b: without the lock, 240–290 calls → caught |
| R-SEND-03 | Worker killed mid-batch | MOCK | PASS | (a) in-process: stale claims → `unknown`, never re-sent, DB refuses `unknown→pending`; (b) **real processes**: worker hard-killed during 300 ms mock sends, reaper (controlled clock +11 min) → `unknown`, a second worker process completes via the maintenance cron; cross-process call log shows no message twice |
| R-SEND-04 | Timeout → `unknown`, not retried; a later event reconciles to `sent` | MOCK (fake SES client) | PASS | Real `SesTransport` abort path; re-dispatch sends nothing; Delivery event → `sent` + `delivered`, audited; duplicate SNS id ignored |
| R-SEND-05 | Throttling backs off and recovers | MOCK | PASS | 3 throttles then accepted; 4 calls for that message, 6 sent, 0 unknown |
| R-SEND-06 | Exhausted quota (with 10% reserve) → `blocked`; resume after renewal completes | MOCK | PASS | Budget = 100·0.9 − 85 = 5 sends, then `blocked: quota`; resume while exhausted → blocked again with 0 sends; after renewal → completed, 12 calls, 0 duplicates. Rate asked of the limiter = min(5/s setting, 80% of 14/s) = 5 |
| R-SEND-07 | Invalid credentials → `blocked` | MOCK (fake SES client) | PASS | GetAccount `CredentialsProviderError` and SendEmail `UnrecognizedClientException` (403) both → `blocked: credentials`; messages stay `pending` (not failed, not sent) |
| R-SEND-08 | Unsubscribed / consent withdrawn while queued → skipped | MOCK | PASS | `skipped` with `suppressed` / `consent_withdrawn`; only the 2 others sent |
| R-SEND-09 | Hard bounce and complaint suppress; soft bounce does not | MOCK (synthetic SES payloads) | PASS | Suppressions `hard_bounce`/`complaint`; consent withdrawn on complaint; Notion outbox `Bounced`/`Complained`; diagnostic redacted; completed → completed_with_issues; Delivery never downgrades a complaint |
| R-SEND-10 | Pause / resume / cancel | MOCK | PASS | Pause after 10 sends: in-flight call finishes, 15 claims released (not lost); cancel after 5 more: 15 sent / 15 cancelled, reason "cancelled: 15 sent, 0 uncertain, 15 not sent" |
| R-M5-01…12 | Review blocking, exclusions, revision fence, snapshot freeze/immutability, uncertain resolution, unsubscribe, SNS verification, DB guards, settings | MOCK | PASS | `tests/integration/campaign-send.test.ts` (definitions in PLAN "M5 regression additions") |
| R-M5-13 | Send maintenance registered with NOTION_MODE=disabled (M4 defect regression) | MOCK | PASS | unit `crontabFor` |
| OR-CMP-01 | UI: create → review (3 in / 2 out with reasons) → Send now → completed | MOCK | PASS | `e2e:mock-campaign`; mock call log: exactly one call per message. Screenshots `screenshots/campaign-mock/01-…02-…` |
| OR-CMP-02 | Unsubscribe: GET confirms only; button and one-click POST suppress | MOCK | PASS | GET left the DB unchanged; button → suppressed; one-click → `200 unsubscribed`, consent `withdrawn/unsubscribe_link`; unknown token → 404; Suppressions screen lists both |
| OR-CMP-03 | Signed SES Delivery event over HTTP; tampered copy refused | MOCK | PASS | `200 processed` → Delivered 1 on the campaign page; tampered signature → 403 |
| Member view | A member can create/review but not send | MOCK | PASS | No Send button; server action requires admin |
| Disabled mode | Review blocks; Send off | MOCK | PASS | `e2e` (disabled stack) |
| S6-mock | Worker process sends to 3; signed events → Sent 3 / Delivered 2 / Bounced 1; bounced address suppressed | MOCK | PASS | Dispatched in ≈0.5 s by the stack's worker; 3 × `200 processed` |
| S6-disabled | Approval refused with SEND_MODE=disabled; no message created | MOCK | PASS | smoke:local |
| S6-live | 3 SES simulator addresses, real events | LIVE | BLOCKED | No authorization, SES setup or deployed endpoint |
| S10 | All 10 sidebar pages (incl. Campaigns, Suppressions) render | MOCK | PASS | |
| Earlier milestones | M1–M4 regression (auth, CRM, paste workflow, editor trial, test sends, UI shell incl. axe on the 2 new pages) | MOCK | PASS | All existing tests unchanged except the documented M4 factory expectation (§5.3) |
| Frequency cap, `[QC]` enforcement, refusal-confirmation email | Compliance proposals | — | NOT DONE | Pending counsel (COMPLIANCE §6); `[QC]` is a review warning only |
| Gmail/Outlook/mobile rendering of campaign mail | — | — | NOT RUN | No real sending |

## 4. Smoke tables (runs 2 and 3)
`logs/run2-final/smoke-results-*.md` and `logs/run3-final-build/smoke-results-*.md` (identical outcomes). No FAIL. BLOCKED: S2-live, S3-live, S5-live, S6-live (each with a stated reason). NOT RUN: S7, S8, S9 (M6/M7 features).

## 5. Failures, defects and fixes

### 5.1 R-UI-03 (no horizontal scroll) — FAIL in run 1, introduced by M5
- **Expected** (PLAN M4 R-UI-03): no page wider than the viewport at 375/768/1024/1440 px.
- **Actual (run 1):** `/campaigns` +47 px at 375 px; `/settings/sending` +147 px at 375 px and +9 px at 768/1024 px (`logs/run1/e2e-disabled.log`).
- **Reproduction:** a temporary probe spec (deleted afterwards) on a stack with data: `/campaigns` over=47 only once emails/tags exist (empty stack: 0). A second probe listed elements whose content exceeds their box: every `label.check` (radio/checkbox labels) by ≈80 px.
- **Cause:** `.stack input { width: 100% }` appears later in `globals.css` than the checkbox/radio width rule with equal specificity, so checkboxes inside `.stack` forms stretched and pushed their text off-screen.
- **Fix:** `label.check input { width: 16px; max-width: 16px }` (higher specificity) and wrapping for `label.check`. **Retest:** run 2 `e2e` R-UI-03 at all widths PASS; R-UI-04 (axe) PASS.

### 5.2 crm.spec "4 suppressed" — FAIL in run 1, test interference from the new spec
- **Actual:** "5 suppressed addresses". `campaign-send.spec` runs first in the shared default stack and its seed inserted a suppression.
- **Fix:** in the disabled stack the spec excludes that contact by withdrawn consent instead (asserted: "Consent withdrawn"); the suppression case stays in the mock-only stack. **Retest:** run 2 `e2e` crm.spec PASS; `e2e:mock-campaign` still asserts the suppressed exclusion.

### 5.3 Pre-existing M4 defect: test-send reaper only scheduled when Notion is enabled
- **Found by reading** `src/worker/runner.ts`: all cron schedules, including `test_send_reaper`, were registered only when `NOTION_MODE` ≠ `disabled`, so with Notion off stale test-send claims never became `unknown`.
- **Fix:** `crontabFor({crm, sending})`; the worker process always registers send maintenance (test-send reaper + `campaign_maintenance`). Regression test R-M5-13; mutation M4 proves it fails if the coupling returns.
- **Changed M4 test (deliberate):** `sending-guard.test.ts` "still refuses customer campaigns in M4" → replaced by "builds SES for a customer campaign only in production + live + admin toggle", which also asserts refusal for local/test/staging × simulator/allowlist.

### 5.4 Visual review
- The first review screenshot showed stacked, centred checkbox labels (same cause as 5.1) — fixed with 5.1.
- The exclusion list had no spacing (`ul.plain` overrode the class) — cosmetic fix after run 2; covered by run 3.

### 5.5 Integration-test first run (development, before run 1)
- 5 of 22 new tests failed on first execution: 3 expected the trigger message at the top level (drizzle wraps it in `cause`), 1 compared SES calls in a fixed order (claim order is by random UUID — the test was order-dependent and passed on a second run, confirming the cause), 1 resend test mixed clocks (resend scheduled at the controlled time, dispatcher on the real clock). All were test defects; fixed in the tests. No product code changed for them.

## 6. Mutation checks (`logs/mutation-checks.txt`)
Each check: control run (unmutated, must PASS) → apply one defect → run the targeted test → revert.

| Mutation | Targeted test | Result |
|---|---|---|
| M1 send-time suppression check removed | R-SEND-08 | CAUGHT |
| M2 SNS signature result ignored | R-M5-09 | CAUGHT |
| M3 advisory lock + `SKIP LOCKED` removed | R-SEND-02 | CAUGHT (by the lock-contention assertion) |
| M3b same, with that assertion temporarily removed | R-SEND-02 | CAUGHT 3/3: 240, 250, 290 provider calls for 200 messages |
| M4 send maintenance tied to CRM schedules | R-M5-13 | CAUGHT |
| M5 uncertain outcome mapped back to `pending` (auto-retry) | R-SEND-04 | CAUGHT |

**First attempt invalid** (`logs/mutation-checks-attempt1-INVALID.txt`): it reported all "CAUGHT", but the test files never ran ("no tests") because vitest was launched from Python via `cmd.exe` with a lower-case drive letter. A control run showed the unmutated test failing the same way, so those results were discarded and the checks re-run from Git Bash with controls.

## 7. What is not proven (and why)
- **Nothing LIVE.** SES acceptance, real SNS delivery (including the AWS certificate download path `httpsCertResolver`), real bounce/complaint payload shapes and rate behaviour are verified only against fakes built from the AWS documentation.
- **Custom Message-ID** is not set; reconciliation relies on SES message tags (`msg_id`, `attempt`). Whether SES keeps a custom Message-ID must be checked before relying on it.
- **SNS subscription confirmation** is recorded, never confirmed automatically: a manual step after deployment.
- **Rate limiting is per worker process**; one worker is planned. Two worker processes would each pace separately.
- **Compliance gate** (COMPLIANCE.md) is not cleared; live customer campaigns stay disabled by guard + admin switch + production-only rule.
- Firefox/Safari not tested; email-client rendering not tested.

## 8. Redaction
Fixture addresses only (`example.com/org/net`). Audit rows for unsubscribes and test sends store masked addresses; stored bounce diagnostics are passed through `redactText` (asserted). The SNS test key pair lives in `.local/logs/…` (git-ignored, regenerated per run) and is not in this folder. Manual check of this folder: no tokens, cookies or keys.

## 9. Release recommendation and next steps
- **M5 is ready for your review as a local, mock-verified milestone.** It is not ready for any real campaign.
- Needed before LIVE checks (each needs your explicit approval): SES identity and credentials (M0), `SEND_AUTHORIZATION_REF` for simulator sends, a deployment with HTTPS for `/api/ses-events`, and the compliance gate before any customer campaign.
- Suggested: commit this cycle on `m5-send-engine` and tag `m5-checkpoint` (local only, no push) — not done without your instruction.

## Addendum (2026-11-13)
- Committed together with M6 in one commit; tags `m5-checkpoint` and `m6-checkpoint` point to the same commit (no separate M5-only snapshot was kept, because M6 was built on the uncommitted M5 tree). No push.
- The roles proposed here were **confirmed by the user**: only admins approve, schedule, send and resolve uncertain sends; members create, edit, review and pause.
