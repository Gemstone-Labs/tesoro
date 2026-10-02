import { art } from "@/lib/art";
import { appHref } from "@/lib/landing/config";
import { GameSelect, type LandingGame } from "./GameSelect";

const GAMES: LandingGame[] = [
  {
    id: "block-puzzle",
    name: "Block Puzzle",
    note: "Async, 90 s",
    body: "Play when you like. You and your opponent get the same Seed; the higher score wins.",
    facts: [
      ["Pace", "Async"],
      ["Seed", "Same for both Players"],
      ["Length", "90 s"],
      ["Moves", "Private"],
    ],
    art: art.blockPuzzleHero,
    loop: [784, 862],
    href: appHref("/play/block-puzzle"),
  },
  {
    id: "holdem",
    name: "Heads-up Hold’em",
    note: "Real-time",
    body: "Heads-up against one opponent, live. Nobody sees the deck.",
    facts: [
      ["Pace", "Real-time"],
      ["Table", "Two Players"],
      ["Deck", "Hidden"],
    ],
    art: art.holdemHero,
    loop: [1124, 752],
    href: appHref("/play/holdem"),
  },
];

export function Games() {
  return (
    <section id="games" className="lp-section lp-games" aria-labelledby="games-title">
      <div className="lp-wrap">
        <h2 id="games-title" className="lp-h2" data-reveal>
          The games
        </h2>
        <GameSelect games={GAMES} footnote="On-chain in MagicBlock Private Ephemeral Rollups." />
      </div>
    </section>
  );
}
