import { describe, expect, it } from "vitest";
import { checkEmail, normalizeContactFields, normalizeText, singleContactIssues } from "../../src/lib/crm/contact-validation";
import { assertConsentAllowed, ConsentRuleError } from "../../src/lib/crm/consent";
import { eligibility, type EligibilityInput } from "../../src/lib/crm/eligibility";

describe("email normalization and validation", () => {
  it("trims and lowercases only (no dot/plus folding)", () => {
    expect(checkEmail("  Mai.Ngo@Example.com ")).toEqual({ status: "valid", normalized: "mai.ngo@example.com" });
    expect(checkEmail("tai.ha+news@example.com")).toEqual({ status: "valid", normalized: "tai.ha+news@example.com" });
    expect(checkEmail("pao.lo@sub.congty-anphat.example")).toMatchObject({ status: "valid" });
  });
  it.each([
    ["trang.ly@@example.com", "multiple_at_signs"],
    ["tuan.mai example.com", "contains_whitespace"],
    ["sơn.trinh@example.com", "non_ascii"],
    ["lam..dinh@example.com", "consecutive_dots"],
    ["hung.vu@localhost", "domain_without_dot"],
    ["no-at-sign.example.com", "no_at_sign"],
    ["@example.com", "empty_local_part"],
    ["a@", "empty_domain"],
    [".a@example.com", "leading_or_trailing_dot"],
    ["a@exa_mple.com", "invalid_characters"],
    ["a@example.c0m", "invalid_characters"],
  ])("%s is invalid (%s)", (raw, reason) => {
    expect(checkEmail(raw)).toMatchObject({ status: "invalid", reason });
  });
  it("treats empty and whitespace as missing", () => {
    expect(checkEmail(null).status).toBe("missing");
    expect(checkEmail("   ").status).toBe("missing");
  });
});

describe("Vietnamese text normalization", () => {
  it("converts decomposed (NFD) diacritics to NFC so names compare equal", () => {
    const nfd = "Phạm Thị Thu Hà".normalize("NFD");
    expect(nfd).not.toBe("Phạm Thị Thu Hà");
    expect(normalizeText(nfd)).toBe("Phạm Thị Thu Hà");
  });
  it("collapses whitespace and turns blank into null", () => {
    expect(normalizeText("  Anh   An ")).toBe("Anh An");
    expect(normalizeText("   ")).toBeNull();
  });
  it("dedupes, trims and sorts tags", () => {
    expect(normalizeContactFields({ fullName: "x", greetingName: null, email: null, company: null, tags: ["  Khách hàng  ", "Khách hàng", "VIP", ""] }).tags).toEqual([
      "Khách hàng",
      "VIP",
    ]);
  });
  it("flags missing greeting name and missing full name", () => {
    const { issues } = singleContactIssues({ fullName: null, greetingName: null, email: "a@example.com", company: null, tags: [] });
    expect(issues).toEqual(expect.arrayContaining(["full_name_missing", "greeting_name_missing"]));
  });
});

describe("consent rules", () => {
  const base = { emailNormalized: "a@example.com", purpose: "marketing_email" as const, recordedBy: "test" };
  it.each(["notion_import", "notion_unsubscribe", "system"] as const)("an automated source (%s) can never grant consent", (source) => {
    expect(() => assertConsentAllowed({ ...base, status: "granted", source, evidenceRef: "anything" })).toThrow(ConsentRuleError);
  });
  it("a staff grant requires evidence", () => {
    expect(() => assertConsentAllowed({ ...base, status: "granted", source: "staff_entry" })).toThrow(/evidence/);
    expect(() => assertConsentAllowed({ ...base, status: "granted", source: "staff_entry", evidenceRef: "Form #F-1" })).not.toThrow();
  });
  it("imports may record unknown and withdrawn", () => {
    expect(() => assertConsentAllowed({ ...base, status: "unknown", source: "notion_import" })).not.toThrow();
    expect(() => assertConsentAllowed({ ...base, status: "withdrawn", source: "notion_unsubscribe" })).not.toThrow();
  });
});

describe("eligibility", () => {
  const ok: EligibilityInput = {
    state: "active",
    emailStatus: "valid",
    isDuplicate: false,
    duplicateResolution: "none",
    suppressed: false,
    marketingConsent: "granted",
    requireConsent: true,
  };
  it("eligible only when every condition holds", () => {
    expect(eligibility(ok)).toEqual({ eligible: true, reasons: [] });
  });
  it("unknown consent blocks when consent is required (default)", () => {
    expect(eligibility({ ...ok, marketingConsent: "unknown" }).reasons).toEqual(["consent_unknown"]);
    expect(eligibility({ ...ok, marketingConsent: "unknown", requireConsent: false }).eligible).toBe(true);
  });
  it("withdrawn consent and suppression always block, even if consent is not required", () => {
    expect(eligibility({ ...ok, marketingConsent: "withdrawn", requireConsent: false }).reasons).toEqual(["consent_withdrawn"]);
    expect(eligibility({ ...ok, suppressed: true }).reasons).toEqual(["suppressed"]);
  });
  it("duplicates: unresolved and secondary block, primary does not", () => {
    expect(eligibility({ ...ok, isDuplicate: true }).reasons).toEqual(["duplicate_unresolved"]);
    expect(eligibility({ ...ok, isDuplicate: true, duplicateResolution: "secondary" }).reasons).toEqual(["duplicate_secondary"]);
    expect(eligibility({ ...ok, isDuplicate: true, duplicateResolution: "primary" }).eligible).toBe(true);
  });
  it("collects multiple reasons", () => {
    expect(eligibility({ ...ok, state: "archived", emailStatus: "invalid", suppressed: true }).reasons).toEqual(["archived", "email_invalid", "suppressed"]);
  });
});
