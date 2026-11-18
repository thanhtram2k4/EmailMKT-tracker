/** M8 public-endpoint abuse limits and proxy-aware client IPs. */
import { describe, expect, it } from "vitest";
import { clientIp, FixedWindowLimiter } from "../../src/lib/security/rate-limit";

describe("client IP from X-Forwarded-For", () => {
  const h = (xff?: string) => new Headers(xff ? { "x-forwarded-for": xff } : {});
  it("uses the entry appended by the trusted proxy (from the right), never the forgeable left-most one", () => {
    expect(clientIp(h("6.6.6.6, 203.0.113.7"), 1)).toBe("203.0.113.7");
    expect(clientIp(h("6.6.6.6, 203.0.113.7, 10.0.0.2"), 2)).toBe("203.0.113.7");
    expect(clientIp(h("203.0.113.7"), 1)).toBe("203.0.113.7");
  });
  it("no proxy configured or no header → unknown", () => {
    expect(clientIp(h("6.6.6.6"), 0)).toBeNull();
    expect(clientIp(h(), 1)).toBeNull();
    expect(clientIp(h("1.1.1.1"), 3)).toBeNull();
  });
});

describe("fixed-window limiter (controlled clock)", () => {
  it("allows the limit per minute per client and bucket, then 429 with Retry-After until the window ends", () => {
    let t = 0;
    const lim = new FixedWindowLimiter({ open: 3, click: 2, unsubscribe: 1, ses_events: 5 }, () => t);
    expect([1, 2, 3].map(() => lim.hit("open", "a").allowed)).toEqual([true, true, true]);
    expect(lim.hit("open", "a")).toEqual({ allowed: false, retryAfterS: 60 });
    expect(lim.hit("open", "b").allowed).toBe(true); // other client
    expect(lim.hit("click", "a").allowed).toBe(true); // other bucket
    t = 45_000;
    expect(lim.hit("open", "a")).toEqual({ allowed: false, retryAfterS: 15 });
    t = 60_000;
    expect(lim.hit("open", "a").allowed).toBe(true); // new window
    expect(lim.hit("unsubscribe", null).allowed).toBe(true);
    expect(lim.hit("unsubscribe", null).allowed).toBe(false); // unknown clients share one key
  });
});
