import Link from "next/link";
import { CalendarClock } from "lucide-react";
import { DEFAULT_TZ, formatOffset, listZones, localParts, resolveScheduleTime, type ScheduleResolution } from "../../../lib/campaigns/schedule-time";
import { rescheduleCampaignAction, scheduleCampaignAction } from "../../campaign-actions";
import { Alert } from "../../ui";

export type SchedParams = { sd?: string; st?: string; sz?: string; so?: string };

const qs = (id: string, p: Record<string, string | number | undefined>) =>
  `/campaigns/${id}?${Object.entries(p)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&")}#schedule`;

/** Form default: one hour from now, rounded up to 5 minutes, in the chosen zone. */
function defaultParts(zone: string) {
  return localParts(new Date(Math.ceil((Date.now() + 60 * 60_000) / 300_000) * 300_000), zone);
}

/** Step 1: pick a date, time and IANA zone (plain GET form; nothing changes until the confirmation). */
export function ScheduleTimeForm({ id, sp, mode }: { id: string; sp: SchedParams; mode: "schedule" | "reschedule" }) {
  const def = defaultParts(sp.sz || DEFAULT_TZ);
  return (
    <form method="get" action={`/campaigns/${id}#schedule`} className="row" data-testid="schedule-form">
      <label>
        Date
        <input type="date" name="sd" defaultValue={sp.sd ?? def.date} required data-testid="schedule-date" />
      </label>
      <label>
        Time
        <input type="time" name="st" defaultValue={sp.st ?? def.time} required data-testid="schedule-time" />
      </label>
      <label>
        Time zone
        <select name="sz" defaultValue={sp.sz || DEFAULT_TZ} data-testid="schedule-zone">
          {listZones().map((z) => (
            <option key={z} value={z}>
              {z === DEFAULT_TZ ? `${z} (UTC+07:00)` : z}
            </option>
          ))}
        </select>
      </label>
      <button className="btn" type="submit" data-testid="schedule-check">
        <CalendarClock className="icon-sm" aria-hidden /> {mode === "schedule" ? "Review schedule" : "Review new time"}
      </button>
    </form>
  );
}

export function resolveFromParams(sp: SchedParams): ScheduleResolution | null {
  if (!sp.sd || !sp.st) return null;
  const so = sp.so && /^-?\d{1,4}$/.test(sp.so) ? Number(sp.so) : null;
  return resolveScheduleTime({ date: sp.sd, time: sp.st, zone: sp.sz || DEFAULT_TZ, offsetMinutes: so }, new Date());
}

/** Step 2: errors with a way forward, or the confirmation summary (DESIGN §4.2 "Confirmation screen"). */
export function SchedulePreview(p: {
  id: string;
  sp: SchedParams;
  mode: "schedule" | "reschedule";
  recipients: number;
  revision: number;
  fromAddress: string | null;
  subject: string | null;
  ratePerSecond: number;
}) {
  const r = resolveFromParams(p.sp);
  if (!r) return null;
  const zone = p.sp.sz || DEFAULT_TZ;
  if (!r.ok) {
    return (
      <Alert tone="bad" testId="schedule-error" title="This time cannot be used.">
        {r.message}
        {r.suggestion && (
          <>
            {" "}
            <Link href={qs(p.id, { sd: r.suggestion.date, st: r.suggestion.time, sz: zone })} data-testid="schedule-suggestion">
              Use {r.suggestion.label} instead
            </Link>
          </>
        )}
        {r.options && (
          <ul className="plain" data-testid="schedule-options">
            {r.options.map((o) => (
              <li key={o.offsetMinutes}>
                <Link href={qs(p.id, { sd: p.sp.sd, st: p.sp.st, sz: zone, so: o.offsetMinutes })} data-testid="schedule-option">
                  {o.label}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Alert>
    );
  }
  const seconds = Math.ceil(p.recipients / Math.max(0.1, p.ratePerSecond));
  const span = seconds < 90 ? `about ${seconds} s` : `about ${Math.round(seconds / 60)} min`;
  return (
    <div className="card" data-testid="schedule-summary">
      <h3 className="mt0">Confirm {p.mode === "schedule" ? "the schedule" : "the new time"}</h3>
      <dl className="kv">
        <dt>Starts</dt>
        <dd data-testid="schedule-local">
          <strong>
            {r.local} ({r.zone}, {formatOffset(r.offsetMinutes)})
          </strong>
        </dd>
        <dt>In UTC</dt>
        <dd data-testid="schedule-utc">{r.utc.toISOString().replace("T", " ").slice(0, 16)} UTC</dd>
        <dt>Sender</dt>
        <dd>{p.fromAddress ? <code>{p.fromAddress}</code> : "—"}</dd>
        <dt>Recipients</dt>
        <dd>{p.recipients}</dd>
        <dt>Subject</dt>
        <dd>{p.subject ? <code>{p.subject}</code> : "—"}</dd>
      </dl>
      <p className="small">
        This is when <strong>processing starts</strong>. Messages then go out at {p.ratePerSecond}/s, so the last one is sent {span} later. The worker sends it even if every browser is closed.
        {p.mode === "schedule" && " Approving freezes the content and recipient list now; suppression and consent are checked again before each message."}
      </p>
      <form action={p.mode === "schedule" ? scheduleCampaignAction : rescheduleCampaignAction} className="stack">
        <input type="hidden" name="campaignId" value={p.id} />
        <input type="hidden" name="date" value={p.sp.sd} />
        <input type="hidden" name="time" value={p.sp.st} />
        <input type="hidden" name="zone" value={zone} />
        <input type="hidden" name="offsetMinutes" value={String(r.offsetMinutes)} />
        <input type="hidden" name="expectedRevision" value={p.revision} />
        <input type="hidden" name="expectedRecipients" value={p.recipients} />
        <label className="check">
          <input type="checkbox" name="confirm" value="yes" required data-testid="schedule-confirm" />
          <span>
            {p.mode === "schedule" ? "Schedule this campaign" : "Move the campaign"} to start at {r.local} ({r.zone}).
          </span>
        </label>
        <div className="row">
          <button className="btn primary" type="submit" data-testid="schedule-submit">
            <CalendarClock className="icon-sm" aria-hidden /> {p.mode === "schedule" ? "Confirm schedule" : "Confirm new time"}
          </button>
        </div>
      </form>
    </div>
  );
}
