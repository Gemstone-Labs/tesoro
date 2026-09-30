"use client";

import { useState } from "react";
import { ChartColumn, Clock, LayoutGrid, Spade, Users, type LucideIcon } from "lucide-react";
import { useGuideTip } from "@/components/guide/Guide";
import { BackPlayerRail } from "@/components/lobby/BackPlayerRail";
import { HeroCarousel } from "@/components/lobby/HeroCarousel";
import { LobbyFooter } from "@/components/lobby/LobbyFooter";
import { PlayAgainRail } from "@/components/lobby/PlayAgainRail";
import { PlayNowRail } from "@/components/lobby/PlayNowRail";
import { Ticker } from "@/components/lobby/Ticker";
import { Row, Thumb } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { CATEGORIES, type Category } from "@/lib/catalogue";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";

const CHIP_ICON: Record<Category, LucideIcon> = {
  puzzle: LayoutGrid,
  cards: Spade,
  "head-to-head": Users,
  async: Clock,
  backing: ChartColumn,
};

export default function Lobby() {
  const { openMatches } = useAccount();
  const [category, setCategory] = useState<Category | null>(null);
  useGuideTip({
    id: "lobby-first",
    bust: "himWelcome",
    title: "Welcome to Tesoro",
    text: "Pick a game, choose an entry and press Play now. Your Gemas come from a Position in your Wallet.",
    link: { href: "/wallet", label: "Open the Wallet" },
  });

  const pick = (id: Category) => {
    if (id === "backing") {
      document.getElementById("back-a-player")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      return;
    }
    setCategory((cur) => (cur === id ? null : id));
    document.getElementById("play-now")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  return (
    <div className="lobby">
      <nav className="cats" aria-label="Game categories">
        {CATEGORIES.map(({ id, label }) => {
          const Icon = CHIP_ICON[id];
          return (
            <button key={id} type="button" className={`cut cut-card cat${category === id ? " on" : ""}`} aria-pressed={id === "backing" ? undefined : category === id} onClick={() => pick(id)}>
              <Icon aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </nav>

      <HeroCarousel />

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

      <PlayNowRail category={category} onClear={() => setCategory(null)} />
      <PlayAgainRail />
      <Ticker />
      <BackPlayerRail />
      <LobbyFooter />
    </div>
  );
}
