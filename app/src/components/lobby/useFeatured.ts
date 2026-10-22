"use client";

import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { readStanding } from "@/lib/chain/admin-listing";
import { listingStage } from "@/lib/listing/state";
import type { FeaturedGame } from "@/server/listing/service";

/** Studio Games the Lobby may feature (accepted, paid, featured). Empty until the read lands, and when it fails. */
export function useFeatured(): FeaturedGame[] {
  const [games, setGames] = useState<FeaturedGame[]>([]);
  useEffect(() => {
    let live = true;
    fetch("/api/listing/featured")
      .then((r) => (r.ok ? r.json() : []))
      .then(async (g: FeaturedGame[]) => {
        if (!Array.isArray(g)) return;
        // Paperwork says featured; the chain must also say listed for the build deployed right now.
        const now = Math.floor(Date.now() / 1000);
        const checked = await Promise.all(
          g.map(async (game) => {
            try {
              const s = await readStanding(new PublicKey(game.programId));
              const stage = listingStage({ status: "accepted", paidUntil: game.paidUntil }, s.chain, s.live, now);
              return stage === "listed" && s.live ? game : null;
            } catch {
              return null;
            }
          }),
        );
        if (live) setGames(checked.filter((x): x is FeaturedGame => x !== null));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return games;
}
