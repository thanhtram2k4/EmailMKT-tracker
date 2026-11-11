import { describe, expect, it } from "vitest";
import { FixedClock } from "../../src/lib/clock";

describe("FixedClock", () => {
  it("is controllable for time-dependent tests", () => {
    const c = new FixedClock(new Date("2026-11-12T00:00:00Z"));
    c.advance(61_000);
    expect(c.now().toISOString()).toBe("2026-11-12T00:01:01.000Z");
  });
});
