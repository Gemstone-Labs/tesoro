import { runLogOf, type Table as BurstTable } from "../../games/block-puzzle/live-chain";
import type { Table as HoldemTable } from "../../games/holdem/chain";
import type { Table as DuelTable } from "../../games/trading-duel/chain";
import { UNSET, type Battle as VanguardBattle } from "../../games/vanguard/decode";
import type { EndState } from "./end-state";

/**
 * One pure function per Game turns its table into the public end state stored in the Match history (migration 0013). ONLY what is
 * public at Match end goes in: never a seat account, never a card that was not shown. Used by the webhook capture
 * (end-capture.ts) and by the keeper's older scheduler capture.
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
  const l = runLogOf(t, t.tesoroMatch, t.epoch);
  return {
    game: "block-puzzle",
    scores: [t.finalScores[0], t.finalScores[1]],
    moves: [t.finalMoves[0], t.finalMoves[1]],
    reason: t.reason,
    log: l ? { seed: l.seed.toString(), seedHash: hex(l.seedHash), startSlot: l.startSlot, moves: hex(l.moves), offsets: hex(l.offsets) } : null,
  };
}

/**
 * Vanguard's end board: the public Battle at the end (positions, the ranks the end reveal showed, the end mask). Never an Army:
 * the keeper does not read them. A Match that was never dealt has no board.
 */
export function vanguardEndState(b: VanguardBattle): EndState | null {
  if (b.usSeat === UNSET) return null;
  return {
    game: "vanguard",
    usSeat: b.usSeat,
    winner: b.winner,
    reason: b.reason,
    moves: b.moves,
    turnNo: b.turnNo,
    sq: [...b.sq],
    shown: [...b.shown],
    endMask: b.endMask.toString(),
    depotClaimed: [b.depotClaimed[0], b.depotClaimed[1]],
    players: [b.players[0].toBase58(), b.players[1].toBase58()],
  };
}

