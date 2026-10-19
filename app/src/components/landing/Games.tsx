import { art } from "@/lib/art";
import { appHref } from "@/lib/landing/config";
import { GameSelect, type LandingGame } from "./GameSelect";

const GAMES: LandingGame[] = [
  {
    id: "block-puzzle",
    name: "Block Puzzle",
    note: "Play anytime, 90 s",
    body: "Play when you like. You and your opponent get the same pieces; the higher score wins.",
    facts: [
      ["Pace", "Play anytime"],
      ["Pieces", "Same for both Players"],
      ["Length", "90 s"],
      ["Moves", "Private"],
    ],
    art: art.blockPuzzleHero,
    loop: [900, 622],
    href: appHref("/play/block-puzzle"),
  },
  {
    id: "holdem",
    name: "Buckshot Hold’em",
    note: "Real-time",
    body: "Heads-up against one opponent, live. Nobody sees the deck.",
    facts: [
      ["Pace", "Real-time"],
      ["Table", "Two Players"],
      ["Deck", "Hidden"],
    ],
    art: art.holdemHero,
    loop: [800, 548],
    href: appHref("/play/holdem"),
  },
  {
    id: "trading-duel",
    name: "Trading Duel",
    note: "Real-time, 2½ min",
    body: "Two Players watch one live price. Pick the box the line will pass through in each ten second column: every hit scores 100, and more points wins.",
    facts: [
      ["Pace", "Real-time"],
      ["Length", "2½ min"],
      ["Picks", "Private until they lock"],
      ["Price", "Live, never delayed"],
    ],
    art: art.tradingDuelHero,
    loop: [1000, 576],
    href: appHref("/play/trading-duel"),
  },
  {
    id: "vanguard",
    name: "Vanguard",
    note: "Real-time, 5 s a move",
    body: "Blitz Stratego on a desert board. Your army's ranks are hidden, you get five seconds a move, and the first Player to capture the enemy Supply Truck wins.",
    facts: [
      ["Pace", "Real-time"],
      ["Moves", "5 s each"],
      ["Ranks", "Hidden until they fight"],
      ["Goal", "Capture the Supply Truck"],
    ],
    art: art.vanguardHero,
    loop: [560, 560],
    href: appHref("/play/vanguard"),
  },
];

export function Games() {
  return (
    <section id="games" className="lp-section lp-games" aria-labelledby="games-title">
      <div className="lp-wrap">
        <h2 id="games-title" className="lp-h2" data-reveal>
          The games
        </h2>
        <GameSelect games={GAMES} footnote="Hidden moves, fair results, settled on Solana. Powered by MagicBlock." />
      </div>
    </section>
  );
}
