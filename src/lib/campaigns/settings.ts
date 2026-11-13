/**
 * Runtime sending settings (app_settings, audited). Admin-editable on /settings/sending.
 *  - sending.rate_per_second       default 5, capped below the SES account max rate at dispatch;
 *  - sending.quota_reserve_pct     default 10: share of the SES daily quota never used by campaigns;
 *  - sending.live_campaigns_enabled default false; can only be switched on when APP_ENV=production.
 *  - scheduling.grace_minutes      default 30 (M6): a scheduled campaign that starts later than this
 *                                  (e.g. after an outage) is held for an admin instead of being sent.
 *  - tracking.mode                 default "consented_only" (M7, pending counsel — COMPLIANCE §3.3):
 *                                  open/click tracking only for addresses with recorded email_tracking
 *                                  consent; "all" tracks everyone; "off" tracks no one.
 */
import { inArray } from "drizzle-orm";
import { writeAudit } from "../audit";
import type { AppEnv } from "../config";
import type { Db } from "../db/client";
import { appSettings } from "../db/schema";

export const RATE_KEY = "sending.rate_per_second";
export const RESERVE_KEY = "sending.quota_reserve_pct";
export const LIVE_KEY = "sending.live_campaigns_enabled";
export const GRACE_KEY = "scheduling.grace_minutes";
export const TRACKING_KEY = "tracking.mode";
export const TRACKING_MODES = ["all", "consented_only", "off"] as const;
export type TrackingMode = (typeof TRACKING_MODES)[number];
export const DEFAULT_TRACKING_MODE: TrackingMode = "consented_only";
export const DEFAULT_GRACE_MINUTES = 30;
export const GRACE_MIN = 5;
export const GRACE_MAX = 240;

export const DEFAULT_RATE = 5;
export const DEFAULT_RESERVE_PCT = 10;
export const RATE_MIN = 0.1;
export const RATE_MAX = 50;
export const RESERVE_MAX = 90;

export type SendSettings = { ratePerSecond: number; quotaReservePct: number; liveCampaignsEnabled: boolean; graceMinutes: number; trackingMode: TrackingMode };

type DbLike = Pick<Db, "select">;

export async function getSendSettings(db: DbLike): Promise<SendSettings> {
  const rows = await db.select().from(appSettings).where(inArray(appSettings.key, [RATE_KEY, RESERVE_KEY, LIVE_KEY, GRACE_KEY, TRACKING_KEY]));
  const v = (k: string) => rows.find((r) => r.key === k)?.value;
  const rate = Number(v(RATE_KEY));
  const reserve = Number(v(RESERVE_KEY));
  const grace = Number(v(GRACE_KEY));
  return {
    ratePerSecond: Number.isFinite(rate) && rate >= RATE_MIN && rate <= RATE_MAX ? rate : DEFAULT_RATE,
    quotaReservePct: Number.isFinite(reserve) && reserve >= 0 && reserve <= RESERVE_MAX ? reserve : DEFAULT_RESERVE_PCT,
    liveCampaignsEnabled: v(LIVE_KEY) === true,
    graceMinutes: Number.isInteger(grace) && grace >= GRACE_MIN && grace <= GRACE_MAX ? grace : DEFAULT_GRACE_MINUTES,
    trackingMode: (TRACKING_MODES as readonly unknown[]).includes(v(TRACKING_KEY)) ? (v(TRACKING_KEY) as TrackingMode) : DEFAULT_TRACKING_MODE,
  };
}

export class SettingsError extends Error {}

export async function updateSendSettings(
  db: Db,
  i: { ratePerSecond?: number; quotaReservePct?: number; liveCampaignsEnabled?: boolean; graceMinutes?: number; trackingMode?: TrackingMode; actor: string; appEnv: AppEnv; correlationId?: string },
) {
  const before = await getSendSettings(db);
  const writes: Array<[string, unknown]> = [];
  if (i.ratePerSecond !== undefined) {
    if (!Number.isFinite(i.ratePerSecond) || i.ratePerSecond < RATE_MIN || i.ratePerSecond > RATE_MAX) {
      throw new SettingsError(`Rate must be between ${RATE_MIN} and ${RATE_MAX} messages per second.`);
    }
    writes.push([RATE_KEY, i.ratePerSecond]);
  }
  if (i.quotaReservePct !== undefined) {
    if (!Number.isFinite(i.quotaReservePct) || i.quotaReservePct < 0 || i.quotaReservePct > RESERVE_MAX) {
      throw new SettingsError(`Quota reserve must be between 0 and ${RESERVE_MAX}%.`);
    }
    writes.push([RESERVE_KEY, i.quotaReservePct]);
  }
  if (i.graceMinutes !== undefined) {
    if (!Number.isInteger(i.graceMinutes) || i.graceMinutes < GRACE_MIN || i.graceMinutes > GRACE_MAX) {
      throw new SettingsError(`The late-start grace period must be a whole number of minutes between ${GRACE_MIN} and ${GRACE_MAX}.`);
    }
    writes.push([GRACE_KEY, i.graceMinutes]);
  }
  if (i.trackingMode !== undefined) {
    if (!(TRACKING_MODES as readonly string[]).includes(i.trackingMode)) throw new SettingsError("Unknown tracking mode.");
    writes.push([TRACKING_KEY, i.trackingMode]);
  }
  if (i.liveCampaignsEnabled !== undefined) {
    if (i.liveCampaignsEnabled && i.appEnv !== "production") {
      throw new SettingsError(`Live customer campaigns can only be enabled in production (APP_ENV=${i.appEnv}).`);
    }
    writes.push([LIVE_KEY, i.liveCampaignsEnabled]);
  }
  for (const [key, value] of writes) {
    await db
      .insert(appSettings)
      .values({ key, value, updatedBy: i.actor })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedBy: i.actor, updatedAt: new Date() } });
  }
  const after = await getSendSettings(db);
  await writeAudit(db, { actor: i.actor, action: "settings.sending_updated", entityType: "settings", entityId: "sending", before, after, correlationId: i.correlationId });
  return after;
}
