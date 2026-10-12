import { COLUMNS, MATCH_SECS, NO_PICK, STEP_PPM, canPick, finish, lockAt, newTrack, record, settle, stepFor, type GridAsset, type GridResult, type Track } from "../grid";
import { botBand, botPickTimes } from "./gridBot";

/** A practice game against the local bot: seat 0 is you, seat 1 the bot. Pure state, driven by `stepGridSession`. */
export interface GridSession {
  startsAt: number;
  anchor: bigint;
  step: bigint;
  track: Track;
  picks: [number[], number[]];
  botAt: number[];
  final: GridResult | null;
}

const blank = () => Array.from({ length: COLUMNS }, () => NO_PICK);

/** `startsAt` in ms; the anchor is the price when the game starts. */
export function newGridSession(startsAt: number, anchor: bigint, asset: GridAsset, rng: () => number): GridSession {
  return {
    startsAt,
    anchor,
    step: stepFor(anchor, STEP_PPM[asset]),
    track: record(newTrack(), 0, anchor),
    picks: [blank(), blank()],
    botAt: botPickTimes(rng),
    final: null,
  };
}

/** Seconds since the start (fractional). */
export const elapsed = (s: GridSession, nowMs: number): number => (nowMs - s.startsAt) / 1000;

/** Your pick (or `NO_PICK` to clear it), or null when it is refused: the column has locked or the game is over. */
export function setPick(s: GridSession, column: number, band: number, nowMs: number): GridSession | null {
  const t = elapsed(s, nowMs);
  if (s.final || !canPick(column, t)) return null;
  const mine = [...s.picks[0]];
  mine[column] = band;
  return { ...s, picks: [mine, s.picks[1]] };
}

/**
 * One tick at oracle price `mid`: records the sample, lets the bot pick the columns it has made up
 * its mind about, and settles at the end of the window. `prices` is the recent public price
 * history in USD, one per second, newest last, which is all the bot sees.
 */
export function stepGridSession(s: GridSession, mid: bigint, nowMs: number, rng: () => number, prices: number[]): GridSession {
  if (s.final) return s;
  const t = elapsed(s, nowMs);
  if (t < 0) return s;
  if (t >= MATCH_SECS) {
    const track = finish(s.track);
    return { ...s, track, final: settle(track, s.picks, s.anchor, s.step) };
  }
  const bot = [...s.picks[1]];
  for (let c = 0; c < COLUMNS; c++) {
    if (bot[c] === NO_PICK && t >= s.botAt[c] && t < lockAt(c)) bot[c] = botBand(prices, columnAtMid(c) - t, s.anchor, s.step, rng);
  }
  return { ...s, track: record(s.track, t, mid), picks: [s.picks[0], bot] };
}

/** The middle of a column's window, which is where the bot aims. */
const columnAtMid = (c: number): number => 30 + 10 * c + 5;
