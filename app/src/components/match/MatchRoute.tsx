"use client";

import { useEffect, useState } from "react";
import { HoldemMatchView } from "@/games/holdem/HoldemMatchView";
import { TradingDuelMatchView } from "@/games/trading-duel/TradingDuelMatchView";
import { VanguardMatchView } from "@/games/vanguard/VanguardMatchView";
import { getChain } from "@/lib/chain/client";
import { matchAddressOf } from "@/lib/chain/match-id";
import { gameOf } from "@/lib/chain/read";
import { PublicKey } from "@solana/web3.js";
import { useAccount } from "@/lib/account";
import type { GameId } from "@/lib/mock";
import { BRAND } from "@/lib/brand";
import { MatchStageLoading } from "./MatchStage";
import { MatchView } from "./MatchView";

type RouteGame = GameId | "unknown";

/** Picks the Match view by the Game the tesoro_core Match belongs to. */
export function MatchRoute({ matchId }: { matchId: string }) {
  const [game, setGame] = useState<RouteGame | null>(null);
  const { snapshot } = useAccount();

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const address = matchAddressOf(matchId);
        const state: any = address ? await getChain().core.account.matchState.fetchNullable(address) : null;
        // No Match (or a key that names none): Block Burst's view says so. A program this app does not play is shown as such, never as Block Burst.
        const g = state ? gameOf(new PublicKey(Uint8Array.from(state.inner.game))) : "block-puzzle";
        if (live) setGame(g ?? "unknown");
      } catch {
        if (live) setGame("block-puzzle");
      }
    })();
    return () => {
      live = false;
    };
  }, [matchId]);

  switch (game) {
    case "holdem":
      return <HoldemMatchView matchId={matchId} />;
    case "trading-duel":
      return <TradingDuelMatchView matchId={matchId} />;
    case "vanguard":
      return <VanguardMatchView matchId={matchId} />;
    case "block-puzzle":
      return <MatchView matchId={matchId} />;
    case "unknown":
      return <p className="status" role="status">This Match belongs to a Game this version of {BRAND.name} cannot show.</p>;
    case null:
      return <MatchStageLoading me={snapshot?.accountKey.toBase58() ?? null} />;
    default:
      return game satisfies never;
  }
}
