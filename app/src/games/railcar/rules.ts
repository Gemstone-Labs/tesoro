// The Railcar numbers Players read in Help, Docs, Risks and Terms.
// Every figure comes from the engine, so a page can never drift from the rules.
import {
  BOLT_LEAD,
  BRAKE_MS,
  MAX_CRASH_MS,
  MEDIAN_MS,
  MIN_CRASH_MS,
  SCREW_LEAD,
  SPARK_LEAD,
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

export function tellRows() {
  const range = ([lo, hi]: readonly [number, number]) => `${s(lo)} to ${s(hi)} seconds`;
  return [
    { name: "Loose screws", range: range(SCREW_LEAD), lastWarningFloor: false },
    { name: "A loose bolt and a rattling panel", range: range(BOLT_LEAD), lastWarningFloor: false },
    { name: "Sparks and a creak", range: range(SPARK_LEAD), lastWarningFloor: true },
  ];
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
