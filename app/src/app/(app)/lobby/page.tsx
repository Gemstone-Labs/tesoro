"use client";

import { useGuideTip } from "@/components/guide/Guide";
import { BackPlayerRail } from "@/components/lobby/BackPlayerRail";
import { HeroCarousel } from "@/components/lobby/HeroCarousel";
import { LeaderboardTeaser } from "@/components/lobby/LeaderboardTeaser";
import { LiveWins } from "@/components/lobby/LiveWins";
import { PlayNowRail } from "@/components/lobby/PlayNowRail";
import { useSearch } from "@/components/shell/SearchContext";
import { Row, Thumb } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { fmtGemas } from "@/lib/format";
// PROTOTYPE: Continue rail variants (?variant=A..E, ?demo=1)
import { ContinueCurrent, ContinueSwitcher, ContinueTickets, ContinueTiles, ContinueUpNext, ContinueVersus, useContinue } from "@/components/lobby/Continue.prototype";
import { GAME_NAMES } from "@/lib/mock";

export default function Lobby() {
  const { openMatches: realOpen, snapshot } = useAccount();
  const { variant, matches: openMatches } = useContinue(realOpen);
  const { query } = useSearch();
  useGuideTip({
    id: "lobby-first",
    pose: "himWelcome",
    title: "Welcome to Tesoro",
    text: "Pick a game, choose an entry and press Play now. Your Gemas come from a Position in your Wallet.",
    link: { href: "/wallet", label: "Open the Wallet" },
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
      {openMatches.length > 0 && (
        <section className="rail" aria-labelledby="live-h">
          <header className="rail-head">
            <h2 id="live-h" className="h-section">Continue</h2>
          </header>
          {variant === "A" && <ContinueCurrent matches={openMatches} />}
          {variant === "B" && <ContinueTiles matches={openMatches} />}
          {variant === "C" && <ContinueVersus matches={openMatches} me={snapshot?.accountKey.toBase58() ?? "you"} />}
          {variant === "D" && <ContinueTickets matches={openMatches} />}
          {variant === "E" && <ContinueUpNext matches={openMatches} />}
        </section>
      )}

      <div className="lobby-top">
        <HeroCarousel />
        <LiveWins />
      </div>

      <PlayNowRail />
      <BackPlayerRail />
      <LeaderboardTeaser />
      <ContinueSwitcher />
    </div>
  );
}
