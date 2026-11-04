import type { PublicKey } from "@solana/web3.js";
import { burstEndState, duelEndState, holdemEndState, vanguardEndState } from "../../app/src/server/history/end-boards.ts";
import { recordEndState, type EndState } from "../../app/src/server/history/end-state.ts";
import type { Rpc } from "../../app/src/server/history/rpc.ts";
import { log } from "./act.ts";
import { historyRpc } from "./history.ts";

/**
 * The public end state of a finished table Match, kept in the Match history (migration 0013) because the next Match on the
 * table replaces it (on base at its commit, in the rollup at the reset).
 *
 * One pure function per Game turns the table into JSON. ONLY what is public at Match end goes in: never a seat account, never
 * a card that was not shown. To add a Game: write its function, add one entry to `CAPTURE`, and call
 * `resetMayProceed` before its `reset_table` (see docs/games/table-protocol.md, "End state").
 */

export { burstEndState, duelEndState, holdemEndState, vanguardEndState };

/** Per-Game capture functions. */
export const CAPTURE = {
  "trading-duel": duelEndState,
  holdem: holdemEndState,
  "block-puzzle": burstEndState,
  vanguard: vanguardEndState,
} as const;

/** A table held for capture is reset anyway after this many rollup seconds Over: a database outage must not hold a table forever. */
export const CAPTURE_GIVE_UP_SECS = 900;

/** Matches already stored by this process (the database also refuses a second write). */
const captured = new Set<string>();

interface Capturable<T> {
  tesoroMatch: PublicKey;
  epoch: number;
  fn: (t: T) => EndState | null;
  table: T;
}

/**
 * Called by a table's upkeep right before it would send `reset_table`. Stores the Match's end state, then says the reset may go.
 * The reset therefore cannot overtake the capture: it is the same step, and a failed write keeps the table (the next pass retries)
 * until `CAPTURE_GIVE_UP_SECS` after the result. With no database configured there is nothing to wait for.
 */
export async function resetMayProceed<T>(c: Capturable<T>, sinceOver: number, rpc: Rpc | null = historyRpc(), subject = "table"): Promise<boolean> {
  if (!rpc) return true;
  const match = c.tesoroMatch.toBase58();
  if (captured.has(match)) return true;
  try {
    const state = c.fn(c.table);
    if (state) await recordEndState(rpc, match, c.epoch, state);
    captured.add(match);
    return true;
  } catch (e) {
    const giveUp = sinceOver >= CAPTURE_GIVE_UP_SECS;
    log("history", subject, `${giveUp ? "WARN end state lost, resetting anyway" : "end state not stored, reset waits"}: ${String((e as Error).message ?? e).split("\n")[0].slice(0, 160)}`);
    return giveUp;
  }
}

export const _resetCaptured = () => captured.clear();
