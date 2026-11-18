# Test report — M6: scheduling (local, mock only), with a cross-review of M1–M5

- **Build:** branch `m6-scheduling`, on top of the **uncommitted** M5 working tree (base `m4-checkpoint`, `6faab6c`). Nothing was committed.
- **Environment:** local, Windows 11, Node 24, PostgreSQL 17 (embedded), Chromium (Playwright 1.65). Isolated stack `scripts/local-stack.ts` (APP_ENV=test, NOTION_MODE=mock); SEND_MODE `disabled` and `mock`.
- **Executed (Asia/Ho_Chi_Minh, UTC+07:00), 2026-11-13:** full regression 17:35–17:50 (`logs/run1/`); mutation checks after it (`logs/mutation-checks.txt`).
- **Executed by:** Claude Code (AI), at the user's request. No AI/LLM API is used by the app or by these tests (user instruction: no Claude API; Gemini only if ever needed).
- **Authorized scope:** local work, mock transport only. **No** real email, **no** AWS call, **no** deployment, **no** push, **no** live Notion.

> **Summary.** Scheduling works end to end locally: a campaign scheduled in Asia/Ho_Chi_Minh was started by the background worker 26 ms (E2E) and 37 ms (smoke) after its target **with the browser closed**, and completed. Every PASS is **MOCK**. The live check (S7-live on a deployed environment, laptop off) is **BLOCKED**. One test defect was found and fixed in this cycle; no product defect.

## 0. Cross-review of the M1–M5 reports against PLAN.md

### 0.1 Items still open (by milestone)
| Milestone | Open item | Status | What unblocks it |
|---|---|---|---|
| M0 | Google OAuth client (Internal), staff list, AWS/SES setup (identity + DKIM, MAIL FROM, configuration set → SNS, account suppression, production access, least-privilege IAM), S3 bucket, DNS (SPF/DKIM/DMARC), Notion integration + separate test database, Render account, test inboxes | NOT DONE (your tasks) | You (see §0.2) |
| M1 | Staging deploy over HTTPS; S2-live (Google sign-in); first CI run | BLOCKED | Render account + deployment approval; OAuth client; a Git remote + push approval |
| M2 | S3-live (sync against the Notion test database); UI toggle for `crm.require_marketing_consent` (DB only today); accent-insensitive search; disclosed-frequency field; data-subject lookup tool | BLOCKED / NOT DONE | Notion token + `NOTION_AUTHORIZATION_REF`; counsel for the consent items |
| M3 | Gmail/Outlook/mobile rendering; image re-hosting to S3; editor choice still PROVISIONAL | NOT RUN / NOT DONE | Approved test sends (or Litmus); S3 bucket |
| M4 | S5-live (one real test send); preheader unused; Firefox/Safari untested | BLOCKED / NOT DONE | SES setup + `SEND_AUTHORIZATION_REF` + your approval |
| M5 | S6-live; frequency cap; enforced `[QC]` label; refusal-confirmation email; custom Message-ID behaviour unverified; SNS subscription to be confirmed manually after deployment; **M5 not committed**; "only admins approve/send" is a proposal awaiting your confirmation | BLOCKED / NOT DONE / DECISION | SES + deployment; counsel; your go-ahead to commit |
| Open items | Assumptions A1–A7; Wix screenshots/recording; legal counsel's 8 questions; sending and tracking subdomains | NOT DONE | You |

