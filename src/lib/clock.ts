/**
 * Injectable clock. All time-dependent logic (heartbeats now; scheduling from M6)
 * takes a Clock so tests can control time instead of waiting for real dates.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class FixedClock implements Clock {
  constructor(private t: Date) {}
  now() {
    return new Date(this.t);
  }
  set(t: Date) {
    this.t = t;
  }
  advance(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
}
