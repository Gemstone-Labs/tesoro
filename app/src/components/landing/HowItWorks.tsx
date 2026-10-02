import type { ReactNode } from "react";
import { art } from "@/lib/art";
import { landingArt, type LandingKey } from "@/lib/landing/art";
import { Picture } from "./Picture";

/** The diagram's coordinate space (px); nodes and labels are placed in % of it so it scales with the column. */
const W = 1240;
const H = 520;
const pct = (x: number, y: number) => ({ left: `${(x / W) * 100}%`, top: `${(y / H) * 100}%` });

type Node = { id: string; x: number; y: number; art?: LandingKey | "back"; title: string; sub?: string; small?: boolean; label: [number, number] };

const NODES: Node[] = [
  { id: "position", x: 92, y: 220, art: "step1", title: "Open a Position", sub: "SOL · ETH · HYPE", label: [92, 312] },
  { id: "advance", x: 332, y: 220, art: "step2", title: "Take an Advance", sub: "1–12 months of projected yield, today, as Gemas", label: [332, 312] },
  { id: "play", x: 592, y: 92, art: "step4", title: "Play yourself", label: [592, 182] },
  { id: "back", x: 592, y: 372, art: "back", title: "Back a Player", sub: "Fund a stronger Player’s entry", label: [592, 462] },
  { id: "settle", x: 800, y: 232, title: "Settle", small: true, label: [0, 0] },
];

/** The tubes between nodes. */
const TUBES = [
  "M168 220H256",
  "M408 220C470 220 470 92 516 92",
  "M408 220C470 220 470 372 516 372",
  "M668 92C724 92 700 232 748 232",
  "M668 372C724 372 700 232 748 232",
  "M852 232C872 232 868 100 890 100",
  "M852 232C872 232 868 372 890 372",
];

function NodeArt({ node }: { node: Node }) {
  if (node.art === "back") {
    return (
      <picture>
        <img src="/art/landing/back-a-player.webp" alt="" width={360} height={360} loading="lazy" />
      </picture>
    );
  }
  if (node.art && landingArt(node.art)) return <Picture k={node.art} sizes="140px" />;
  return null;
}

function Outcome({ win, title, children }: { win?: boolean; title: string; children: ReactNode }) {
  return (
    <div className={`lp-outcome-card cut cut-frame${win ? " win" : " lose"}`} style={pct(890, win ? 100 : 372)}>
      <div className="lp-oct-node small" aria-hidden>
        <span className="lp-oct-frame" />
        {landingArt(win ? "step5" : "step1") && <Picture k={win ? "step5" : "step1"} sizes="96px" />}
      </div>
      <div>
        <b>{title}</b>
        <span>{children}</span>
      </div>
    </div>
  );
}

export function HowItWorks() {
  const guide = landingArt("himGuide");
  return (
    <section id="how-it-works" className="lp-section lp-how" aria-labelledby="how-title">
      <div className="lp-wrap">
        <header className="lp-how-head">
          <div className="lp-how-guide" aria-hidden>
            {guide ? (
              <Picture k="himGuide" sizes="200px" />
            ) : (
              <picture>
                <img src={art.busts.himExplain.src} width={art.busts.himExplain.w} height={art.busts.himExplain.h} alt="" loading="lazy" />
              </picture>
            )}
          </div>
          <div>
            <h2 id="how-title" className="lp-h2" data-reveal>
              How it works
            </h2>
            <p className="lp-lede lp-measure" data-reveal>
              Your stake earns <em className="lp-hl">yield</em>. Tesoro hands you that yield now, as Gemas, and the yield pays it back while you play.
            </p>
          </div>
        </header>

        <figure className="lp-flowmap" data-reveal aria-label="Open a Position, take an Advance as Gemas, then play yourself or back a Player. At settlement the winner takes the loser's Gemas, paid out as their yield lands; the loser's Position stays locked until its yield repays the Advance.">
          <svg viewBox={`0 0 ${W} ${H}`} fill="none" strokeLinecap="round" aria-hidden>
            <defs>
              <filter id="lp-tube-glow" x="-10%" y="-40%" width="120%" height="180%">
                <feGaussianBlur stdDeviation="6" />
              </filter>
              <g id="lp-tubes">
                {TUBES.map((d) => (
                  <path key={d} d={d} />
                ))}
              </g>
            </defs>
            <use href="#lp-tubes" className="tube-glow" filter="url(#lp-tube-glow)" />
            <use href="#lp-tubes" className="tube-outer" />
            <use href="#lp-tubes" className="tube-core" />
            <use href="#lp-tubes" className="tube-hi" />
            <g className="lp-flow-dots">
              {TUBES.map((d, i) => (
                <circle key={d} r="4">
                  <animateMotion dur={`${2.4 + (i % 3) * 0.3}s`} begin={`${(i * 0.37).toFixed(2)}s`} repeatCount="indefinite" path={d} />
                </circle>
              ))}
            </g>
          </svg>
          {NODES.map((n) => (
            <div key={n.id} className={`lp-oct-node n-${n.id}${n.small ? " settle" : ""}`} style={pct(n.x, n.y)} aria-hidden>
              <span className="lp-oct-frame" />
              {n.small ? <span className="lp-settle-label">Settle</span> : <NodeArt node={n} />}
            </div>
          ))}
          {NODES.filter((n) => !n.small).map((n) => (
            <div key={n.id} className={`lp-flow-label l-${n.id}`} style={pct(...n.label)}>
              <b>{n.title}</b>
              {n.sub && <span>{n.sub}</span>}
            </div>
          ))}
          <Outcome win title="Win">
            You take the loser&rsquo;s Gemas, paid out as their yield lands.
          </Outcome>
          <Outcome title="Lose">Your Position stays locked until its yield repays the Advance.</Outcome>
        </figure>
        <p className="lp-flow-foot" data-reveal>
          <b>
            Your <em className="lp-hl">Principal</em> is never played.
          </b>{" "}
          Only future <em className="lp-hl">yield</em> moves.
        </p>
      </div>
    </section>
  );
}
