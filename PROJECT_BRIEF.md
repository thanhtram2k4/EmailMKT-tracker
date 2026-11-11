# Email Marketing Tool — Project Brief

Brief revision: 2 — Includes one-time campaign scheduling in the MVP.

## Current task: planning only

Create an implementation plan for an internal email marketing web application for a single company. Respond to the user in Vietnamese.

For now, research and propose a plan only. Wait for explicit approval before implementing application code, installing dependencies, deploying anything, modifying live CRM data, or sending emails. Use the plan file supported by Plan Mode; do not assume approval to create arbitrary project files during planning.

Use this document as the requirements baseline. Flag contradictions and important unknowns instead of silently changing requirements. Distinguish confirmed requirements from proposed technical decisions and assumptions.

## Reference and scope

Use Wix Email Marketing as a reference for the user experience and campaign workflow. Evaluate https://github.com/morluto/rea to determine whether it helps with researching the reference application. Do not assume REA should be the foundation of the application. Explain its actual role and limitations.

Do not claim to have inspected Wix screens that are unavailable. Identify any screenshots, recordings, or authorized access needed to understand the reference workflow.

Proposed initial scope: one company, one sending account, and one Notion workspace. These are planning assumptions to confirm. Include one-time campaign scheduling in the MVP. Keep recurring campaigns, per-recipient local-time delivery, multi-company SaaS features, advanced automation sequences, and A/B testing outside the initial MVP.

Prioritize one complete working flow:

Select contacts → personalize email → preview and send a test → review → send now OR schedule for later → process the sending queue → view analytics → synchronize summaries to Notion.

## Product requirements

### 1. Company Gmail connection

- Connect a company Gmail account through official Google OAuth and send through the Gmail API.
- Distinguish signing into the application from granting permission to send email.
- Use the supported Google authorization flow, rather than embedding the Google login form in a custom iframe.
- Handle token expiration, revoked access, administrator restrictions, and sending limits.
- Store credentials securely on the server and support disconnecting the account.
- Identify the Google Cloud and Workspace setup the user or administrator must complete.

### 2. Notion CRM integration

- Connect one Notion workspace.
- Support creating a CRM database or mapping an existing database.
- Contact fields: full name, greeting name, email, company, tags, subscription status, last emailed, and last engagement.
- Use a separate greeting-name field so the user can control how Vietnamese names appear in greetings.
- Define field mapping, stable contact identity, duplicate handling, and synchronization behavior.
- Use current official Notion API documentation and make API-version assumptions explicit.

### 3. Application database and synchronization

- Use a separate application database for campaigns, recipients, messages, links, tracking events, suppression records, and background jobs.
- Use Notion to manage contact information; synchronize summarized campaign results back to Notion.
- Define which system owns each field.
- Respect API rate limits and handle temporary synchronization failures.
- Prevent duplicate contacts on repeated syncs.
- Never automatically resubscribe an unsubscribed contact through synchronization.

### 4. Email editor and templates

- Support pasting formatted text and importing HTML email templates for editing.
- Allow editing text, images, links, and buttons.
- Test two real email templates before choosing an editor library.
- Explain HTML compatibility, sanitization, and editing limitations. Do not promise lossless editing of arbitrary HTML.
- Distinguish editable HTML or text from an image containing text.
- Include desktop and mobile previews, reusable templates, and saved drafts.

### 5. Personalization and previews

- Support merge fields in both the subject and email body, including greeting name and company.
- Provide fallback text when fields are missing.
- Allow previewing an email as a specific recipient.
- Detect unresolved merge fields before sending.
- Send test emails without affecting production campaign metrics.

### 6. Reliable email sending

- Send one personalized email per recipient through a durable background queue.
- Include pause/resume, configurable rate limiting, and duplicate-send prevention.
- Freeze the recipient list, personalization values, and content version when a campaign is approved for immediate or scheduled sending. Later Notion edits must not silently change an approved campaign; suppression checks still apply at send time.
- Check suppression immediately before each queued email is sent.
- Do not blindly retry a send when a timeout leaves the outcome unknown.
- Explain how uncertain sending outcomes are recorded and reconciled; do not promise exactly-once delivery without evidence.
- Reserve capacity for ordinary company email and verify the account's applicable limits.

### 7. Campaign analytics

