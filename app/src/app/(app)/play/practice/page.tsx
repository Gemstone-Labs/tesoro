import { Arena } from "@/games/fx";
import { FirstPracticeGuide } from "@/components/how-to-play";
import { Suspense } from "react";
import { BlockPuzzleGame } from "@/games/block-puzzle/BlockPuzzleGame";
import { HoldemPractice } from "@/games/holdem/practice/HoldemPractice";
import { TradingDuelPractice } from "@/games/trading-duel/practice/TradingDuelPractice";
import { gameFromParam } from "@/lib/game-params";
import { RAILCAR_SHOWN } from "@/lib/games";
import { RailcarPractice } from "@/games/railcar/practice/RailcarPractice";
import { practiceSeed } from "@/lib/practice-seed";
import { VanguardPractice } from "@/games/vanguard/practice/VanguardPractice";

/**
 * Practice, nothing staked: Block Burst with a random Seed, or `?game=holdem` / `?game=trading-duel` / `?game=vanguard`
 * against a local bot, or `?game=railcar` with 9 simulated riders (where Railcar is shown). `&draw=<64 hex>` replays one
 * Railcar Practice ride (the How to play clips); a real ride never reads it.
 */
export default async function Practice({ searchParams }: PageProps<"/play/practice">) {
  const params = await searchParams;
  if (RAILCAR_SHOWN && params.game === "railcar")
    return (
      <Arena key="railcar" game="railcar" autoFull>
        <FirstPracticeGuide game="railcar">
          <RailcarPractice draw={drawFromParam(params.draw)} />
        </FirstPracticeGuide>
      </Arena>
    );
  const game = gameFromParam(params.game);
  const seed = typeof params.seed === "string" ? practiceSeed(`seed=${encodeURIComponent(params.seed)}`) : undefined;
  return <Arena key={game} game={game} autoFull><FirstPracticeGuide game={game}><PracticeGame game={game} seed={seed} /></FirstPracticeGuide></Arena>;
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

/** A Practice ride's 32-byte draw from `?draw=` (64 hex digits), or undefined for a fresh random one. */
function drawFromParam(v: string | string[] | undefined): Uint8Array | undefined {
  if (typeof v !== "string" || !/^[0-9a-f]{64}$/i.test(v)) return undefined;
  return Uint8Array.from(v.match(/../g)!, (h) => parseInt(h, 16));
}
