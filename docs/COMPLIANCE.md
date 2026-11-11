# Legal and consent prerequisites for real customer campaigns

Status: **research notes, not legal advice. Nothing here has been confirmed by the company or its counsel.**
Researched 2026-11-12. Re-check before enabling live campaigns, because the rules are changing; see §1.5.

Evidence labels:
- **VERIFIED**: read directly from an official source, URL given.
- **SECONDARY**: from an unofficial legal database or a news report. Needs confirmation against the official text.
- **UNRESOLVED**: unknown, or needs a decision from counsel.

Sources that could not be read during the research:
- vbpl.vn: pages render with JavaScript and the attachments returned 404.
- vbpl.moj.gov.vn: the domain did not resolve.
- The Decree 91 PDF on datafiles.chinhphu.vn: a scanned image, so the text could not be extracted.
- EUR-Lex: returned empty pages.

As a result, most of the Decree 91 article text below is **SECONDARY** (hethongphapluat.com, luatvietnam.vn, thuvienphapluat-type sites).

## Gate: real customer campaigns stay disabled until every item is checked
These go beyond the technical `SEND_MODE`, admin and approval controls in CLAUDE.md.
- [ ] Counsel has confirmed the applicable rules (questions in §5) and the answers are recorded in this file.
- [ ] A lawful consent basis exists for every contact who will be emailed (§1.2, §3.2), and consent evidence is stored per contact.
- [ ] Every advertising email carries the subject label, sender identity block and opt-out block (§1.3–§1.5), and they are verified on a test send.
- [ ] Opt-outs are honoured immediately, and the refusal confirmation email is in place (§1.5).
- [ ] The frequency cap is enforced: at most 3 advertising emails per address per 24 hours (§1.4).
- [ ] Open and click tracking follows counsel's answer on tracking consent (§3.3); if needed, it is turned off for contacts without consent.
- [ ] Personal-data obligations are done or formally scheduled: the cross-border transfer impact assessment (TIA) filing, and the DPIA/DPO decision (§3.4–§3.5).
- [ ] A data-subject request procedure exists: withdraw consent, delete data (§3.6).
- [ ] The status of the draft replacement spam decree has been re-checked (§1.6).
- [ ] The user has explicitly confirmed the above in writing. **No one should assume this has been confirmed.**

## 1. Decree 91/2020/NĐ-CP on spam messages, emails and calls
1. **Definitions (Art. 3.1, 3.4)** (SECONDARY)
   - An advertising email introduces products or services for profit.
   - Spam includes advertising email sent without the recipient's prior consent.
2. **Prior consent (Art. 11)** (SECONDARY)
   - Consent must be registered, for example through a form on paper or on a website (11.2(b)).
   - The sender must verify that consent was given clearly (11.4).
   - The sender must give users a way to look up their consent and refusal records (11.3).
   - Registration, refusal and confirmation records must be kept for **at least 1 year** (11.7).
3. **Subject label (Art. 18.1–18.3)** (SECONDARY)
   - Advertising emails carry a label at the **start of the subject**: **`[QC]` or `[AD]`**.
   - This corrects the earlier planning note, which mentioned "[ADV]"; that is not the listed form.
4. **Frequency (Art. 13.5)** (SECONDARY)
   - At most **3 advertising emails to one address in 24 hours**, unless the recipient agreed otherwise.
   - The time-of-day windows apply only to SMS and calls.
5. **Sender identity and opt-out (Art. 19, 20, 13.4)** (SECONDARY)
   - Sender identity block: name, phone, email, geographic address, and website or social pages if any.
   - The identity block sits immediately **before** the opt-out section.
   - The opt-out sits at the end of the email and must let the recipient refuse **all** of the advertiser's ads.
   - Opt-out channels include a website link, a reply email and a phone number.
   - On refusal, the sender must **immediately** send a one-time confirmation with no advertising, stating when the refusal was received and when sending stopped. Sending must stop.
   - The text describes "immediately"; no specific hours figure could be verified.
6. **Registration and status**
   - The registered sender name (tên định danh) applies to SMS and calls, not email, under the current decree (SECONDARY).
   - The Ministry of Public Security (MPS) published a **draft replacement decree** for comment in Sept 2026. **VERIFIED** that the draft exists: https://xaydungchinhsach.chinhphu.vn/de-xuat-bo-tieu-chi-nhan-dien-tin-nhan-rac-cuoc-goi-rac-thu-dien-tu-rac-119260909155621654.htm
   - The draft reportedly adds frequency and relationship criteria for spam, and a registered sender name **for advertising email** (SECONDARY, vneconomy.vn).
   - Adoption and effective date: **UNRESOLVED**.
7. **Penalties (Decree 330/2026/NĐ-CP, Art. 37; effective 2026-08-19)** (SECONDARY)

   | Violation | Fine (VND) |
   |---|---|
   | No consent | 10–20M |
   | No label, or records not kept | 20–30M |
   | More than 3 emails in 24 h, sender hidden, or no refusal confirmation | 30–50M |
   | Incomplete opt-out | 70–80M |
   | No refusal-handling system | 80–90M |

   Whether these amounts apply to individuals or organisations: **UNRESOLVED**.

   Art. 38 covers email service providers with servers outside Vietnam. Whether it can apply to a company sending through SES: **UNRESOLVED**.

## 2. Law on Advertising
- **Law 16/2012/QH13, Art. 24.1** (SECONDARY)
  - Advertising by email only with the recipient's **prior consent**.
  - Sending stops immediately on refusal, and refusing is free.
