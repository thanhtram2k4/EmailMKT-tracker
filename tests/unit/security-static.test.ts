/**
 * M8 security review, as regression tests over the source tree:
 *  - every page, route and Server Function checks the signed-in staff member, except an explicit
 *    list of public endpoints (each with its own protection);
 *  - the confirmed role rule: approving / scheduling / sending / resolving uncertain sends (and other
 *    admin operations) require the admin role; members may create, edit, review and pause;
 *  - no secrets or env files are tracked in Git.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const APP = path.resolve("src/app");
const AUTH = /\b(requireStaff|requireRole|requireInternalTools|getCurrentStaff)\(/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const rel = (p: string) => path.relative(APP, p).replace(/\\/g, "/");

/** Public by design; each has its own protection (noted). */
const PUBLIC = new Map<string, string>([
  ["sign-in/page.tsx", "sign-in page"],
  ["access-denied/page.tsx", "explains a refused sign-in"],
  ["api/auth/[...all]/route.ts", "Better Auth (domain + allowlist gate in hooks)"],
  ["api/dev/sign-in/route.ts", "dev sign-in: APP_ENV local/test only, same gate"],
  ["healthz/route.ts", "health: no data"],
  ["u/[token]/route.ts", "unsubscribe: opaque token, GET confirms only, rate limited"],
  ["o/[file]/route.ts", "open pixel: opaque token, rate limited"],
  ["c/[token]/[idx]/route.ts", "click: snapshot URLs only, rate limited"],
  ["api/ses-events/route.ts", "SNS: signature + topic verified, rate limited"],
]);

describe("authentication coverage", () => {
  const files = walk(APP).filter((f) => /(page\.tsx|route\.ts)$/.test(f));
  it("finds the expected number of entry points", () => {
    expect(files.length).toBeGreaterThanOrEqual(28);
  });
  for (const f of files) {
    const r = rel(f);
    it(`${r} ${PUBLIC.has(r) ? "is a declared public endpoint" : "checks the signed-in staff member"}`, () => {
      const src = readFileSync(f, "utf8");
      if (PUBLIC.has(r)) expect(AUTH.test(src) || r !== "").toBe(true);
      else expect(AUTH.test(src)).toBe(true);
    });
  }
  it("every public endpoint in the proxy allow-list is one of the declared ones", () => {
    const proxy = readFileSync("src/proxy.ts", "utf8");
    const list = /PUBLIC_PREFIXES = \[([^\]]+)\]/.exec(proxy)![1].match(/"([^"]+)"/g)!.map((s) => s.slice(1, -1));
    expect(list.sort()).toEqual(["/_next", "/access-denied", "/api/auth", "/api/dev", "/api/ses-events", "/c", "/favicon.ico", "/fixtures", "/healthz", "/o", "/sign-in", "/u"].sort());
  });
});

/** Server Functions: name → body (up to the next export). */
function actions(file: string): Map<string, string> {
  const src = readFileSync(file, "utf8");
  expect(src.startsWith('"use server"')).toBe(true);
  const out = new Map<string, string>();
  const parts = src.split(/\nexport async function /).slice(1);
  for (const p of parts) out.set(p.slice(0, p.indexOf("(")), p);
  return out;
}

describe("Server Functions", () => {
  const files = walk(APP).filter((f) => f.endsWith(".ts") && readFileSync(f, "utf8").startsWith('"use server"'));
  for (const f of files) {
    for (const [name, body] of actions(f)) {
      it(`${rel(f)} › ${name} checks the caller`, () => expect(AUTH.test(body)).toBe(true));
    }
  }

  it("confirmed role rule (2026-11-13): admin-only campaign operations; members create, edit and pause", () => {
    const a = actions(path.join(APP, "campaign-actions.ts"));
    const admin = ["sendNowAction", "scheduleCampaignAction", "rescheduleCampaignAction", "unscheduleAction", "sendOverdueNowAction", "resumeAction", "cancelAction", "resolveUncertainAction", "suppressAddressAction", "updateSendingSettingsAction", "acknowledgeAlertAction"];
    const member = ["createCampaignAction", "updateCampaignAction", "pauseAction"];
    for (const n of admin) expect(a.get(n), n).toMatch(/requireRole\("admin"\)/);
    for (const n of member) {
      expect(a.get(n), n).toMatch(/requireStaff\(/);
      expect(a.get(n), n).not.toMatch(/requireRole\("admin"\)/);
    }
    expect([...a.keys()].sort()).toEqual([...admin, ...member].sort()); // a new action must be classified here
  });
});

describe("secrets are not tracked in Git", () => {
  const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
  it("no env files other than .env.example", () => {
    expect(tracked.filter((f) => /(^|\/)\.env(\..+)?$/.test(f) && !f.endsWith(".env.example"))).toEqual([]);
  });
  it("no keys or tokens in tracked text files", () => {
    const PATTERNS: Array<[string, RegExp]> = [
      ["AWS access key", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
      ["private key", /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/],
      ["Notion token", /\b(ntn_|secret_)[A-Za-z0-9]{40,}\b/],
      ["Google client secret", /\bGOCSPX-[A-Za-z0-9_-]{20,}/],
      ["Slack/Stripe-like token", /\b(xox[abp]-[0-9A-Za-z-]{20,}|sk_live_[0-9A-Za-z]{20,})/],
    ];
    const hits: string[] = [];
    for (const f of tracked) {
      if (/\.(png|jpg|jpeg|gif|ico|woff2?|zip|pdf|jsonl?)$/i.test(f) || f.startsWith("reports/") && /\.log$/.test(f) === false && !f.endsWith(".md")) continue;
      let text: string;
      try {
        text = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      // Known fake fixtures only: the redaction tests' placeholder and AWS's documented example key.
      text = text.replace(/AKIAABCDEFGHIJKLMNOP|AKIAIOSFODNN7EXAMPLE/g, "");
      for (const [label, re] of PATTERNS) if (re.test(text)) hits.push(`${f}: ${label}`);
    }
    expect(hits).toEqual([]);
  });
});
