/**
 * Clock port. The core never reads the wall clock directly for decisions: time comes in through a
 * Clock, so schedulers, leases and audit entries are deterministic under test.
 */
export interface Clock {
  now(): string;
}

/** The host's wall clock (Date is an ECMAScript built-in, available on every runtime). */
export const systemClock: Clock = { now: () => new Date().toISOString() };

/** A clock that only moves when told to — for tests and replays. */
export function manualClock(start: string): Clock & { set(t: string): void; advance(ms: number): void } {
  let t = start;
  return {
    now: () => t,
    set: (x) => {
      t = x;
    },
    advance: (ms) => {
      t = new Date(Date.parse(t) + ms).toISOString();
    },
  };
}
