"use client";

import { useEffect, useState } from "react";
import type { QueueSeat } from "@/lib/chain/read";
import { filterByLease, freshLeases } from "@/lib/chain/presence";
import type { GameId } from "@/lib/mock";

export type QueueSeats = Record<GameId, QueueSeat[]>;

/**
 * Block Burst seats whose opener has no fresh presence lease are not counted (their page is closed). A seat without a
 * `match` key, or a failed lease check, is kept. Challenges are never in the Queue list.
 */
export async function withoutAbsent(seats: QueueSeats): Promise<QueueSeats> {
  const bb = seats["block-puzzle"];
  const keys = bb.flatMap((s) => (s.match ? [s.match] : []));
  if (keys.length === 0) return seats;
  const kept = new Set(filterByLease(keys, await freshLeases(keys)));
  return { ...seats, "block-puzzle": bb.filter((s) => !s.match || kept.has(s.match)) };
}

/** Open Queue Matches per Game, read from Solana devnet; null until the read lands. */
export function useQueue(): QueueSeats | null {
  const [seats, setSeats] = useState<QueueSeats | null>(null);
  useEffect(() => {
    let live = true;
    import("@/lib/chain/read")
      .then((m) => m.queueSeats())
      .then(withoutAbsent)
      .then((s) => {
        if (live) setSeats(s);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return seats;
}

/** Players waiting in each Game's Queue; 0 until the read lands. */
export function useQueueDepth(): Record<GameId, number> {
  const seats = useQueue();
  return { "block-puzzle": seats?.["block-puzzle"].length ?? 0, holdem: seats?.holdem.length ?? 0, "trading-duel": seats?.["trading-duel"].length ?? 0, vanguard: seats?.vanguard.length ?? 0 };
}
