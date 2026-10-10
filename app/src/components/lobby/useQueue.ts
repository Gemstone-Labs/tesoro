"use client";

import { useEffect, useState } from "react";
import type { QueueSeat } from "@/lib/chain/read";
import type { GameId } from "@/lib/mock";

export type QueueSeats = Record<GameId, QueueSeat[]>;

/** Open Queue Matches per Game, read from Solana devnet; null until the read lands. */
export function useQueue(): QueueSeats | null {
  const [seats, setSeats] = useState<QueueSeats | null>(null);
  useEffect(() => {
    let live = true;
    import("@/lib/chain/read")
      .then((m) => m.queueSeats())
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
  return { "block-puzzle": seats?.["block-puzzle"].length ?? 0, holdem: seats?.holdem.length ?? 0, "trading-duel": seats?.["trading-duel"].length ?? 0 };
}
