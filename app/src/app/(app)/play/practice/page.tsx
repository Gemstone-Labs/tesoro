import { Suspense } from "react";
import { BlockPuzzleGame } from "@/games/block-puzzle/BlockPuzzleGame";
import { HoldemPractice } from "@/games/holdem/practice/HoldemPractice";
import { TradingDuelPractice } from "@/games/trading-duel/practice/TradingDuelPractice";

/** Practice, nothing staked: Block Burst with a random Seed, or `?game=holdem` / `?game=trading-duel` against a local bot. */
export default async function Practice({ searchParams }: PageProps<"/play/practice">) {
  const { game } = await searchParams;
  if (game === "trading-duel") {
    return (
      <Suspense>
        <TradingDuelPractice />
      </Suspense>
    );
  }
  return game === "holdem" ? <HoldemPractice /> : <BlockPuzzleGame />;
}