- Report Sent, Failed, recorded open signals, unique openers, total recorded opens, unique clickers, and total recorded clicks.
- Show activity by campaign, recipient, and individual link.
- Include first and latest activity timestamps.
- Flag or filter suspected automated activity and preserve the distinction between recorded and filtered events.
- Define metric denominators and deduplication rules.
- Example: one recipient clicking the same link three times represents one unique clicker and three recorded clicks, subject to the stated filtering policy.
- For Gmail-only sending, label rates based on Sent explicitly instead of claiming a Delivered denominator.

### 8. Tracking and delivery limitations

- Do not treat Gmail API success as proof of delivery to the recipient's inbox.
- Explain image blocking, caching, Apple Mail Privacy Protection, security scanners, and forwarded-email attribution.
- Present opens and clicks as observed signals rather than guaranteed human actions.
- Propose an alternative if Delivered and Bounced events are mandatory from the beginning.
- Explain how using a sending provider would differ from sending directly through Gmail.
- Distinguish recipient-server acceptance from inbox placement.

### 9. Tracking infrastructure and unsubscribe

- Use publicly accessible HTTPS endpoints for tracking.
- Use opaque random identifiers rather than exposing recipient email addresses in tracking URLs.
- Validate redirect destinations and prevent arbitrary open redirects.
- Include unsubscribe functionality and a suppression list.
- Tracking must continue working when the user's computer is turned off.
- Define authentication and access controls for CRM data and analytics.

### 10. Schedule email campaigns

- Offer "Send now" and "Schedule for later" on the review screen. The MVP supports one scheduled run per campaign; recurring campaigns are out of scope.
- Let the user choose a future date, time, and explicit timezone. Default to Asia/Ho_Chi_Minh (UTC+07:00), while showing the selected timezone in the picker, review screen, and scheduled-campaign list.
- Store the execution timestamp in UTC and retain the selected IANA timezone for display and audit. Reject past timestamps; explain how ambiguous or nonexistent daylight-saving times are handled if such zones are supported.
- Explain that the chosen time is when the campaign should start processing, not a guarantee that every message arrives at that exact minute. Apply account quotas and rate limits throughout the send.
- Before confirming a schedule, show the sender, recipient count, subject, content preview, date, time, and timezone. Scheduling is explicit approval to execute the reviewed snapshot later.
- Show upcoming scheduled campaigns with their status and scheduled time. Let the user reschedule or cancel a pending campaign before processing starts.
- If the user edits content or recipients, return the campaign to review and require scheduling confirmation again. Invalidate the old queued job so it cannot send the previous version.
- Use a durable server-side scheduler and queue so schedules persist across worker restarts and execute even when the browser is closed or the user's computer is off. Do not rely on browser timers or a running Claude Code session.
- Propose a status model covering draft, scheduled, queued/sending, completed, cancelled, paused/blocked, and failed outcomes. Distinguish campaign status from individual message status and define permitted transitions.
- Handle cancellation/rescheduling races, duplicate scheduler triggers, and concurrent workers so stale jobs cannot dispatch and duplicate sends are prevented as far as the provider interface allows. Preserve explicit unknown outcomes instead of promising exactly-once delivery.
- Recheck Gmail authorization, sending limits, and recipient suppression at execution time. If prerequisites fail, hold or block remaining work and show an actionable reason; do not mark the campaign successfully sent.
- Cancellation after sending starts must stop unsent work where possible and report any messages already sent or in flight. Do not promise to recall sent messages.
- Propose a dispatch-delay target and an overdue-job recovery policy for outages. Make the late-send grace period explicit; jobs beyond it should be held for review by default rather than silently sent much later.
- Record who created, changed, or cancelled the schedule, the scheduled time, actual processing start, per-message send times, and reasons for delay or failure.

## Quality assurance requirements from the tech lead

The workflow must cover operation reproduction, regression testing, re-smoke testing, and reports with logs.

During planning, define scenarios, required access, and acceptance criteria only. Execute tests after implementation is approved and a runnable application is available. Simulating or describing an operation is not evidence that a real integration passed.

### A. Reproduce and document operations

- Establish expected behavior from approved requirements and available reference materials.
- Execute critical workflows once a runnable build exists.
- Record prerequisites, test data, steps, expected results, and actual results.
- For reported bugs, attempt to reproduce the failure before changing code. Report unsuccessful reproduction explicitly.
- Do not use current implementation behavior as the only source of expected results.

### B. Regression testing

