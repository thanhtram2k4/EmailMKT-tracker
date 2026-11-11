import { describe, expect, it } from "vitest";
import { checkIdentity, emailDomain, normalizeEmail } from "../../src/lib/auth/access";

describe("identity checks (domain + verified email)", () => {
  const domains = ["example.com"];
  it("accepts a verified company address, case-insensitively", () => {
    expect(checkIdentity({ email: " Alice@Example.COM ", emailVerified: true }, domains)).toEqual({ ok: true, email: "alice@example.com" });
  });
  it("rejects unverified emails before anything else", () => {
    expect(checkIdentity({ email: "alice@example.com", emailVerified: false }, domains)).toMatchObject({ ok: false, reason: "email_unverified" });
  });
  it.each(["alice@freemail.example", "alice@example.com.evil.io", "alice@sub.example.com", "alice@notexample.com", "example.com@freemail.example", "noat"])(
    "rejects %s as wrong_domain",
    (email) => {
      expect(checkIdentity({ email, emailVerified: true }, domains)).toMatchObject({ ok: false, reason: "wrong_domain" });
    },
  );
  it("helpers", () => {
    expect(normalizeEmail("  A@B.C ")).toBe("a@b.c");
    expect(emailDomain("x@Y.com")).toBe("y.com");
    expect(emailDomain("nope")).toBe("");
  });
});
