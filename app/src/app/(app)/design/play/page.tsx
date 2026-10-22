"use client";

import { useState } from "react";
import { notFound } from "next/navigation";
import { BlockPuzzleGame, type MatchRun } from "@/games/block-puzzle/BlockPuzzleGame";
import { DEV_WALLET } from "@/lib/chain/config";

/** DEV ONLY (NEXT_PUBLIC_DEV_WALLET=1): the Block Burst Match screen on a local Seed with no chain, for screenshots. */
export default function PlayPreview() {
  if (!DEV_WALLET) notFound();
  const [run] = useState<MatchRun>(() => {
    const t0 = performance.now();
    return {
      seed: 0x5eed1234abcdn,
      remainingMs: () => Math.max(0, 90_000 - (performance.now() - t0)),
      entry: 1000,
      onMove: () => undefined,
      onEnd: () => undefined,
    };
  });
  return (
    <BlockPuzzleGame
      run={run}
      matchPanel={
        <div className="bpx-status" role="status">
          <p>You both play the same pieces at the same time · higher score wins</p>
        </div>
      }
    />
  );
}
