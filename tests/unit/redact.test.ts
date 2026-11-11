import { describe, expect, it } from "vitest";
import { redactText } from "../../src/lib/redact";

describe("evidence redaction", () => {
  it("masks email addresses but keeps the domain", () => {
    expect(redactText("sent to nguyen.van.a@company.vn ok")).toBe("sent to n***@company.vn ok");
  });
  it("masks bearer tokens, cookies, AWS keys, Notion and Google tokens", () => {
    const raw = [
      "Authorization: Bearer abc.def-123",
      "cookie: better-auth.session_token=xyz; other=1",
      "key AKIAABCDEFGHIJKLMNOP",
      "ntn_0123456789abcdefghijABCDEFGH",
      "ya29.a0AfH6SMBx-token",
      "GOCSPX-secretvalue",
      "https://app/x?token=abc123&state=zzz&ok=1",
    ].join("\n");
    const out = redactText(raw);
    expect(out).not.toMatch(/abc\.def-123|xyz|AKIAABCDEFGHIJKLMNOP|ntn_0123|ya29\.a0|GOCSPX-secret|abc123|zzz/);
    expect(out).toContain("ok=1");
  });
});
