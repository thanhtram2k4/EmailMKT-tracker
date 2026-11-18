/**
 * M8 abuse limits for the public endpoints (/o, /c, /u, /api/ses-events). Fixed one-minute windows per
 * (bucket, client) in process memory: enough for the single web instance planned on Render; several
 * instances would each count separately (documented in docs/RUNBOOK.md).
 *
 * Client identity: the IP is taken from X-Forwarded-For counted from the RIGHT by TRUSTED_PROXY_HOPS
 * (the entries our own hosting proxy appended). The left-most entries are client-supplied and can be
 * forged, so they are never used. With TRUSTED_PROXY_HOPS=0 (no proxy) the client is unknown and all
 * requests share one key per bucket.
 */
export type Bucket = "open" | "click" | "unsubscribe" | "ses_events";

export const LIMITS_PER_MINUTE: Record<Bucket, number> = {
  open: 600,
  click: 300,
  unsubscribe: 60,
  ses_events: 3000,
};

export function clientIp(headers: Headers, trustedProxyHops: number): string | null {
  if (trustedProxyHops <= 0) return null;
  const xff = headers.get("x-forwarded-for");
  if (!xff) return null;
  const hops = xff
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ip = hops[hops.length - trustedProxyHops];
  return ip && ip.length <= 64 ? ip : null;
}

type Window = { start: number; count: number };

export class FixedWindowLimiter {
  private windows = new Map<string, Window>();
  constructor(
    private readonly limits: Record<Bucket, number> = LIMITS_PER_MINUTE,
    private readonly now: () => number = () => Date.now(),
    private readonly windowMs = 60_000,
  ) {}

  /** Count one request; returns whether it is allowed and, if not, the seconds until the window resets. */
  hit(bucket: Bucket, client: string | null): { allowed: boolean; retryAfterS: number } {
    const t = this.now();
    const key = `${bucket}:${client ?? "unknown"}`;
    let w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      w = { start: t, count: 0 };
      this.windows.set(key, w);
      if (this.windows.size > 50_000) this.prune(t);
    }
    w.count++;
    const allowed = w.count <= this.limits[bucket];
    return { allowed, retryAfterS: allowed ? 0 : Math.max(1, Math.ceil((w.start + this.windowMs - t) / 1000)) };
  }

  private prune(t: number) {
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
  }
}

const holder = ((globalThis as Record<string, unknown>).__emtRateLimiter ??= {}) as { limiter?: FixedWindowLimiter };
export const publicLimiter = (): FixedWindowLimiter => (holder.limiter ??= new FixedWindowLimiter());

export const tooManyRequests = (retryAfterS: number) =>
  new Response("Too many requests", { status: 429, headers: { "retry-after": String(retryAfterS), "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" } });