- Establish a reusable regression suite as working features become available.
- After meaningful changes, run relevant regression tests. Run the agreed release suite before declaring a milestone ready.
- Prioritize contact sync, personalization, template rendering, immediate and scheduled sending, duplicate prevention, tracking, and unsubscribe.
- Cover missing names, duplicate contacts, revoked Gmail access, rate limits, uncertain sending outcomes, and unsubscribed recipients still present in the queue.
- After fixing a defect, rerun the original failing case to confirm the fix, then test affected workflows for regressions.
- Do not add tests merely to mirror implementation details.

### C. Re-smoke testing

- For this plan, interpret "re-smoke" as rerunning a short smoke suite on the final build after changes or fixes.
- Check application startup and essential workflows.
- Define exact smoke scenarios and pass criteria.
- Include an initial smoke check before a longer regression run when useful.
- Adapt this interpretation if the team provides a specific checklist.

### D. Test evidence and reporting

Prepare a report for the user to share with the tech lead after each agreed test cycle. Include:

- Build or commit identifier, environment, execution time and timezone.
- Test commands and exit codes where applicable.
- Each scenario marked PASS, FAIL, BLOCKED, or NOT RUN.
- Expected versus actual results and reproduction steps for failures.
- Relevant logs and screenshots or browser traces where useful.
- Fixes and retest results; preserve initial failures and flaky-test history.
- Outstanding blockers, untested areas, and release recommendation.

Redact credentials, OAuth tokens, cookies, and personal contact data from shared evidence. Prepare reports for review; do not automatically send them to anyone.

### E. Testing boundaries

- Distinguish mocked tests from tests using real Gmail and Notion integrations.
- Use sample data, designated test accounts, test databases, and allowlisted recipients.
- Passing mocked tests does not prove that live integrations work.
- Never claim a test passed unless it was executed and its result observed.
- If access, credentials, or infrastructure are unavailable, mark affected checks BLOCKED or NOT RUN.
- Add testing deliverables and acceptance criteria to each relevant milestone.

### F. Scheduling-specific tests and evidence

- Reproduce this flow: create a campaign → preview → schedule a future time in a named timezone → confirm its pending state → execute when due → verify per-recipient results and analytics.
- Use controlled clocks and an isolated queue for automated tests; do not make the regression suite wait for real scheduled dates.
- Verify UTC conversion and display, rejection of past times, no early dispatch, and the proposed dispatch-delay target. Test daylight-saving boundaries if supported.
- Verify rescheduling invalidates the old job, cancelling a pending campaign prevents dispatch, and edits require a reviewed replacement snapshot.
- Verify approved names/content remain unchanged after Notion contact edits, while recipients who unsubscribe before execution are excluded.
- Exercise duplicate triggers, worker restarts, concurrent workers, and cancellation at dispatch time. Report uncertainty for sends already in flight.
- Exercise revoked Gmail access, exhausted quota, outages, overdue-job policy, and recovery without blindly repeating uncertain sends.
- Run a short, controlled scheduled-send integration check using designated accounts and allowlisted recipients after approval. Verify it works with the user browser closed; label mocked and live checks separately.
- Add scheduling to the smoke suite once implemented. Include campaign ID, schedule revision/job ID, timezone, scheduled and actual timestamps, state changes, and redacted error details in evidence.

## Required planning output

1. Assumptions and no more than three questions that could materially change the architecture. Prioritize unknown sending volume, template format, and whether Delivered/Bounced events are mandatory immediately.
2. MVP scope and later phases.
3. Recommended technology stack with reasons for major choices; avoid unnecessary infrastructure.
4. Data model, contact identity rules, Notion synchronization rules, and the campaign schedule/job state model.
5. Screens and the end-to-end user flow, including send-now, schedule, reschedule, and cancellation paths.
6. Setup the user must complete for Google Cloud, Workspace, Notion, domains, and hosting.
7. Milestones with deliverables, acceptance criteria, and meaningful tests.
8. Operation reproduction, regression, re-smoke, and evidence/reporting plans, including scheduling tests, timezone behavior, outages, and duplicate prevention.
9. Estimated implementation effort and operating costs with explicit assumptions.
10. Assessment of whether REA, MCP servers, skills, or custom agents are necessary, optional, or unnecessary.
11. Proposed project documentation after approval: a concise CLAUDE.md, docs/PLAN.md containing milestone and testing checklists, and reports/ for actual test evidence.
12. Scheduling design: durable job execution, timing and overdue-job policy, cancellation/rescheduling behavior, Gmail reconnection handling, and operational visibility.

Present the plan for review and stop before implementation. Documentation approval and permission to implement or send live campaigns must not be assumed to be the same thing.

