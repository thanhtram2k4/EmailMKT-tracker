/** M7 unit tests: link rewriting matches the snapshot link table; automation flags; IP hashing. */
import { describe, expect, it } from "vitest";
import { applyTracking, extractLinks, renderMessage } from "../../src/lib/campaigns/render";
import { hashIp, isAutomated, uaFlags } from "../../src/lib/campaigns/tracking";

const T = "TOKEN_abcdefghijklm";
const HTML = `<!DOCTYPE html><html><body>
<a href="https://a.example/1">One</a>
<a href="mailto:x@example.com">mail</a>
<a href="{{ unsubscribe_url }}">unsub</a>
<!--[if mso]><a href="https://a.example/mso">MSO</a><![endif]-->
<a href="https://a.example/2?q={{ email }}">merge in url</a>
<a href=" https://a.example/3 ">Three</a>
<a href="http://a.example/4"><img src="x.png" alt="Logo"></a>
</body></html>`;

describe("link rewriting", () => {
  it("link index n in the email is the snapshot's link n (same selection and order)", () => {
    const links = extractLinks(HTML);
    expect(links.map((l) => l.url)).toEqual(["https://a.example/1", "https://a.example/3", "http://a.example/4"]);
    const out = applyTracking(HTML, T, "https://t.example");
    const rewritten = [...out.matchAll(/href="https:\/\/t\.example\/c\/TOKEN_abcdefghijklm\/(\d+)"/g)].map((m) => Number(m[1]));
    expect(rewritten).toEqual([0, 1, 2]);
    // untouched: mailto, merge-field hrefs, links inside MSO comments
    expect(out).toContain('href="mailto:x@example.com"');
    expect(out).toContain('href="{{ unsubscribe_url }}"');
    expect(out).toContain('href="https://a.example/2?q={{ email }}"');
    expect(out).toContain('<a href="https://a.example/mso">');
    // exactly one pixel, inside <body>
    expect(out.match(/\/o\/TOKEN_abcdefghijklm\.gif/g)).toHaveLength(1);
    expect(out.indexOf("/o/TOKEN_abcdefghijklm.gif")).toBeLessThan(out.indexOf("</body>"));
  });
  it("a fragment without <body> still gets the pixel; untracked rendering leaves links direct", () => {
    expect(applyTracking('<p><a href="https://a.example/1">x</a></p>', T, "https://t.example")).toMatch(/<\/p><img src="https:\/\/t\.example\/o\/TOKEN_abcdefghijklm\.gif"/);
    const snap = { subjectTemplate: "S", html: '<p><a href="https://a.example/1">x</a><a href="{{ unsubscribe_url }}">u</a></p>', plainText: "https://a.example/1" };
    const mv = { full_name: null, greeting_name: null, company: null, email: "r@example.com" };
    const off = renderMessage(snap, mv, T, "https://t.example");
    expect(off.html).toContain('href="https://a.example/1"');
    expect(off.html).not.toContain("/o/");
    const on = renderMessage(snap, mv, T, "https://t.example", { track: true });
    expect(on.html).toContain(`href="https://t.example/c/${T}/0"`);
    expect(on.html).toContain(`href="https://t.example/u/${T}"`); // unsubscribe stays the unsubscribe URL
    expect(on.text).toContain("https://a.example/1"); // plain text is not rewritten
  });
});

describe("automation flags", () => {
  it.each([
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36", []],
    ["Mozilla/5.0 (compatible; Googlebot/2.1)", ["scanner_ua"]],
    ["python-requests/2.32.3", ["scanner_ua"]],
    ["curl/8.4.0", ["scanner_ua"]],
    ["Mozilla/5.0 (compatible; Barracuda Sentinel)", ["scanner_ua"]],
    ["Mozilla/5.0 HeadlessChrome/120", ["scanner_ua"]],
    ["", ["no_user_agent"]],
    [null, ["no_user_agent"]],
  ])("click UA %s → %j", (ua, flags) => {
    expect(uaFlags(ua as string | null, "click")).toEqual(flags);
  });
  it("Google's image proxy is labelled for opens but is not automated", () => {
    const f = uaFlags("Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)", "open");
    expect(f).toEqual(["proxy_open"]);
    expect(isAutomated(f)).toBe(false);
    expect(isAutomated(["proxy_open", "head_request"])).toBe(true);
  });
  it("IPs are stored only as a keyed hash", () => {
    const h = hashIp("203.0.113.7", "secret-a");
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(h).not.toBe(hashIp("203.0.113.7", "secret-b"));
    expect(hashIp(null, "s")).toBeNull();
  });
});
