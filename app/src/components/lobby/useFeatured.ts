"use client";

import { useEffect, useState } from "react";
import type { FeaturedGame } from "@/server/listing/service";

/** Studio Games the Lobby may feature (accepted, paid, featured). Empty until the read lands, and when it fails. */
export function useFeatured(): FeaturedGame[] {
  const [games, setGames] = useState<FeaturedGame[]>([]);
  useEffect(() => {
    let live = true;
    fetch("/api/listing/featured")
      .then((r) => (r.ok ? r.json() : []))
      .then((g) => live && Array.isArray(g) && setGames(g))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return games;
}
