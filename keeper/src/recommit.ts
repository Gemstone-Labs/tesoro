import type { PublicKey } from "@solana/web3.js";

/** Seconds a result waits for its commit to show on base before the keeper repeats it (the program's first repeat wait). */
export const RECOMMIT_AFTER_SECS = 120;
/** The wait between the keeper's own repeats; the program's own wait grows past this and refuses early calls. */
export const RECOMMIT_EVERY_SECS = 120;

interface RingSlot {
  state: number;
  tesoroMatch: PublicKey;
  epoch: number;
  at: number;
}
interface Ringed {
  ring: RingSlot[];
}
const DONE = 2;

/**
 * A Done result in the rollup table's ring that base's copy of the table does not hold. The rollup cannot read base's copy of its
 * own table, so it cannot tell a lost commit from a slow one; the keeper can (it reads base). The program refuses a repeat that
 * comes too soon or when no young result is left, so a wrong guess costs a refused transaction. `lastTry` is the keeper's own
 * last repeat for this table (seconds, 0 if none).
 */
export function needsRecommit(live: Ringed, base: Ringed | null, nowS: number, lastTry: number): boolean {
  if (nowS - lastTry < RECOMMIT_EVERY_SECS) return false;
  return live.ring.some(
    (s) =>
      s.state === DONE &&
      nowS - s.at >= RECOMMIT_AFTER_SECS &&
      !base?.ring.some((b) => b.state === DONE && b.epoch === s.epoch && b.tesoroMatch.equals(s.tesoroMatch)),
  );
}