### 0.2 Keys, accounts and configuration you will need (none needed for M6)
| What | Variable / place | Notes |
|---|---|---|
| Google sign-in | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` in `.env.local` / host secrets; `ALLOWED_EMAIL_DOMAINS` | OAuth consent screen **Internal**, scopes `openid email profile` only |
| App secrets | `BETTER_AUTH_SECRET`, `APP_ENCRYPTION_KEY` | Generated (`npm run setup:local` locally); separate values per environment |
| Amazon SES | AWS credentials of an IAM principal limited to `ses:SendEmail` (+ `ses:GetAccount`): **AWS profile** locally (`AWS_PROFILE`), never in `.env` or Git; `SES_FROM_ADDRESS`, `SES_CONFIGURATION_SET`, `SES_EVENTS_TOPIC_ARN` | For real test/simulator sends also `SEND_MODE=simulator|allowlist`, `SEND_AUTHORIZATION_REF`, `TEST_RECIPIENT_ALLOWLIST` |
| Notion | The integration token is entered in the app (**Settings → Notion**) and stored encrypted — never an env var; plus `NOTION_MODE=live`, `NOTION_AUTHORIZATION_REF` | Use a separate test database first (`docs/NOTION_SETUP.md`) |
| Hosting | `DATABASE_URL`, `APP_BASE_URL` (https), `TRACKING_BASE_URL` | Render (Singapore) |
| Not needed | Gemini/Claude or any AI key; Wix API; Gmail API (Phase 2 only) | The app has no AI feature; Wix is only a UX reference |

**Conflict to decide before deployment:** CLAUDE.md says AWS credentials come only from an AWS profile outside the repository. A hosted worker has no profile, so the host's secret store (environment variables managed by Render, or a role) will be needed. This needs your decision when deployment is authorized.

### 0.3 Inconsistencies found and corrected
- PLAN M0 acceptance still required "both templates are received" although that requirement was withdrawn in M3 rev 2 → corrected.
- The M5 report gave the mutation-check time as 16:34–16:45, overlapping run 3; the log files show 16:33–16:39 → corrected.
- Historical statements that are no longer true are kept in their reports as written and superseded later: "the transport factory refuses customer campaigns" (M1/M4; changed in M5 §5.3), "Planned: Luxon" (now used).

## 1. What M6 adds
- **Statuses** `scheduled` and `held_overdue`; schedule columns (UTC time, IANA zone, local time as entered, offset, scheduled by, hold reason, measured start delay); `admin_alerts`.
- **Time rules** (`schedule-time.ts`, Luxon): past / < 2 min refused; nonexistent DST time refused with the next valid time suggested; ambiguous DST time requires choosing the offset.
- **Schedule** = the same immutable snapshot freeze as Send now, then a `start_campaign` job (`start:<id>`, replace mode, revision in payload). Admin only.
- **Fenced start** (`startScheduled`): row lock, then `scheduled → queued` only if still scheduled, same revision and due; the job and the every-minute sweeper share it.
- **Grace period** (default 30 min, Settings → Sending): late within it → start with the delay logged; beyond it → `held_overdue`, nothing sent, admin alert; admin chooses send now / reschedule / cancel.
- **Reschedule** (revision++), **cancel** (job removed, messages cancelled), **Unschedule and edit** (draft, revision++, snapshot cleared — the only snapshot change the DB trigger allows; message counts follow the current snapshot only).
- **Screens:** schedule card + confirmation summary on the campaign page, schedule status card, **Scheduled** list (local + UTC, revision, next action, actual start/delay) with a worker-down banner, dashboard alerts and upcoming campaigns.
- **Alerts** for held and blocked campaigns: in-app until acknowledged; emailed to active admins only through the sending guard (not sent in `disabled`; mock in `mock`).

## 2. Commands and exit codes (final build, `logs/run1/`)
| Command | Exit | Time | Result |
|---|---|---|---|
| `npm run lint` · `npm run typecheck` | 0 · 0 | 7 s · 4 s | clean |
| `npm run test:unit` | 0 | 5 s | 189/189 (M5: 175; +14 schedule time) |
| `npm run test:integration` | 0 | 98 s | 88/88 (M5: 75; +13 scheduling, incl. real worker restart) |
| `npm run test:tooling` | 0 | 21 s | 7/7 |
| `npm run smoke:local` (disabled) | 0 | 36 s | 11 PASS · 6 BLOCKED · 1 NOT RUN · 0 FAIL |
| `npm run e2e` (disabled) | 0 | 165 s | 49 passed, 11 skipped (mock-only) |
| `npm run e2e:mock-send` | 0 | 42 s | 4 passed, 1 skipped |
| `npm run e2e:mock-campaign` (M5 + M6) | 0 | 393 s | 9 passed, 1 skipped (includes a real ~4-minute scheduled wait) |
| `npm run smoke:mock-send` (mock) | 0 | 118 s | 12 PASS · 6 BLOCKED · 1 NOT RUN · 0 FAIL |

Every stack ended with "cleanup ok: … none left".

## 3. Results by scenario
| ID | Scenario | MOCK/LIVE | Result | Evidence |
|---|---|---|---|---|
| R-SCH-01 | Ho Chi Minh local → UTC → display | MOCK | PASS | unit: 09:00 → 02:00 UTC; midnight crossing |
| R-SCH-02 | Non-default zones | MOCK | PASS | unit: London (summer/winter), Kolkata (+05:30), New York |
| R-SCH-03 | DST gap rejected; overlap requires an offset | MOCK | PASS | unit + integration + E2E (UI suggestion and offset choice) |
| R-SCH-04 | Past / < 2 min rejected | MOCK | PASS | unit + integration (nothing frozen) + E2E |
| R-SCH-05 | No early dispatch at T−1 s | MOCK | PASS | integration (controlled clock); E2E polled `scheduled` until the target |
| R-SCH-06 | Starts within 60 s after T | MOCK | PASS | integration (real worker); E2E 26 ms; smoke 37 ms |
| R-SCH-07 | Reschedule: old job stale; one job | MOCK | PASS | integration (`_private_jobs` payload revision 1, run_at moved); E2E revision 0 → 1 |
| R-SCH-08 | Cancel before T → never dispatched | MOCK | PASS | integration; E2E; smoke S9-mock |
| R-SCH-09 | Cancel at dispatch → one consistent outcome | MOCK | PASS | integration: start/cancel race; mid-send cancel → "5 sent, 0 uncertain, 25 not sent" |
| R-SCH-10 | Edit after scheduling → draft, new snapshot | MOCK | PASS | integration (2 snapshots, counts only the new one, DB guard); E2E banner |
| R-SCH-11 | Notion edit after approval → frozen value | MOCK | PASS | integration |
| R-SCH-12 | Unsubscribe before T → excluded | MOCK | PASS | integration (`skipped`) |
| R-SCH-13 | Duplicate triggers + sweeper → started once | MOCK | PASS | integration: 8 concurrent triggers, 1 start, 1 transition |
| R-SCH-14 | Worker restart while scheduled → executes; while sending → nothing twice | MOCK | PASS | integration (real worker stop/start before T); "while sending" = M5 R-SEND-03 (real process kill) |
| R-SCH-15 | Within grace → late start logged; beyond → held, not sent | MOCK | PASS | integration (600 s delay logged; 31 min → held, alert, admin send-now / reschedule / cancel); E2E OR-SCH-04 (worker sweeper after a simulated outage) |
| R-SCH-16 | Execution-time credentials/quota → blocked; recovery repeats no uncertain send | MOCK (fake SES client) | PASS | integration |
| OR-SCH-01…04 | UI scenarios (PLAN M6) | MOCK | PASS | `e2e:mock-campaign`; screenshots `screenshots/campaign-mock/m6-*` |
| S7-mock / S9-mock | Smoke | MOCK | PASS | `logs/run1/smoke-results-mock.md` |
| S7-disabled | Scheduling refused when sending is disabled | MOCK | PASS | `logs/run1/smoke-results-disabled.md` |
| S7-live / S9-live | Deployed environment, laptop off | LIVE | BLOCKED | No hosting; deployment not authorized |
| M1–M5 regression | All earlier suites incl. UI shell + axe on the new Scheduled page | MOCK | PASS | run 1 |

## 4. Failures and fixes (first failures kept)
| # | Found by | First failure | Classification | Fix | Retest |
|---|---|---|---|---|---|
| T1 | First integration run (development) | 4 tests "waiting" instead of completing | Test defect: approval ran on a controlled clock ~5 min ahead of real time, so messages were "due" in the future while the dispatcher used the real clock (in production both clocks are the same) | The dispatcher in those tests uses a controlled clock too | 13/13 |
| T2 | Same | R-SCH-07: column `payload` missing | Test defect: Graphile's `jobs` view has no payload | Read `_private_jobs` (test only) | PASS |
| T3 | First `e2e:mock-campaign` (`logs/first-failure-e2e-mock-campaign.log`) | Sign-in field not found when switching to the member | Test defect: signed in already, `/sign-in` redirects away; in serial mode the remaining scheduling tests were skipped | Clear cookies before signing in | 5/5, then 9/9 in run 1 |
| — | Lint | `react-hooks/purity`: `Date.now()` in a component | Lint rule | Moved into a helper | clean |

No product defect was found in this cycle. No flaky test observed.

## 5. Mutation checks (`logs/mutation-checks.txt`; control run first, Git Bash)
| Mutation | Test | Result |
|---|---|---|
| MS1 revision fence removed (stale job accepted) | R-SCH-07 | CAUGHT |
| MS2 early-start check removed | R-SCH-05 | CAUGHT |
| MS3 grace-period hold removed | R-SCH-15 | CAUGHT |

## 6. Not proven
- Nothing LIVE: a deployed worker starting on time with the laptop off (S7-live), real SES sends, real alert emails.
- Schedules use whole minutes. Zones come from the runtime's IANA database (Node 24/ICU); a DST rule change requires a runtime update.
- The worker-down banner relies on the heartbeat; a worker that heartbeats but cannot run jobs is not detected.
- Firefox/Safari not tested.

## 7. Redaction
Synthetic data on reserved domains only. Evidence scanned for keys, tokens and session cookies: none. Audit rows store masked addresses.

## 8. Recommendation and next steps
- **M6 is ready for your review as a local, mock-verified milestone.** Not ready for real campaigns.
- Decide: commit M5 and M6 (local tags `m5-checkpoint`, `m6-checkpoint`, no push)? Confirm the admin-only rule for approving, scheduling and sending?
- Next milestone: M7 (tracking and analytics) — needs your authorization. The live checks of M1–M6 need the M0 setup in §0.2.

## Addendum (2026-11-13)
- Committed locally with M5 (tags `m5-checkpoint` and `m6-checkpoint`, same commit). No push.
- Roles confirmed by the user (admin-only approve/schedule/send/resolve).
