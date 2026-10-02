"use client";

import { useEffect, useState } from "react";
import { queueDepth as mockQueueDepth } from "@/lib/mock";
import type { GameId } from "@/lib/mock";

/** Open Queue Matches per Game, read from Solana devnet (the example figures until the read lands). */
export function useQueueDepth(): Record<GameId, number> {
  const [depth, setDepth] = useState<Record<GameId, number>>(mockQueueDepth);
  useEffect(() => {
    let live = true;
    import("@/lib/chain/read")
      .then(async (m) => [await m.queueDepth("block-puzzle"), await m.queueDepth("holdem"), await m.queueDepth("trading-duel")] as const)
      .then(([bp, hd, td]) => {
        if (live) setDepth({ "block-puzzle": bp, holdem: hd, "trading-duel": td });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return depth;
}
