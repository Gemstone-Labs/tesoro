"use client";

import { useGuideTip } from "@/components/guide/Guide";
import { useViewMode } from "@/lib/deposit/use-view-mode";
import { getGemasHref } from "@/lib/deposit/view-mode";
import { BackPlayerRail } from "@/components/lobby/BackPlayerRail";
import { ContinueRail } from "@/components/lobby/ContinueRail";
import { HeroCarousel } from "@/components/lobby/HeroCarousel";
import { LeaderboardTeaser } from "@/components/lobby/LeaderboardTeaser";
import { LiveWins } from "@/components/lobby/LiveWins";
import { PlayAgainRail } from "@/components/lobby/PlayAgainRail";
import { PlayNowRail } from "@/components/lobby/PlayNowRail";
import { useSearch } from "@/components/shell/SearchContext";
import { useAccount } from "@/lib/account";
import { BRAND } from "@/lib/brand";

export default function Lobby() {
  const { openMatches } = useAccount();
  const { query } = useSearch();
  const simple = useViewMode().mode === "simple";
  useGuideTip({
    id: "lobby-first",
    pose: "himWelcome",
    title: `Welcome to ${BRAND.name}`,
    text: simple
      ? "Pick a game, choose an entry and press Play now. Get Gemas by making a deposit."
      : "Pick a game, choose an entry and press Play now. Your Gemas come from a Lock in your Wallet.",
    link: simple ? { href: getGemasHref("simple"), label: "Get Gemas" } : { href: "/wallet", label: "Open the Wallet" },
  });

  // A search turns the Lobby into its results: the matching Games only, as on Play.
  if (query.trim()) {
    return (
      <div className="lobby">
        <PlayNowRail />
      </div>
    );
  }

  return (
    <div className="lobby">
      {openMatches.length > 0 && <ContinueRail matches={openMatches} />}

      <div className="lobby-top">
        <HeroCarousel />
        <LiveWins />
      </div>

      <PlayNowRail />
      <PlayAgainRail />
      <BackPlayerRail />
      <LeaderboardTeaser />
    </div>
  );
}
