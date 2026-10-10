"use client";

import { useState } from "react";
import { notFound } from "next/navigation";
import { BlockPuzzleGame, type MatchRun } from "@/games/block-puzzle/BlockPuzzleGame";
import { DEV_WALLET } from "@/lib/chain/config";

/** DEV ONLY (NEXT_PUBLIC_DEV_WALLET=1): the Block Puzzle Match screen on a local Seed with no chain, for screenshots. */
export default function PlayPreview() {
  if (!DEV_WALLET) notFound();
  const [run] = useState<MatchRun>(() => ({
    seed: 0x5eed1234abcdn,
    startedAt: performance.now(),
    entry: 1000,
    onMove: () => undefined,
    onEnd: () => undefined,
  }));
  return (
    <BlockPuzzleGame
      run={run}
      matchPanel={
        <div className="bpx-status" role="status">
          <p>Your opponent gets the same pieces · waiting to be paired</p>
          <span className="bpx-finding">
            <i className="bpx-spin" aria-hidden="true" /> Finding opponent…
          </span>
        </div>
      }
    />
  );
}
