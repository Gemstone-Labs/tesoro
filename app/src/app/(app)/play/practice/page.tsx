import { Suspense } from "react";
import { BlockPuzzleGame } from "@/games/block-puzzle/BlockPuzzleGame";
import { HoldemPractice } from "@/games/holdem/practice/HoldemPractice";
import { TradingDuelPractice } from "@/games/trading-duel/practice/TradingDuelPractice";
import { VanguardPractice } from "@/games/vanguard/practice/VanguardPractice";

/** Practice, nothing staked: Block Puzzle with a random Seed, or `?game=holdem` / `?game=trading-duel` / `?game=vanguard` against a local bot. */
export default async function Practice({ searchParams }: PageProps<"/play/practice">) {
  const { game } = await searchParams;
  if (game === "trading-duel") {
    return (
      <Suspense>
        <TradingDuelPractice />
      </Suspense>
    );
  }
  if (game === "vanguard") return <VanguardPractice />;
  return game === "holdem" ? <HoldemPractice /> : <BlockPuzzleGame />;
}
