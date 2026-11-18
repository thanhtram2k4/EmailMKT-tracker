# Test report — M7: open/click tracking and analytics (local, mock only)

- **Build:** branch `m7-tracking` from `m6-checkpoint` (`2827eb1`); M7 changes uncommitted at the time of the run (see §8).
- **Environment:** local, Windows 11, Node 24, PostgreSQL 17 (embedded), Chromium (Playwright 1.65). Isolated stack `scripts/local-stack.ts` (APP_ENV=test, NOTION_MODE=mock); SEND_MODE `disabled` and `mock`.
- **Executed (Asia/Ho_Chi_Minh, UTC+07:00), 2026-11-13:** full regression 18:10–18:26 (`logs/run1/`, end 18:26:18); mutation checks after it (`logs/mutation-checks.txt`).
- **Executed by:** Claude Code (AI), at the user's request. No AI/LLM API is used.
- **Authorized scope:** local, mock transport only. **No** real email, **no** AWS call, **no** deployment, **no** push, **no** live Notion.

> **Summary.** Tracking and analytics work end to end locally over real HTTP: open pixel, click redirects that only ever go to the snapshot URL, 404 for any tampering, automated activity flagged, recorded and filtered numbers side by side, per-link and per-recipient views. All PASS results are **MOCK**; S8-live is **BLOCKED**. The visual review found one presentation defect (CTOR above 100%), fixed before the final run. The confirmed role rule now has an explicit E2E test.

