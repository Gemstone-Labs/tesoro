import type { PublicKey } from "@solana/web3.js";
import type { Table as BurstTable } from "../../app/src/games/block-puzzle/live-chain.ts";
import type { Table as HoldemTable } from "../../app/src/games/holdem/chain.ts";
import type { Table as DuelTable } from "../../app/src/games/trading-duel/chain.ts";
import { NO_PICK } from "../../app/src/games/trading-duel/grid.ts";
import { recordEndState, type EndState } from "../../app/src/server/history/end-state.ts";
import type { Rpc } from "../../app/src/server/history/rpc.ts";
import { log } from "./act.ts";
import { historyRpc } from "./history.ts";

/**
 * The public end state of a finished table Match, kept in the Match history (migration 0010) because the next Match on the
 * table replaces it (on base at its commit, in the rollup at the reset).
 *
 * One pure function per Game turns the table into JSON. ONLY what is public at Match end goes in: never a seat account, never
 * a card that was not shown. To add a Game (Vanguard, ticket 14): write its function, add one entry to `CAPTURE`, and call
 * `resetMayProceed` before its `reset_table` (see docs/games/table-protocol.md, "End state").
 */

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

export function duelEndState(t: DuelTable): EndState | null {
  if (t.startsAt === 0) return null; // the Match never started: no board
  return {
    game: "trading-duel",
    track: { lo: t.track.lo.map(String), hi: t.track.hi.map(String), seen: [...t.track.seen] },
    picks: [[...t.revealed[0]], [...t.revealed[1]]],
    scores: [t.scores[0], t.scores[1]],
    winner: t.winner,
  };
}

export function holdemEndState(t: HoldemTable): EndState {
  const h = t.lastHand;
  return {
    game: "holdem",
    handNo: h.handNo,
    result: h.result,
    pot: h.pot.toString(),
    board: h.board.filter((c) => c < 52),
    shown: h.showdown ? [[h.shown[0][0], h.shown[0][1]], [h.shown[1][0], h.shown[1][1]]] : null,
    stacks: [t.stacks[0].toString(), t.stacks[1].toString()],
    winner: t.winner,
  };
}

export function burstEndState(t: BurstTable): EndState | null {
  if (t.startSlot === 0) return null; // the run never started: no scores
  const l = t.logs.find((x) => x.startSlot === t.startSlot) ?? null;
  return {
    game: "block-puzzle",
    scores: [t.finalScores[0], t.finalScores[1]],
    moves: [t.finalMoves[0], t.finalMoves[1]],
    reason: t.reason,
    log: l ? { seed: l.seed.toString(), seedHash: hex(l.seedHash), startSlot: l.startSlot, moves: hex(l.moves), offsets: hex(l.offsets) } : null,
  };
}

/** Per-Game capture functions. Vanguard adds its entry here. */
export const CAPTURE = {
  "trading-duel": duelEndState,
  holdem: holdemEndState,
  "block-puzzle": burstEndState,
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
