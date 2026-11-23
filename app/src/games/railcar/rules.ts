// The Railcar numbers Players read in Help, Docs, Risks and Terms (rules round 2, decisions Q40).
// Every figure comes from the engine, so a page can never drift from the rules.
import { BOLT_LEAD, BOLT_SHOWS, BRAKE_MS, MAX_CRASH_MS, MEDIAN_MS, MIN_CRASH_MS, SCREW_LEAD, SPARK_LEAD, SPARK_SHOWS, placeSharesBps, refund, split } from "./engine";

export const ENTRY_GEMAS = 100n;
export const MIN_PLAYERS = 5;
export const MAX_PLAYERS = 100;
export const COUNTDOWN_SECONDS = 30;
/** Platform 2% + Studio 3% + Leaderboard 1%, taken from the Pot at settlement, out of the forfeited entries. */
export const FEE_BPS = 600n;

const s = (ms: number) => ms / 1000;
const median = s(Number(MEDIAN_MS));

/** The share of rides still running `sec` seconds in: a Weibull of shape 2 after the safe part (the engine's curve). */
const survives = (sec: number) => (sec <= s(MIN_CRASH_MS) ? 1 : Math.pow(2, -(((sec - s(MIN_CRASH_MS)) / median) ** 2)));
/** The second by which `share` of rides are over. */
const secondsBy = (share: number) => s(MIN_CRASH_MS) + median * Math.sqrt(-Math.log2(1 - share));

/**
 * The odds a Player can count on: no Bomb in the safe part, half of rides over by the median, 9 in 10 by `nineInTenSeconds`,
 * one ride in `pastMinuteOneIn` past a minute, none past the cap at full speed.
 */
export function crashOdds() {
  return {
    safeSeconds: s(MIN_CRASH_MS),
    medianSeconds: s(MIN_CRASH_MS) + median,
    nineInTenSeconds: Math.round(secondsBy(0.9)),
    pastMinuteOneIn: Math.round(1 / survives(60)),
    certainSeconds: s(MAX_CRASH_MS),
    brakeSeconds: s(BRAKE_MS),
  };
}

/** The chance, in 100, that the Bomb goes off in the next whole second for a car `sec` seconds in: it rises in a straight line. */
export const chanceInNextSecond = (sec: number): number => Math.round(1000 * (1 - survives(sec + 1) / survives(sec))) / 10;

/** Rows of [seconds in, chance in the next second] at the seconds the docs quote. */
export function chanceRows(): [string, string][] {
  return [10, 25, 45].map((sec) => [`${sec} s`, `${chanceInNextSecond(sec)} in 100`]);
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
/** "3 rides in 4" for a chance of `n` in `of`, in lowest terms. */
const ridesIn = (n: number, of: number) => {
  const d = gcd(n, of);
  return `${n / d} ride${n / d === 1 ? "" : "s"} in ${of / d}`;
};

/** The Tells: how often a ride shows each (later Tells are not promised, decisions Q39) and how far ahead of the Bomb. */
export function tellRows() {
  const range = ([lo, hi]: readonly [number, number]) => `${s(lo)} to ${s(hi)} seconds`;
  return [
    { name: "Loose screws", shows: "Every ride", range: range(SCREW_LEAD) },
    { name: "A loose bolt and a rattling panel", shows: ridesIn(...BOLT_SHOWS), range: range(BOLT_LEAD) },
    { name: "Sparks and a creak", shows: ridesIn(...SPARK_SHOWS), range: range(SPARK_LEAD) },
  ];
}

/** What a Player can count on from the Tells: the sparks' floor when they show, and how often the screws are the only Tell. */
export function tellOdds() {
  const [bolt, boltOf] = BOLT_SHOWS;
  const [spark, sparkOf] = SPARK_SHOWS;
  return { sparksFloorSeconds: s(SPARK_LEAD[0]), screwsOnly: ridesIn((boltOf - bolt) * (sparkOf - spark), boltOf * sparkOf) };
}

export function payoutRows(): [string, string][] {
  const fmt = (placed: number) =>
    placeSharesBps(placed)
      .filter((b) => b > 0)
      .map((b) => `${b / 100}%`)
      .join(" / ");
  return [
    ["Three or more", fmt(3)],
    ["Two", fmt(2)],
    ["One", "All of it"],
  ];
}

/** Ana, Ben, Cy, Dee and Eve each enter 100; Ana Jumps at 8 s and gets nothing; Dee, Ben, Cy are the last three off. */
export function workedExample() {
  const entries = ENTRY_GEMAS * 5n;
  const anaRefund = refund(ENTRY_GEMAS, 8_000);
  const fees = (entries * FEE_BPS) / 10_000n;
  const prize = entries - fees;
  const rest = prize - ENTRY_GEMAS * 3n;
  const [first, second, third] = split(rest, 3);
  return {
    entry: ENTRY_GEMAS,
    pot: entries,
    anaRefund,
    fees,
    /** What the car shows at departure: the entries less fees, all the last three off can share. */
    prize,
    rest,
    payouts: {
      Dee: ENTRY_GEMAS + first,
      Ben: ENTRY_GEMAS + second,
      Cy: ENTRY_GEMAS + third,
      Ana: anaRefund,
      Eve: 0n,
    },
  };
}
