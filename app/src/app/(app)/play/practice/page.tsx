import { Arena } from "@/games/fx";
import { Suspense } from "react";
import { BlockPuzzleGame } from "@/games/block-puzzle/BlockPuzzleGame";
import { HoldemPractice } from "@/games/holdem/practice/HoldemPractice";
import { TradingDuelPractice } from "@/games/trading-duel/practice/TradingDuelPractice";
import { gameFromParam } from "@/lib/game-params";
import { VanguardPractice } from "@/games/vanguard/practice/VanguardPractice";

/** Practice, nothing staked: Block Burst with a random Seed, or `?game=holdem` / `?game=trading-duel` / `?game=vanguard` against a local bot. */
export default async function Practice({ searchParams }: PageProps<"/play/practice">) {
  const game = gameFromParam((await searchParams).game);
  return <Arena key={game} game={game} autoFull><PracticeGame game={game} /></Arena>;
}

function PracticeGame({ game }: { game: ReturnType<typeof gameFromParam> }) {
  switch (game) {
    case "trading-duel":
      return (
        <Suspense>
          <TradingDuelPractice />
        </Suspense>
      );
    case "vanguard":
      return <VanguardPractice />;
    case "holdem":
      return <HoldemPractice />;
    case "block-puzzle":
      return <BlockPuzzleGame />;
    default:
      return game satisfies never;
  }
}
