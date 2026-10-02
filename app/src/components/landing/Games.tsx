import { appHref } from "@/lib/landing/config";
import { LoopVideo } from "./LoopVideo";

const GAMES = [
  {
    id: "block-puzzle",
    name: "Block Puzzle",
    facts: "Async · same Seed · 90 s · private moves",
    body: "Play when you like. You and your opponent get the same Seed; the higher score wins.",
    loop: [638, 738],
  },
  {
    id: "holdem",
    name: "Heads-up Hold’em",
    facts: "Real-time · hidden deck",
    body: "Heads-up against one opponent, live. Nobody sees the deck.",
    loop: [924, 638],
  },
];

export function Games() {
  return (
    <section id="games" className="lp-section lp-games" aria-labelledby="games-title">
      <div className="lp-wrap">
        <h2 id="games-title" className="lp-h2" data-reveal>
          The games
        </h2>
        <div className="lp-games-grid">
          {GAMES.map((g) => (
            <article key={g.id} className="lp-game" data-reveal>
              <div className="lp-game-frame cut cut-frame">
                <LoopVideo name={g.id} label={`${g.name} gameplay`} width={g.loop[0]} height={g.loop[1]} />
              </div>
              <h3 className="lp-h3">{g.name}</h3>
              <p className="mono lp-facts">{g.facts}</p>
              <p className="lp-body">{g.body}</p>
              <a className="lp-link" href={appHref(`/play/${g.id}`)}>
                See {g.name} →
              </a>
            </article>
          ))}
        </div>
        <p className="lp-per mono" data-reveal>
          On-chain in MagicBlock Private Ephemeral Rollups.
        </p>
      </div>
    </section>
  );
}
