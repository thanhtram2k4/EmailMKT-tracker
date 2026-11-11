/**
 * Token-bucket rate limiter. Notion allows ~3 requests/s on average per connection
 * (180/min on most plans); we default to 2.5/s with a small burst to stay below it.
 * Time and sleeping are injectable so tests can run on a virtual clock.
 */
export type TimeSource = { now(): number; sleep(ms: number): Promise<void> };

export const realTime: TimeSource = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** A virtual clock: sleep() advances time instantly. Records every sleep for assertions. */
export class VirtualTime implements TimeSource {
  readonly sleeps: number[] = [];
  constructor(private t = 0) {}
  now() {
    return this.t;
  }
  async sleep(ms: number) {
    this.sleeps.push(ms);
    this.t += ms;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

export class TokenBucket {
  private tokens: number;
  private last: number;
  /** Serializes acquirers so concurrent callers cannot overdraw the bucket. */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    private readonly time: TimeSource = realTime,
  ) {
    this.tokens = burst;
    this.last = time.now();
  }

  private refill() {
    const now = this.time.now();
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSec);
    this.last = now;
  }

  acquire(): Promise<void> {
    const next = this.chain.then(async () => {
      this.refill();
      if (this.tokens < 1) {
        const waitMs = Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000);
        await this.time.sleep(waitMs);
        this.refill();
      }
      this.tokens -= 1;
    });
    this.chain = next.catch(() => {});
    return next;
  }

  /** Called after a 429: drain the bucket so the next request waits a full interval. */
  penalize() {
    this.tokens = Math.min(this.tokens, 0);
    this.last = this.time.now();
  }
}
