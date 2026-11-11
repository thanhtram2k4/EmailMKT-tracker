# Test reports

This folder holds only evidence from tests that were actually run. There is one folder per test cycle:

```
reports/<YYYY-MM-DD>-<cycle>/
  report.md
  logs/     # redacted, filtered by correlation id
  traces/   # Playwright traces and screenshots
```

Reports are prepared for the user to review and share. **They are never sent automatically.**

## report.md template

```markdown
# Test report — <cycle name>
- Build / commit:
- Environment: (local | staging | production) · SEND_MODE:
- Executed: <start>–<end> (timezone: Asia/Ho_Chi_Minh, UTC+07:00)
- Executed by:

## Commands
| Command | Exit code | Duration |
|---|---|---|

## Results
| ID | Scenario | MOCK/LIVE | Result (PASS/FAIL/BLOCKED/NOT RUN) | Notes |
|---|---|---|---|---|

## Failures
### <ID>
- Expected (source: brief §/DESIGN §):
- Actual:
- Reproduction steps:
- Logs / trace: logs/<file>, traces/<file>

## Scheduling evidence (if applicable)
| Campaign ID | Revision / Job ID | Timezone | Scheduled (local / UTC) | Actual start (UTC) | Delay | State transitions | Errors (redacted) |
|---|---|---|---|---|---|---|---|

## Fixes and retests
| Defect | Fix commit | Original case retest | Regressions rerun | Result |
|---|---|---|---|---|

## Flaky-test history
(Keep the first failure of every test, even if a later run passed.)

## Blockers and untested areas

## Release recommendation
```

## Redaction (required before sharing)
- Remove OAuth tokens, cookies, session ids, AWS keys and Notion tokens.
- Mask contact emails as `n***@domain.com`, and remove names and other personal data.
- Before sharing, search the folder for `token`, `secret`, `Authorization`, `@` and `AKIA`.
