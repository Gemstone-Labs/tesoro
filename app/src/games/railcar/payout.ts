/** How a Railcar Pot pays out, pure: core's many-seat rule, shared by the real ride's screens and Practice. */

export interface FeeRates {
  platformBps: number;
  studioBps: number;
  leaderboardBps: number;
}

/**
 * Core's `plan_payout`: fees on the Pot after refunds (the total floored once, Studio and Leaderboard floored, Platform
 * takes the rounding), capped at the forfeits Platform first; the rest split by place share, the remainder to first place.
 */
export function planPayout(a: { entry: bigint; seated: number; shares: number[]; refunded: bigint } & FeeRates): { fees: bigint[]; won: bigint[]; forfeited: bigint } {
  const unplaced = BigInt(a.seated - a.shares.length);
  const forfeited = unplaced * a.entry - a.refunded;
  const pot = BigInt(a.seated) * a.entry - a.refunded;
  const fee = (bps: number) => (pot * BigInt(bps)) / 10_000n;
  const total = fee(a.platformBps + a.studioBps + a.leaderboardBps);
  const full = [total - fee(a.studioBps) - fee(a.leaderboardBps), fee(a.studioBps), fee(a.leaderboardBps)];
  let room = forfeited;
  const fees = full.map((want) => {
    const cut = want < room ? want : room;
    room -= cut;
    return cut;
  });
  const won = a.shares.map((s) => (room * BigInt(s)) / 10_000n);
  if (won.length) won[0] += room - won.reduce((x, y) => x + y, 0n);
  return { fees, won, forfeited };
}

/** Railcar's fee terms (Platform 2%, Studio 3%) and core's Leaderboard Fee (1%), until the screen reads them from the Game record. */
export const RAILCAR_FEES: FeeRates = { platformBps: 200, studioBps: 300, leaderboardBps: 100 };
