"use client";

import { useGuideTip } from "@/components/guide/Guide";
import { BackPlayerRail } from "@/components/lobby/BackPlayerRail";
import { HeroCarousel } from "@/components/lobby/HeroCarousel";
import { LiveWins } from "@/components/lobby/LiveWins";
import { PlayAgainRail } from "@/components/lobby/PlayAgainRail";
import { PlayNowRail } from "@/components/lobby/PlayNowRail";
import { Row, Thumb } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";

export default function Lobby() {
  const { openMatches } = useAccount();
  useGuideTip({
    id: "lobby-first",
    pose: "himWelcome",
    title: "Welcome to Tesoro",
    text: "Pick a game, choose an entry and press Play now. Your Gemas come from a Position in your Wallet.",
    link: { href: "/wallet", label: "Open the Wallet" },
  });

  return (
    <div className="lobby">
      <div className="lobby-top">
        <HeroCarousel />
        <LiveWins />
      </div>

      {openMatches.length > 0 && (
        <section className="rail" aria-labelledby="live-h">
          <header className="rail-head">
            <h2 id="live-h" className="h-section">Continue</h2>
          </header>
          <div className="live-grid">
            {openMatches.map((m) => (
              <Row
                key={m.id.toString()}
                href={`/play/match/${m.id.toString()}`}
                thumb={<Thumb>{m.entry >= 1000 ? `${m.entry / 1000}K` : m.entry}</Thumb>}
                title={`${GAME_NAMES[m.game]} · ${fmtGemas(m.entry)} entry`}
                meta={m.status === "open" ? (m.challenge ? "Waiting for your Challenge to be opened" : m.game === "block-puzzle" ? "Waiting to be paired" : "Waiting for an opponent") : "Opponent found · continue"}
                cta="Open"
              />
            ))}
          </div>
        </section>
      )}

      <PlayNowRail />
      <PlayAgainRail />
      <BackPlayerRail />
    </div>
  );
}
