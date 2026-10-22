"use client";

import { useNowSecs } from "@/lib/chain/useNowSecs";
import { fmtInMinutes } from "@/lib/format";

/**
 * The balance card's words, shared by the Simple and Advanced views. Players read "deposit", never Lock, staking or
 * yield: the Simple-words guard (plain-words.test.ts) scans this folder.
 */
export const CARD = {
  total: "Total Balance",
  now: "Redeemable now",
  own: "Your pending",
  won: "Won pending",
  redeem: "Redeem",
  instant: "Instant Redeem",
  nowInfo: (test: boolean) => `Gemas you can turn back into money now, at full value.${test ? " Pays test SOL." : ""}`,
  ownInfo: "Gemas from your deposits. They become redeemable bit by bit as your deposit earns.",
  wonInfo: (keepPct: number) => `Gemas you won. They become redeemable over time, or Instant Redeem them now for ${keepPct}%.`,
  redeemEmpty: "Nothing to redeem yet. Gemas move here over time.",
  redeemCheck: "Redeem checks for new earnings first.",
  instantNoneWon: "Nothing won is waiting. Win a Match and its Gemas show up here.",
  instantUnavailable: "Instant Redeem isn't available right now. Try again later.",
  instantGet: (amount: string, capped: boolean) => (capped ? `The Treasury can pay up to ${amount} right now.` : `Get ${amount} now for these Gemas.`),
  instantNote: (amount: string, capped: boolean) => `${capped ? "up to " : ""}${amount} now`,
  inPlay: "Gemas in Matches, Queue seats or Offers",
} as const;

/** "Next ones in ~26 min", ticking; nothing when there is no estimate. */
export function NextIn({ at }: { at: number | null | undefined }) {
  const secs = useNowSecs(15_000);
  if (!at) return null;
  return <span className="tip-next">Next ones {fmtInMinutes(at, Math.max(secs * 1000, 0))}.</span>;
}
