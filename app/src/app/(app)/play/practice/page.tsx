import { Arena } from "@/games/fx";
import { Suspense } from "react";
import { BlockPuzzleGame } from "@/games/block-puzzle/BlockPuzzleGame";
import { HoldemPractice } from "@/games/holdem/practice/HoldemPractice";
import { TradingDuelPractice } from "@/games/trading-duel/practice/TradingDuelPractice";
import { gameFromParam } from "@/lib/game-params";
import { practiceSeed } from "@/lib/practice-seed";
import { VanguardPractice } from "@/games/vanguard/practice/VanguardPractice";

/** Practice, nothing staked: Block Burst with a random Seed, or `?game=holdem` / `?game=trading-duel` / `?game=vanguard` against a local bot. */
export default async function Practice({ searchParams }: PageProps<"/play/practice">) {
  const params = await searchParams;
  const game = gameFromParam(params.game);
  const seed = typeof params.seed === "string" ? practiceSeed(`seed=${encodeURIComponent(params.seed)}`) : undefined;
  return <Arena key={game} game={game} autoFull><PracticeGame game={game} seed={seed} /></Arena>;
}

function PracticeGame({ game, seed }: { game: ReturnType<typeof gameFromParam>; seed?: number }) {
  switch (game) {
    case "trading-duel":
      return (
        <Suspense>
          <TradingDuelPractice />
        </Suspense>
      );
    case "vanguard":
      return <VanguardPractice seed={seed} />;
    case "holdem":
      return <HoldemPractice />;
    case "block-puzzle":
      return <BlockPuzzleGame />;
    default:
      return game satisfies never;
  }
}
