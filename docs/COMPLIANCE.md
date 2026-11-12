# Legal and consent prerequisites for real customer campaigns

Status: **research notes, not legal advice. Nothing here has been confirmed by the company or its counsel.**
Researched 2026-11-12. §3 was re-verified against the official texts on 2026-11-12, during M2. Re-check before enabling live campaigns, because the rules are changing; see §1.6.

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
  - **Policy confirmed by the user on 2026-11-12:** contacts with *unknown* consent are ineligible for marketing sends by default (`crm.require_marketing_consent=true`), and remain manageable in the CRM.
  - This is an internal safety default. It is not a legal conclusion; counsel's answers (§5) still decide which evidence counts as consent.
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

## 3. Personal data: Law 91/2025/QH15 and Decree 356/2025/NĐ-CP (official texts checked 2026-11-12)
Both texts were downloaded from the Official Gazette (Công báo). The PDFs have a text layer and the Government Office's digital signature.
- **Law 91/2025/QH15:** https://congbaocdn.chinhphu.vn/CongBaoCP/VanBan/2025/6/45578/57730-1-2025971-97291-2025-qh15.pdf (Công báo No. 971+972, 24-7-2025). The index page lists no amending or correcting documents.
- **Decree 356/2025/NĐ-CP:** https://congbaocdn.chinhphu.vn/180507251028987904/2026/1/17/356signed-1768638052103952849513.pdf (dated 31-12-2025; Công báo No. 18, 18-01-2026; in force 01-01-2026). Art. 42(2) says that Decree 13/2023/NĐ-CP ceases to be in force.

1. **Effective date and transition (Law Arts. 38.1, 39)** (VERIFIED-OFFICIAL)
   - The law is in force from 01-01-2026.
   - Consents obtained under Decree 13/2023 remain valid.
   - Transfer and processing assessment dossiers already received under Decree 13 remain valid.
2. **Consent (Law Art. 9; Decree Art. 6)** (VERIFIED-OFFICIAL)
   - Consent must be voluntary and informed about the data, purpose, controller and rights.
   - It must be clear, specific, printable or copyable, and verifiable.
   - It is given per purpose and cannot be bundled with other purposes.
   - "Sự im lặng hoặc không phản hồi không được coi là sự đồng ý" (silence or no response is not consent).
   - Decree Art. 6:
     - Consent methods must show who consented, when, and to what.
     - Pre-ticked choices are prohibited.
     - The controller must store the consent and **bears the burden of proof**.
3. **Advertising (Law Art. 28)** (VERIFIED-OFFICIAL)
   - Cl. 3: consent is needed, with the customer informed of the content, method, form and **frequency**, and an opt-out provided.
   - Cl. 4: spam and advertising law also applies.
   - Cl. 5: the data subject may demand that advertising stop.
   - Cl. 8(a): behavioural or targeted advertising may track only **with consent**.
   - Cl. 8(b): requires a refusal mechanism, a retention period and deletion.
   - **UNRESOLVED (counsel):** cl. 1–7 are framed around businesses that provide advertising services. Whether they bind a company marketing its own products, and whether email open and click pixels count as "tracking" under cl. 8, are not settled.