- **Law 75/2025/QH15** (amending law, effective 2026-01-01) (SECONDARY)
  - It rewrote Art. 23 on online advertising: a clear ad identifier and a way to refuse.
  - No repeal of Art. 24 was found.
- Decree 342/2025 (implementing decree) was not reviewed for email rules: **UNRESOLVED**.

## 3. Personal data: Law on Personal Data Protection 91/2025/QH15
Effective 2026-01-01. The law's own text is **VERIFIED** from the Official Gazette: https://congbaocdn.chinhphu.vn/CongBaoCP/VanBan/2025/6/45578/57730-1-2025971-97291-2025-qh15.pdf
1. **Effective date (Art. 38.1)** (VERIFIED). Consent obtained under Decree 13/2023 remains valid (Art. 39.1) (VERIFIED).
2. **Consent (Art. 9)** (VERIFIED)
   - Consent must be informed: data, purpose, controller, rights.
   - It must be verifiable and given **per purpose**, not bundled with other purposes.
   - **Silence is not consent.**
3. **Marketing (Art. 28)** (VERIFIED)
   - The customer must consent knowing the content, method, form and **frequency** of marketing, and must be able to refuse (28.3).
   - Spam and advertising law also applies (28.4).
   - Tracking for behavioural or personalised advertising requires consent (28.8(a)).
   - Whether email open and click tracking falls under 28.8: **UNRESOLVED (question for counsel)**.
4. **Cross-border transfer (Art. 20)** (VERIFIED)
   - Storing data on systems abroad counts as a transfer. Here that means AWS Singapore, Render Singapore and Notion (US).
   - A transfer impact assessment (TIA) dossier must be filed **within 60 days of the first transfer**.
   - The cloud exemption covers employee data only.
   - The small-business relief does **not** cover Art. 20.
5. **Processing impact assessment (Art. 21) and DPO (Art. 33.2)** (VERIFIED)
   - Small and startup enterprises are relieved for 5 years; household and micro businesses are exempt (Art. 38.2–38.3).
   - The relief does not apply to large-scale processing. Decree 356/2025 sets the threshold at 100,000 or more data subjects (SECONDARY).
6. **Data-subject rights** (VERIFIED: Arts. 4, 10, 14; deadlines SECONDARY, Decree 356/2025 Art. 5)
   - Rights: withdraw consent and request deletion.
   - Withdrawal: acknowledge within 2 working days, complete within 15 days.
   - Deletion: complete within 20 days, or 30 days if processors are involved.
7. **Implementing decree and filing**
   - Decree 356/2025/NĐ-CP replaced Decree 13/2023 (SECONDARY).
   - Dossiers go to the MPS through the National Public Service Portal (SECONDARY).

## 4. Recipients outside Vietnam (only if any exist)
- **US, CAN-SPAM** (VERIFIED: https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business)
  - Truthful headers and subject.
  - Identify the message as an ad.
  - Include a physical postal address.
  - The opt-out must keep working for 30 days and be honoured within 10 business days.
- **EU**
  - The EDPB says tracking pixels and tracked links fall under ePrivacy Art. 5(3), so consent is needed (VERIFIED: https://www.edpb.europa.eu/system/files/2024-10/edpb_guidelines_202302_technical_scope_art_53_eprivacydirective_v2_en_0.pdf).
  - ePrivacy Art. 13 and the GDPR Art. 21 right to object: **UNRESOLVED** (EUR-Lex not readable).

## 5. Questions for the company's legal counsel
1. Is the company a small or micro enterprise, and will it stay under 100,000 data subjects? This decides whether a DPIA and DPO are needed now.
2. Do email open and click pixels count as "tracking" under PDPL Art. 28.8, so that separate opt-in consent is needed?
3. Does Art. 28 apply to a company marketing its own products, given it is written for advertising-service businesses?
4. Who prepares and files the Art. 20 TIA (AWS Singapore, Render, Notion US), and when does the 60-day clock start? Has it started already, for Notion?
5. Do existing CRM contacts have valid consent under Decree 91 Art. 11 and PDPL, or do they need to opt in again?
6. Could Decree 330/2026 Art. 38 (providers with servers abroad) apply to sending through SES?
7. If the MPS draft is adopted, what is needed to register a sender name for email?
8. Are there EU or US recipients? If so, exclude them or apply a separate regime?

## 6. Engineering implications (proposed; adopt after counsel review)
These are **proposals**, not approved requirements. They are listed in docs/PLAN.md under "Pending compliance changes" so that none of them silently changes the approved scope.

| Topic | Proposal | Milestone |
|---|---|---|
| Consent records | Store per contact and purpose: timestamp, source or form, consent text and version, purposes, frequency disclosed, evidence. Keep at least 1 year; allow lookup | M2 (schema), M5 (enforce) |
| Subject label | Enforce a `[QC] ` or `[AD] ` prefix on every advertising campaign subject | M4/M5 |
| Footer | Sender identity block, then an opt-out block (one-click link, reply-to-unsubscribe, phone), plus a postal address for US recipients | M3/M5 |
| Refusal handling | Suppress immediately; send a one-time confirmation with no advertising, stating the time received and the time stopped; keep links working for at least 30 days | M5 |
| Frequency cap | At most 3 advertising emails per address per rolling 24 hours, checked at send time alongside suppression | M5 |
| Tracking | Per-contact tracking consent flag; when it is missing, no pixel and no link rewriting; retention limit for events | M7 |
| Data-subject requests | Withdraw or delete workflow propagated to Notion, SES and the database, with deadline tracking | M8 |
| Region flag | Mark EU or US recipients if any (question 8) | M2 |
