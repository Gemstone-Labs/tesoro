// The Railcar numbers Players read in Help, Docs, Risks and Terms.
// Every figure comes from the engine, so a page can never drift from the rules.
import {
  BOLT_LEAD,
  BOLT_SHOWS,
  BRAKE_MS,
  MAX_CRASH_MS,
  MEDIAN_MS,
  MIN_CRASH_MS,
  SCREW_LEAD,
  SPARK_LEAD,
  SPARK_SHOWS,
  placeSharesBps,
  refund,
  refundPct,
  split,
} from "./engine";

export const ENTRY_GEMAS = 500n;
export const MIN_PLAYERS = 5;
export const MAX_PLAYERS = 100;
export const COUNTDOWN_SECONDS = 30;
/** Platform 2% + Studio 3% + Leaderboard 1%, taken from the Pot after Early-jump refunds. */
export const FEE_BPS = 600n;

const s = (ms: number) => ms / 1000;

export function crashOdds() {
  return {
    safeSeconds: s(MIN_CRASH_MS),
    medianSeconds: s(MIN_CRASH_MS) + s(Number(MEDIAN_MS)),
    certainSeconds: s(MAX_CRASH_MS),
    brakeSeconds: s(BRAKE_MS),
  };
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
/** "3 rides in 4" for a chance of `n` in `of`, in lowest terms. */
const ridesIn = (n: number, of: number) => {
  const d = gcd(n, of);
  return `${n / d} ride${n / d === 1 ? "" : "s"} in ${of / d}`;
};

/** The Tells: how often a ride shows each (later Tells are not promised, decisions Q39) and how far ahead of the wall. */
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

/** Rows of [seconds travelled, refund], read from the engine's schedule at each step. */
export function refundRows(): [string, string][] {
  const rows: [string, string][] = [];
  const at = (sec: number) => refundPct(sec * 1000);
  rows.push(["Up to 20 s", `${at(0)}%`]);
  for (let from = 20; from < 90; from += 10) rows.push([`${from} to ${from + 10} s`, `${at(from)}%`]);
  rows.push(["90 to 100 s", `${at(90)}%`]);
  rows.push(["After 100 s", `${at(100)}%`]);
  return rows;
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

/** Ana, Ben, Cy, Dee and Eve each enter 500; Ana Jumps at 25 s; Dee, Ben, Cy are the last three off. */
export function workedExample() {
  const entries = ENTRY_GEMAS * 5n;
  const anaRefund = refund(ENTRY_GEMAS, 25_000);
  const potAfterRefunds = entries - anaRefund;
  const fees = (potAfterRefunds * FEE_BPS) / 10_000n;
  const rest = potAfterRefunds - fees - ENTRY_GEMAS * 3n;
  const [first, second, third] = split(rest, 3);
  return {
    entry: ENTRY_GEMAS,
    pot: entries,
    anaRefund,
    potAfterRefunds,
    fees,
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
