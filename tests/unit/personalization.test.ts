/**
 * M4 personalization (subject + body). Expected behaviour comes from PROJECT_BRIEF §5 and
 * docs/PLAN.md M4 (R-PERS-01…03, 06, 07), not from the implementation.
 */
import { describe, expect, it } from "vitest";
import { fieldsNeedingValues, renderForRecipient, renderSubject, renderText, SAMPLE_RECIPIENTS, scanSubject } from "../../src/lib/templates/merge";

const noGreeting = SAMPLE_RECIPIENTS.find((r) => r.id === "sample-no-greeting")!.data;
const full = SAMPLE_RECIPIENTS.find((r) => r.id === "sample-full")!.data;

describe("subject merge fields", () => {
  it("R-PERS-01: a missing greeting name renders its fallback, in the subject and the body", () => {
    const s = renderSubject('Chào {{ greeting_name | default: "bạn" }}!', noGreeting);
    expect(s.subject).toBe("Chào bạn!");
    expect(s.missingWithoutFallback).toEqual([]);
    const b = renderForRecipient('<p>Chào {{ greeting_name | default: "bạn" }}</p>', noGreeting);
    expect(b.html).toBe("<p>Chào bạn</p>");
  });

  it("reports a missing value when there is no fallback (blocks a test send)", () => {
    const s = renderSubject("Chào {{ greeting_name }}", noGreeting);
    expect(s.missingWithoutFallback).toEqual(["greeting_name"]);
  });

  it("R-PERS-02: Vietnamese diacritics are kept, and the subject is plain text (not HTML-escaped)", () => {
    const s = renderSubject("{{ greeting_name }} ơi, ưu đãi cho {{ company }}", { ...full, company: "Công ty A&B <Việt>" });
    expect(s.subject).toBe("Anh An ơi, ưu đãi cho Công ty A&B <Việt>");
    // In the HTML body the same value IS escaped.
    expect(renderForRecipient("<p>{{ company }}</p>", { company: "A&B <Việt>" }).html).toBe("<p>A&amp;B &lt;Việt&gt;</p>");
  });

  it("R-PERS-03: an unknown field or filter, or a syntax error, is a blocking problem", () => {
    expect(scanSubject("Hi {{ first_name }}").map((p) => p.error)).toEqual(["unknown field"]);
    expect(scanSubject("Hi {{ greeting_name | shout }}").map((p) => p.error)).toEqual(["unknown filter"]);
    expect(scanSubject("Hi {{ greeting_name | }}").map((p) => p.error)).toEqual(["syntax"]);
    expect(scanSubject("Hi {{ unsubscribe_url }}").map((p) => p.error)[0]).toMatch(/cannot be used in a subject/);
    expect(scanSubject('Chào {{ greeting_name | default: "bạn" }}')).toEqual([]);
  });

  it("R-PERS-06: Liquid tags in the subject are not executed", () => {
    const tpl = '{% include "/etc/passwd" %}{% assign x = "y" %}Hello';
    expect(scanSubject(tpl).map((p) => p.error)).toEqual([expect.stringMatching(/Liquid tags are not allowed/), expect.stringMatching(/Liquid tags are not allowed/)]);
    const r = renderSubject(tpl, full);
    expect(r.subject).toBe(tpl); // left literal, never evaluated
  });

  it("R-PERS-07: a line break in the subject or in a merged value is refused (header injection)", () => {
    expect(scanSubject("Hello\r\nBcc: x@example.org").map((p) => p.error)).toContain("line breaks are not allowed in a subject");
    const r = renderSubject("Hi {{ greeting_name }}", { greeting_name: "An\r\nBcc: x@example.org" });
    expect(r.errors.map((e) => e.error)).toContain("a merge value contains a line break");
  });

  it("lists exactly the fields that need a value (no fallback), ignoring unsubscribe_url", () => {
    expect(fieldsNeedingValues("Hi {{ greeting_name }}", '<a href="{{ unsubscribe_url }}">x</a> {{ company | default: "-" }} {{ full_name }}')).toEqual(["full_name", "greeting_name"]);
  });

  it("renders the plain-text part without HTML escaping and keeps line breaks", () => {
    expect(renderText("Chào {{ company }}\nDòng 2", { company: "A&B" }).text).toBe("Chào A&B\nDòng 2");
  });
});
