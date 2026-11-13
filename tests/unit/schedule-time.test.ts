/** M6 scheduling regression R-SCH-01…04 (pure time conversion with a controlled "now"). */
import { describe, expect, it } from "vitest";
import { DEFAULT_TZ, formatInZone, formatOffset, listZones, localParts, resolveScheduleTime } from "../../src/lib/campaigns/schedule-time";

const NOW = new Date("2026-01-01T00:00:00Z");

describe("R-SCH-01: Asia/Ho_Chi_Minh local → UTC → display round trip", () => {
  it("09:00 in Ho Chi Minh is 02:00 UTC and displays back identically", () => {
    const r = resolveScheduleTime({ date: "2026-11-20", time: "09:00", zone: DEFAULT_TZ }, NOW);
    expect(r).toMatchObject({ ok: true, utc: new Date("2026-11-20T02:00:00Z"), offsetMinutes: 420, local: "2026-11-20 09:00" });
    if (!r.ok) throw new Error("unreachable");
    expect(localParts(r.utc, DEFAULT_TZ)).toEqual({ date: "2026-11-20", time: "09:00" });
    expect(formatInZone(r.utc, DEFAULT_TZ)).toBe("20 Nov 2026, 09:00 (Asia/Ho_Chi_Minh, UTC+07:00)");
  });
  it("crosses midnight correctly (00:30 local = 17:30 UTC the day before)", () => {
    expect(resolveScheduleTime({ date: "2026-11-21", time: "00:30", zone: DEFAULT_TZ }, NOW)).toMatchObject({ ok: true, utc: new Date("2026-11-20T17:30:00Z") });
  });
  it("defaults the zone list to Ho Chi Minh first", () => {
    expect(listZones()[0]).toBe(DEFAULT_TZ);
    expect(listZones()).toContain("America/New_York");
  });
});

describe("R-SCH-02: non-default zone round trip", () => {
  for (const [zone, date, time, utc, off] of [
    ["Europe/London", "2026-07-01", "09:00", "2026-07-01T08:00:00Z", 60],
    ["Europe/London", "2026-12-01", "09:00", "2026-12-01T09:00:00Z", 0],
    ["Asia/Kolkata", "2026-06-01", "10:15", "2026-06-01T04:45:00Z", 330],
    ["America/New_York", "2026-06-01", "08:00", "2026-06-01T12:00:00Z", -240],
  ] as const) {
    it(`${zone} ${date} ${time}`, () => {
      const r = resolveScheduleTime({ date, time, zone }, NOW);
      expect(r).toMatchObject({ ok: true, utc: new Date(utc), offsetMinutes: off });
      if (r.ok) expect(localParts(r.utc, zone)).toEqual({ date, time });
    });
  }
});

describe("R-SCH-03: DST gap rejected; DST overlap requires an offset choice (America/New_York)", () => {
  it("02:30 on 8 Mar 2026 does not exist; 03:30 is suggested", () => {
    const r = resolveScheduleTime({ date: "2026-03-08", time: "02:30", zone: "America/New_York" }, NOW);
    expect(r).toMatchObject({ ok: false, code: "nonexistent", suggestion: { date: "2026-03-08", time: "03:30" } });
  });
  it("01:30 on 1 Nov 2026 happens twice; both offsets are offered and either can be chosen", () => {
    const r = resolveScheduleTime({ date: "2026-11-01", time: "01:30", zone: "America/New_York" }, NOW);
    expect(r).toMatchObject({ ok: false, code: "ambiguous" });
    if (r.ok || !r.options) throw new Error("expected options");
    expect(r.options.map((o) => [o.offsetMinutes, o.utc.toISOString()])).toEqual([
      [-240, "2026-11-01T05:30:00.000Z"],
      [-300, "2026-11-01T06:30:00.000Z"],
    ]);
    expect(resolveScheduleTime({ date: "2026-11-01", time: "01:30", zone: "America/New_York", offsetMinutes: -240 }, NOW)).toMatchObject({ ok: true, utc: new Date("2026-11-01T05:30:00Z") });
    expect(resolveScheduleTime({ date: "2026-11-01", time: "01:30", zone: "America/New_York", offsetMinutes: -300 }, NOW)).toMatchObject({ ok: true, utc: new Date("2026-11-01T06:30:00Z") });
    // An offset that does not apply is not accepted silently.
    expect(resolveScheduleTime({ date: "2026-11-01", time: "01:30", zone: "America/New_York", offsetMinutes: 420 }, NOW)).toMatchObject({ ok: false, code: "ambiguous" });
  });
  it("times next to the transitions are unambiguous", () => {
    expect(resolveScheduleTime({ date: "2026-03-08", time: "03:00", zone: "America/New_York" }, NOW)).toMatchObject({ ok: true, offsetMinutes: -240 });
    expect(resolveScheduleTime({ date: "2026-11-01", time: "02:00", zone: "America/New_York" }, NOW)).toMatchObject({ ok: true, offsetMinutes: -300 });
  });
});

describe("R-SCH-04: past and too-soon times are rejected", () => {
  const now = new Date("2026-11-20T02:00:00Z"); // 09:00 Ho Chi Minh
  const at = (time: string) => resolveScheduleTime({ date: "2026-11-20", time, zone: DEFAULT_TZ }, now);
  it("past and exactly now are rejected", () => {
    expect(at("08:59")).toMatchObject({ ok: false, code: "past" });
    expect(at("09:00")).toMatchObject({ ok: false, code: "past" });
  });
  it("less than 2 minutes ahead is rejected; exactly 2 minutes is accepted", () => {
    expect(at("09:01")).toMatchObject({ ok: false, code: "too_soon" });
    expect(at("09:02")).toMatchObject({ ok: true });
  });
  it("invalid input and unknown zones are rejected", () => {
    expect(resolveScheduleTime({ date: "2026-02-30", time: "09:00", zone: DEFAULT_TZ }, NOW)).toMatchObject({ ok: false, code: "invalid_input" });
    expect(resolveScheduleTime({ date: "2026-11-20", time: "24:00", zone: DEFAULT_TZ }, NOW)).toMatchObject({ ok: false, code: "invalid_input" });
    expect(resolveScheduleTime({ date: "20/11/2026", time: "09:00", zone: DEFAULT_TZ }, NOW)).toMatchObject({ ok: false, code: "invalid_input" });
    expect(resolveScheduleTime({ date: "2026-11-20", time: "09:00", zone: "Asia/Saigon-Typo" }, NOW)).toMatchObject({ ok: false, code: "invalid_zone" });
  });
  it("formats offsets", () => {
    expect([formatOffset(420), formatOffset(-300), formatOffset(330), formatOffset(0)]).toEqual(["UTC+07:00", "UTC-05:00", "UTC+05:30", "UTC+00:00"]);
  });
});
