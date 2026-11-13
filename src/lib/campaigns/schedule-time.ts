/**
 * Converting a scheduled local date-time in an IANA zone to UTC (DESIGN §4.2), with explicit handling
 * of daylight-saving transitions:
 *  - a local time that does not exist (spring-forward gap) is rejected, with the next valid time
 *    suggested;
 *  - a local time that occurs twice (fall-back overlap) is ambiguous: the user must choose the offset;
 *  - past times and times less than 2 minutes ahead are rejected.
 * Pure functions with an injected "now", so tests use a controlled clock.
 */
import { DateTime, IANAZone } from "luxon";

export const DEFAULT_TZ = "Asia/Ho_Chi_Minh";
export const MIN_LEAD_MS = 2 * 60_000;

export type ScheduleInput = { date: string; time: string; zone: string; offsetMinutes?: number | null };

export type ScheduleOption = { offsetMinutes: number; utc: Date; label: string };

export type ScheduleResolution =
  | { ok: true; utc: Date; zone: string; offsetMinutes: number; local: string; label: string }
  | {
      ok: false;
      code: "invalid_input" | "invalid_zone" | "nonexistent" | "ambiguous" | "past" | "too_soon";
      message: string;
      suggestion?: { date: string; time: string; label: string };
      options?: ScheduleOption[];
    };

export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const m = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** "20 Nov 2026, 09:00 (Asia/Ho_Chi_Minh, UTC+07:00)" */
export function formatInZone(d: Date, zone: string): string {
  const dt = DateTime.fromJSDate(d, { zone });
  return `${dt.toFormat("d LLL yyyy, HH:mm")} (${zone}, ${formatOffset(dt.offset)})`;
}

/** "02:00 UTC, 20 Nov 2026" */
export function formatUtc(d: Date): string {
  return `${DateTime.fromJSDate(d, { zone: "UTC" }).toFormat("HH:mm 'UTC', d LLL yyyy")}`;
}

/** Local date and time strings ("YYYY-MM-DD", "HH:mm") of an instant in a zone (for form defaults). */
export function localParts(d: Date, zone: string): { date: string; time: string } {
  const dt = DateTime.fromJSDate(d, { zone });
  return { date: dt.toFormat("yyyy-LL-dd"), time: dt.toFormat("HH:mm") };
}

export function isValidZone(zone: string): boolean {
  return typeof zone === "string" && zone.length < 64 && IANAZone.isValidZone(zone);
}

/** Every IANA zone the runtime knows, with the default first. */
export function listZones(): string[] {
  let zones: string[] = [];
  try {
    zones = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
  } catch {
    zones = [];
  }
  return [DEFAULT_TZ, "UTC", ...zones.filter((z) => z !== DEFAULT_TZ && z !== "UTC")];
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

export function resolveScheduleTime(i: ScheduleInput, now: Date): ScheduleResolution {
  const dm = DATE_RE.exec(i.date?.trim() ?? "");
  const tm = TIME_RE.exec(i.time?.trim() ?? "");
  if (!dm || !tm) return { ok: false, code: "invalid_input", message: "Enter a date (YYYY-MM-DD) and a time (HH:mm)." };
  const [y, mo, d, h, mi] = [Number(dm[1]), Number(dm[2]), Number(dm[3]), Number(tm[1]), Number(tm[2])];
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(naive);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59) {
    return { ok: false, code: "invalid_input", message: "That date or time does not exist." };
  }
  if (!isValidZone(i.zone)) return { ok: false, code: "invalid_zone", message: "Choose a time zone from the list." };
  const zone = IANAZone.create(i.zone);
  const local = `${dm[0]} ${tm[0]}`;

  // Every offset in force around this wall-clock time; a candidate is valid if that offset really
  // applies at the instant it produces (0 valid = DST gap, 2 valid = DST overlap).
  const offsets = [...new Set([-86_400_000, -10_800_000, 0, 10_800_000, 86_400_000].map((dt) => zone.offset(naive + dt)))];
  const valid = offsets.filter((o) => zone.offset(naive - o * 60_000) === o).sort((a, b) => b - a);

  let chosen: number;
  if (valid.length === 0) {
    const before = zone.offset(naive - 86_400_000);
    const s = DateTime.fromMillis(naive - before * 60_000, { zone: i.zone });
    return {
      ok: false,
      code: "nonexistent",
      message: `${local} does not exist in ${i.zone}: the clocks skip that hour (daylight saving starts).`,
      suggestion: { date: s.toFormat("yyyy-LL-dd"), time: s.toFormat("HH:mm"), label: `${s.toFormat("d LLL yyyy, HH:mm")} (${formatOffset(s.offset)})` },
    };
  }
  if (valid.length > 1) {
    const options = valid.map((o) => {
      const utc = new Date(naive - o * 60_000);
      return { offsetMinutes: o, utc, label: `${local} ${formatOffset(o)} = ${formatUtc(utc)}` };
    });
    if (i.offsetMinutes === undefined || i.offsetMinutes === null || !valid.includes(i.offsetMinutes)) {
      return { ok: false, code: "ambiguous", message: `${local} happens twice in ${i.zone} (daylight saving ends). Choose which one.`, options };
    }
    chosen = i.offsetMinutes;
  } else chosen = valid[0];

  const utc = new Date(naive - chosen * 60_000);
  if (utc.getTime() <= now.getTime()) return { ok: false, code: "past", message: "That time is in the past." };
  if (utc.getTime() - now.getTime() < MIN_LEAD_MS) return { ok: false, code: "too_soon", message: "Choose a time at least 2 minutes from now (or use Send now)." };
  return { ok: true, utc, zone: i.zone, offsetMinutes: chosen, local, label: `${local} (${i.zone}, ${formatOffset(chosen)}) = ${formatUtc(utc)}` };
}
