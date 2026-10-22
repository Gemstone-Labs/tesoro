import { PLAY_SECS, SLOTS_PER_SEC, secondsLeft, secondsToStart, type Table } from "./live-chain";

/**
 * The rollup's slot as the page knows it: the last slot read from the rollup and the `performance.now()` it was read at.
 * Everything the screen shows about time is the table's `start_slot` measured against this, never `Date.now()`.
 */
export interface SlotClock {
  slot: number;
  /** `performance.now()` when `slot` was read. */
  at: number;
  /** Slots per millisecond; 0 freezes the clock (Storybook). */
  rate: number;
}

export const sampleClock = (slot: number, at: number, rate = SLOTS_PER_SEC / 1000): SlotClock => ({ slot, at, rate });

/** The slot now, run forward from the last read. */
export const slotNow = (c: SlotClock, nowMs: number): number => c.slot + Math.floor(Math.max(0, nowMs - c.at) * c.rate);

/** Reads that land within this many slots of where the clock already is do not move it, so the timer never jitters backwards. */
export const CLOCK_TOLERANCE_SLOTS = 30;

/** The clock after a new read: kept when the read agrees with it, replaced when it does not (a stall, a reconnect). */
export function mergeClock(prev: SlotClock | null, read: SlotClock): SlotClock {
  if (!prev) return read;
  return Math.abs(slotNow(prev, read.at) - read.slot) <= CLOCK_TOLERANCE_SLOTS ? prev : read;
}

/** Milliseconds left of the 90 s run (0 before it starts and after it ends). */
export const runRemainingMs = (t: Table, c: SlotClock, nowMs: number): number => Math.round((secondsLeft(t, slotNow(c, nowMs)) ?? 0) * 1000);

/** Whole seconds until the run starts, rounded up, or null before `start`. */
export function getReadySecs(t: Table, c: SlotClock, nowMs: number): number | null {
  const s = secondsToStart(t, slotNow(c, nowMs));
  return s === null ? null : Math.ceil(s);
}

export { PLAY_SECS };