4. **Cross-border transfer (Law Art. 20; Decree Arts. 17, 18, 20)** (VERIFIED-OFFICIAL text)
   - The listed cases include:
     - storing data collected in Vietnam on servers abroad **"hoặc trên dịch vụ điện toán đám mây của nhà cung cấp dịch vụ ở nước ngoài"** (or on a foreign provider's cloud service) (Decree 17(1)(a));
     - using a platform abroad to process data collected in Vietnam (Law 20(1)(c)).
   - The transferring party prepares a transfer impact assessment (TIA) dossier and files it with the MPS specialised PDP agency **within 60 days**. The Law says "từ ngày đầu tiên chuyển"; the Decree says "kể từ ngày tiến hành chuyển".
   - Filing uses Form 09, with Form 01a for organisations. Updates follow Decree Art. 20.
   - Exemptions:
     - The only cloud exemption covers an organisation's **employee** data (Law 20(6)(b)).
     - Decree 17(3) adds other cases (press, emergencies, HR, logistics, payments and similar). None covers marketing.
   - The small-enterprise relief in Law Art. 38.2–38.3 does **not** cover Art. 20.
   - **What this does and does not establish:**
     - On its face the text appears to cover keeping customer data in foreign SaaS or cloud services such as Notion, Render Singapore and AWS SES.
     - The text does **not** settle how, or from when, the 60-day clock applies to *this company*. Open points:
       - which party is the transferring party and which the recipient;
       - what counts as the "first day" of transfer;
       - how use that began before 01-01-2026 without a Decree 13 dossier is treated;
       - whether one dossier can cover several vendors.
     - **This document does not conclude that any filing deadline has started.** Counsel must decide (§5, Q4).
     - An earlier note of mine said a clock "may already have started for Notion". That overstated what the text establishes; it is withdrawn.
   - **Development so far uses synthetic data only.** Synthetic data is not personal data, so M1–M2 local work involves no personal-data transfer.
   - Late or missing filing is fined VND 30–50 million (Decree 330/2026/NĐ-CP, Art. 56(1)(a)–(b)) (VERIFIED-OFFICIAL: https://congbaocdn.chinhphu.vn/180507251028987904/2026/9/4/470339-1787824085_v1_1788483945_signed.pdf).
5. **Processing impact assessment, DPO and small-business relief (Law Arts. 21, 22, 33.2, 38.2–38.3; Decree Arts. 19, 41)** (VERIFIED-OFFICIAL)
   - The processing impact assessment is filed within 60 days of starting processing.
   - Small and startup enterprises may opt out of Arts. 21, 22 and 33(2) for 5 years. Household and micro businesses are exempt.
   - The relief does **not** apply to:
     - data-processing service providers;
     - direct processing of sensitive data;
     - a "large number" of data subjects, defined in Decree Art. 41 as **100,000 or more cumulative data subjects**.
6. **Data-subject requests (Decree Art. 5)** (VERIFIED-OFFICIAL)

   | Request | Respond | Carry out | Via a processor or third party | Extension |
   |---|---|---|---|---|
   | Withdraw consent, restrict, object | 2 working days | 15 days | 20 days | once, up to 15 days, with reasons |
   | Access or correction | 2 working days | 10 days | 15 days | once, up to 10 days |
   | Deletion | 2 working days | 20 days | 30 days | once, up to 20 days |

   Whether the 15, 20 and 30 days are calendar or working days: **UNRESOLVED (counsel)**.
7. **Amendments**
   - No amendment to Decree 356/2025 was found on its Công báo index page.
   - Decree 356/**2026**/NĐ-CP (repealing 18 older decrees, effective 01-12-2026) is a different decree. Its list reportedly does not include 356/2025; that is SECONDARY, since its full text was not read.
   - A full sweep of 2026 decrees: **UNRESOLVED**.

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
4. Does keeping customer data in Notion, Render (Singapore) or AWS SES count as a transfer for this company? If it does:
   - who is the transferring party and who is the recipient;
   - from which date does the 60-day TIA deadline run, given use that began before 2026-01-01;
   - can one dossier cover all vendors?
   (The official text is quoted in §3.4. This document draws no conclusion.)
5. Do existing CRM contacts have valid consent under Decree 91 Art. 11 and PDPL, or do they need to opt in again?
6. Could Decree 330/2026 Art. 38 (providers with servers abroad) apply to sending through SES?
7. If the MPS draft is adopted, what is needed to register a sender name for email?
8. Are there EU or US recipients? If so, exclude them or apply a separate regime?

## 6. Engineering implications (proposed; adopt after counsel review)
These are **proposals**, not approved requirements. They are listed in docs/PLAN.md under "Pending compliance changes" so that none of them silently changes the approved scope.

| Topic | Proposal | Milestone |
|---|---|---|
| Consent records | **Schema implemented in M2.** Append-only records per address and purpose with status, source, effective time, recorded time, recorder, evidence reference and note, and consent text version. Imports default to *unknown* and can never grant consent (enforced by DB constraint). Still open: a disclosed-frequency field and a lookup tool for the data subject (Decree 91 Art. 11.3) | M2 (done), M5 (enforce at send) |
| Subject label | Enforce a `[QC] ` or `[AD] ` prefix on every advertising campaign subject | M4/M5 |
| Footer | Sender identity block, then an opt-out block (one-click link, reply-to-unsubscribe, phone), plus a postal address for US recipients | M3/M5 |
| Refusal handling | Suppress immediately; send a one-time confirmation with no advertising, stating the time received and the time stopped; keep links working for at least 30 days | M5 |
| Frequency cap | At most 3 advertising emails per address per rolling 24 hours, checked at send time alongside suppression | M5 |
| Tracking | Per-contact tracking consent flag; when it is missing, no pixel and no link rewriting; retention limit for events | M7 |
| Data-subject requests | Withdraw or delete workflow propagated to Notion, SES and the database, with deadline tracking | M8 |
| Region flag | Mark EU or US recipients if any (question 8) | M2 |
