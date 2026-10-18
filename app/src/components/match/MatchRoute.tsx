"use client";

import { useEffect, useState } from "react";
import { HoldemMatchView } from "@/games/holdem/HoldemMatchView";
import { TradingDuelMatchView } from "@/games/trading-duel/TradingDuelMatchView";
import { VanguardMatchView } from "@/games/vanguard/VanguardMatchView";
import { BlockPuzzleChain } from "@/games/block-puzzle/chain";
import { getChain } from "@/lib/chain/client";
import { gameOf } from "@/lib/chain/read";
import { PublicKey } from "@solana/web3.js";
import { useAccount } from "@/lib/account";
import type { GameId } from "@/lib/mock";
import { MatchStageLoading } from "./MatchStage";
import { MatchView } from "./MatchView";

/** Picks the Match view by the Game the tesoro_core Match belongs to. */
export function MatchRoute({ matchId }: { matchId: string }) {
  const [game, setGame] = useState<GameId | null>(null);
  const { snapshot } = useAccount();

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const state: any = await getChain().core.account.matchState.fetchNullable(BlockPuzzleChain.addresses(BigInt(matchId)).match);
        const g = state ? gameOf(new PublicKey(Uint8Array.from(state.inner.game))) : null;
        if (live) setGame(g ?? "block-puzzle");
      } catch {
        if (live) setGame("block-puzzle");
      }
    })();
    return () => {
      live = false;
    };
  }, [matchId]);

  if (game === "holdem") return <HoldemMatchView matchId={matchId} />;
  if (game === "trading-duel") return <TradingDuelMatchView matchId={matchId} />;
  if (game === "vanguard") return <VanguardMatchView matchId={matchId} />;
  if (game === "block-puzzle") return <MatchView matchId={matchId} />;
  return <MatchStageLoading me={snapshot?.accountKey.toBase58() ?? null} />;
}