## 1. What M7 adds
- **Public endpoints** on `TRACKING_BASE_URL`: `/o/<token>.gif` (pixel, GET/HEAD), `/c/<token>/<n>` (302 to the snapshot's link *n*, GET/HEAD). Unknown token, index out of range, or a message sent without tracking → 404; never a redirect, and the query string is never used.
- **Send-time tracking:** decided per message from the setting `tracking.mode` — `consented_only` (default, pending counsel: needs recorded `email_tracking` consent), `all`, or `off` — and stored on the message. Links are rewritten on the frozen template with the same selection and order as the snapshot link table; mailto, merge-field and MSO-comment links stay direct; the plain-text part and test sends are never tracked.
- **Automation flags** (raw events always kept): scanner or empty user agent, HEAD request, click < 10 s after delivery (or sending), different links within 2 s (both clicks flagged). Google/Yahoo image-proxy opens are labelled `proxy_open` but not counted as automated. IPs are stored only as an HMAC; user agents truncated.
- **Metrics** (DESIGN §4.3): per message uniqueness, raw totals, rates of Delivered and of Sent, CTOR; every metric both recorded and filtered. Unique openers include **implied opens** (a click without a recorded open).
- **Views:** Analytics card on a sent campaign (headline tiles + link table follow the toggle; a comparison table always shows both), recipient timeline page (events, flags, first/latest activity). Contact `last_engagement_at` is updated by non-automated activity.
- **Settings:** tracking mode on Settings → Sending.

## 2. Commands and exit codes (final build, `logs/run1/`)
| Command | Exit | Time | Result |
|---|---|---|---|
| `npm run lint` · `npm run typecheck` | 0 · 0 | 9 s · 5 s | clean |
| `npm run test:unit` | 0 | 6 s | 201/201 (M6: 189; +12 tracking) |
| `npm run test:integration` | 0 | 136 s | 96/96 (M6: 88; +8 tracking) |
| `npm run test:tooling` | 0 | 23 s | 7/7 |
| `npm run smoke:local` (disabled) | 0 | 33 s | 11 PASS · 7 BLOCKED · 0 NOT RUN · 0 FAIL |
| `npm run e2e` (disabled) | 0 | 170 s | 50 passed, 13 skipped (mock-only) |
| `npm run e2e:mock-send` | 0 | 41 s | 4 passed, 1 skipped |
| `npm run e2e:mock-campaign` (M5 + M6 + M7) | 0 | 410 s | 12 passed, 1 skipped |
| `npm run smoke:mock-send` (mock) | 0 | 94 s | 13 PASS · 7 BLOCKED · 0 NOT RUN · 0 FAIL |

Every stack ended with "cleanup ok: … none left"; ports 3100, 4011, 54331 and 54332 free afterwards. The smoke suite has no NOT RUN rows any more: each of S1–S10 has a passing local variant or a BLOCKED live variant with a reason.

## 3. Results by scenario
| ID | Scenario | MOCK/LIVE | Result | Evidence |
|---|---|---|---|---|
| R-TRK-01 | 3 clicks on one link = 1 unique, 3 recorded | MOCK | PASS | integration; E2E over HTTP (link 0: unique 1, clicks 3) |
| R-TRK-02 | Tampered token / index → 404, no redirect | MOCK | PASS | integration (tampered token, idx 2, −1, `1e2`, `0?url=…`); E2E over HTTP (404, no Location; `?url=https://evil.example` → Location is the snapshot URL) |
| R-TRK-03 | Filtered and recorded both shown | MOCK | PASS | integration (exact counts); E2E comparison table and toggle |
| R-TRK-04 | GET unsubscribe does not unsubscribe; POST does | MOCK | PASS | M5 R-M5-08 and OR-CMP-02 (re-run in this regression); smoke S8-mock |
| R-TRK-05…10 | Tracking mode/consent, index mapping, flags, rates/CTOR, engagement/timeline, IP hashing | MOCK | PASS | integration + unit (PLAN "M7 regression additions") |
| R-PERS-04 | Test sends never tracked or counted (completes M4) | MOCK | PASS | integration |
| OR-TRK-01 | HTTP + UI scenario | MOCK | PASS | `e2e:mock-campaign`; screenshots `screenshots/campaign-mock/m7-*` |
| OR-ROLE-01 | Member cannot schedule, send or cancel (confirmed rule) | MOCK | PASS | `e2e:mock-campaign` |
| S8-mock | Open, click, one-click unsubscribe over HTTP on a worker-sent campaign | MOCK | PASS | open 200; click 302 → snapshot URL; unsubscribe 200; suppression + Notion outbox row |
| S8-live | Real inbox | LIVE | BLOCKED | Needs real sending, SES, deployed tracking domain, live Notion |
| M1–M6 regression | All earlier suites | MOCK | PASS | run 1 |

## 4. Failures, defects and fixes (first failures kept)
| # | Found by | First failure | Classification | Fix | Retest |
|---|---|---|---|---|---|
| D1 | Visual review of `m7-01-analytics-filtered.png` (first E2E pass) | CTOR **200%** in "All recorded": a scanner clicked a recipient with no recorded open, so unique clickers (2) > unique openers (1) | Product (presentation) defect: misleading metric | Unique openers include implied opens (click without a recorded open); "Opens (recorded)" stays raw; explained on the page; DESIGN delta updated | Integration asserts recorded openers 4 and CTOR 100%; E2E asserts CTOR 100.0% / 100.0%; mutation MT4 proves the test catches a regression |
| T1 | First tracking integration run | Timeline order: unsubscribe listed before the clicks | Test defect: the unsubscribe used the real clock while the clicks used simulated times minutes ahead | Unsubscribe given the same controlled clock | 8/8 |
| T2 | First tracking E2E (`logs/first-failure-e2e-tracking.log`) | `invalid input syntax for type uuid: "campaigns"` | Test defect: campaign id read from the URL before navigation to the new draft finished | Wait for the draft status first (as the other specs do) | 3/3, then 12/12 in run 1 |

## 5. Mutation checks (`logs/mutation-checks.txt`; control run first, Git Bash)
| Mutation | Test | Result |
|---|---|---|
| MT1 untracked tokens accepted | consented_only test | CAUGHT |
| MT2 unknown link index still redirects | R-TRK-02 | CAUGHT |
| MT3 earlier click of a burst not flagged | R-TRK-03 | CAUGHT |
| MT4 no implied opens | R-TRK-03 | CAUGHT |

## 6. Not proven / not done
- Nothing LIVE: real mail clients loading the pixel, real scanners, Gmail proxy caching and Apple MPP behaviour.
- Scanner **IP** lists and Apple MPP detection are not implemented (no reliable signal without provider IP ranges); detection is user-agent and timing based.
- Tracking consent: the default `consented_only` follows the cautious consent policy; counsel's answer (COMPLIANCE §3.3, question 2) is pending.
- Public-endpoint abuse limits (rate limiting `/o`, `/c`, `/u`) are planned for M8 hardening.
- Campaign detail and timeline pages were not checked at phone widths (only the sidebar pages are in R-UI-03).

## 7. Redaction
Synthetic data on reserved domains only; IPs stored as HMAC; evidence scanned for keys, tokens and session cookies: none.

## 8. Recommendation
- **M7 is ready for your review as a local, mock-verified milestone.**
- Not committed yet: say the word and I commit it locally with tag `m7-checkpoint` (no push).
- Next: M8 (Notion summaries, hardening, release) needs your authorization; its live campaign step needs the M0 setup and separate approval.

## Addendum (2026-11-13)
- Committed locally on `m7-tracking`, tag `m7-checkpoint`. No push.
