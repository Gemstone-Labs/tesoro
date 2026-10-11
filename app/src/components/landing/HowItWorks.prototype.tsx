"use client";

/**
 * PROTOTYPE ONLY (branch proto/how-it-works-11-10-2026), round 2. The current How it works diagram and layout, with
 * add-ons layered on top, picked with `?variant=` on /welcome:
 *   now  the section as shipped
 *   A    Return arc: numbered steps, and the missing loop back (yield repays the Debt, the Position unlocks)
 *   B    Amounts: one worked example written onto the labels and outcome cards (10 SOL → 5,250 Gemas → 1,000 entry)
 *   C    Guided: the diagram lights one step at a time with a caption under it; click a node or a dot to jump
 *   D    Polish: heading and lede on one row so the whole diagram fits a laptop screen, lock tag on the Position,
 *        a line under Play yourself, shorter outcome copy
 *   E    A + B + D together
 * Example figures are illustrative (10 SOL, 6-month Horizon, ~7% a year, SOL at $150).
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { PrototypeSwitcher, usePrototypeVariant } from "@/components/prototype/PrototypeSwitcher";
import { art } from "@/lib/art";
import { landingArt, type LandingKey } from "@/lib/landing/art";
import { Picture } from "./Picture";
import "./how.prototype.css";

const VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Return arc + numbers" },
  { key: "B", name: "Example amounts" },
  { key: "C", name: "Guided" },
  { key: "D", name: "Polish" },
  { key: "E", name: "A + B + D" },
] as const;
type Key = (typeof VARIANTS)[number]["key"];
type Flags = { arc?: boolean; amounts?: boolean; guided?: boolean; polish?: boolean };
const FLAGS: Record<Exclude<Key, "now">, Flags> = {
  A: { arc: true },
  B: { amounts: true },
  C: { guided: true },
  D: { polish: true },
  E: { arc: true, amounts: true, polish: true },
};

export function HowItWorksPrototype({ now }: { now: ReactNode }) {
  const v = usePrototypeVariant(VARIANTS.map((x) => x.key));
  return (
    <>
      {v === "now" ? now : <HowFlow key={v} {...FLAGS[v]} />}
      <PrototypeSwitcher variants={VARIANTS} />
    </>
  );
}

/* ——— the current diagram, copied with switches ——— */

const W = 1240;
type NodeId = "position" | "advance" | "play" | "back" | "settle";
type Node = { id: NodeId; x: number; y: number; art?: LandingKey | "back"; title: string; sub?: string; small?: boolean; label: [number, number] };

function nodes(f: Flags): Node[] {
  const sub = {
    position: f.amounts ? "Lock 10 SOL" : "SOL · ETH · HYPE",
    advance: f.amounts ? "+5,250 Gemas today: 6 months of its yield" : "1–12 months of projected yield, today, as Gemas",
    play: f.amounts ? "Enter a Match for 1,000 Gemas" : f.polish ? "Block Puzzle, Hold’em and more" : undefined,
    back: f.amounts ? "Put up 1,000 Gemas for a stronger Player" : "Fund a stronger Player’s entry",
  };
  return [
    { id: "position", x: 92, y: 220, art: "step1", title: "Open a Position", sub: sub.position, label: [92, 312] },
    { id: "advance", x: 332, y: 220, art: "step2", title: "Take an Advance", sub: sub.advance, label: [332, 312] },
    { id: "play", x: 592, y: 92, art: "step4", title: "Play yourself", sub: sub.play, label: [592, 182] },
    { id: "back", x: 592, y: 372, art: "back", title: "Back a Player", sub: sub.back, label: [592, 462] },
    { id: "settle", x: 800, y: 232, title: "Settle", small: true, label: [0, 0] },
  ];
}

const TUBES = [
  "M168 220H256",
  "M408 220C470 220 470 92 516 92",
  "M408 220C470 220 470 372 516 372",
  "M668 92C724 92 700 232 748 232",
  "M668 372C724 372 700 232 748 232",
  "M852 232C872 232 868 100 890 100",
  "M852 232C872 232 868 372 890 372",
];
/** Lose card's bottom edge, under the whole diagram, back up into the Position. */
const ARC = "M1065 437V560Q1065 598 1027 598H130Q92 598 92 560V372";
const ARC_INDEX = TUBES.length;

type Step = { nodes: NodeId[]; tubes: number[]; outcomes?: boolean; text: string };
const STEPS: Step[] = [
  { nodes: ["position"], tubes: [], text: "Lock SOL, ETH or HYPE in a Position. That’s your Principal: it stays locked and is never played." },
  { nodes: ["position", "advance"], tubes: [0], text: "Take an Advance: pick 1–12 months of the yield your Position will earn, and get it today as Gemas." },
  { nodes: ["advance", "play", "back"], tubes: [1, 2], text: "Spend Gemas on skill Matches yourself, or fund a stronger Player’s entry and share the win." },
  { nodes: ["play", "back", "settle"], tubes: [3, 4], text: "Every Match settles on chain when it ends." },
  { nodes: ["settle"], tubes: [5, 6], outcomes: true, text: "The winner takes the loser’s Gemas, paid out as the loser’s yield lands. The loser’s Position stays locked until its yield repays the Advance." },
];

const NUMBERS: Partial<Record<NodeId, string>> = { position: "1", advance: "2", play: "3", back: "3", settle: "4" };

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

function Lock() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

function outcomeCopy(win: boolean, f: Flags): { big?: string; line: ReactNode; small?: string } {
  if (f.amounts) {
    return win
      ? { big: "+1,000 Gemas", line: "The loser’s entry is yours,", small: "paid out as their yield lands." }
      : { big: "−1,000 Gemas", line: "Your entry goes to the winner.", small: "Your Position unlocks once its yield repays the 5,250." };
  }
  if (f.polish) {
    return win
      ? { line: "Take the loser’s Gemas.", small: "Paid out as their yield lands." }
      : { line: "Your Gemas go to the winner.", small: "Your Position unlocks once its yield repays the Advance." };
  }
  return win
    ? { line: "You take the loser’s Gemas, paid out as their yield lands." }
    : { line: "Your Position stays locked until its yield repays the Advance." };
}

function OutcomeBody({ win, f }: { win: boolean; f: Flags }) {
  const c = outcomeCopy(win, f);
  return (
    <div>
      <b>
        {win ? "Win" : "Lose"}
        {c.big && <em className="hp-amount"> {c.big}</em>}
      </b>
      <span>
        {c.line}
        {c.small && <small> {c.small}</small>}
      </span>
    </div>
  );
}

function Link({ shape }: { shape: "straight" | "split" | "merge" }) {
  const paths = {
    straight: ["M50 0V48"],
    split: ["M50 0C50 26 25 22 25 48", "M50 0C50 26 75 22 75 48"],
    merge: ["M25 0C25 26 50 22 50 48", "M75 0C75 26 50 22 50 48"],
  }[shape];
  return (
    <svg className="lp-m-link" viewBox="0 0 100 48" preserveAspectRatio="none" fill="none" aria-hidden>
      {["tube-outer", "tube-core", "tube-hi", "tube-flow"].map((cls) => (
        <g key={cls} className={cls}>
          {paths.map((d) => (
            <path key={d} d={d} vectorEffect="non-scaling-stroke" pathLength={100} />
          ))}
        </g>
      ))}
    </svg>
  );
}

function MNode({ node, size = "", f }: { node: Node; size?: string; f: Flags }) {
  return (
    <div className={`lp-m-step ${size}`}>
      <div className="lp-oct-node" aria-hidden>
        <span className="lp-oct-frame" />
        <NodeArt node={node} />
        {f.arc && NUMBERS[node.id] && <span className="hp-num mono">{NUMBERS[node.id]}</span>}
      </div>
      <b>{node.title}</b>
      {node.sub && <span>{node.sub}</span>}
    </div>
  );
}

function FlowPhone({ f, list }: { f: Flags; list: Node[] }) {
  const [position, advance, play, back] = list;
  return (
    <div className="lp-flow-phone">
      <MNode node={position} f={f} />
      <Link shape="straight" />
      <MNode node={advance} f={f} />
      <Link shape="split" />
      <div className="lp-m-pair">
        <MNode node={play} size="sm" f={f} />
        <MNode node={back} size="sm" f={f} />
      </div>
      <Link shape="merge" />
      <div className="lp-m-step">
        <div className="lp-oct-node settle" aria-hidden>
          <span className="lp-oct-frame" />
          <span className="lp-settle-label">Settle</span>
        </div>
      </div>
      <Link shape="split" />
      <div className="lp-m-pair">
        {[true, false].map((win) => {
          const c = outcomeCopy(win, f);
          return (
            <div key={String(win)} className={`lp-m-outcome cut cut-frame ${win ? "win" : "lose"}`}>
              <div className="lp-oct-node" aria-hidden>
                <span className="lp-oct-frame" />
                {landingArt(win ? "step5" : "step1") && <Picture k={win ? "step5" : "step1"} sizes="72px" />}
              </div>
              <b>{win ? "Win" : "Lose"}</b>
              {c.big && <em className="hp-amount">{c.big}</em>}
              <span>
                {c.line}
                {c.small && <> {c.small}</>}
              </span>
            </div>
          );
        })}
      </div>
      {f.arc && (
        <div className="hp-m-return">
          <span aria-hidden>↺</span>
          <p>
            <b>Either way, yield repays the Debt.</b> At zero your Position unlocks: take your Principal back, or take another Advance.
          </p>
        </div>
      )}
    </div>
  );
}

function HowFlow(f: Flags) {
  const H = f.arc ? 640 : 520;
  const pct = (x: number, y: number) => ({ left: `${(x / W) * 100}%`, top: `${(y / H) * 100}%` });
  const list = nodes(f);
  const tubes = f.arc ? [...TUBES, ARC] : TUBES;
  const steps = f.guided ? STEPS : [];
  const [step, setStep] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!f.guided || paused) return;
    const t = window.setTimeout(() => setStep((s) => (s + 1) % steps.length), 4200);
    return () => window.clearTimeout(t);
  }, [f.guided, paused, step, steps.length]);
  const cur = f.guided ? steps[step] : null;
  const onNode = (id: NodeId) => !cur || cur.nodes.includes(id);
  const onTube = (i: number) => !cur || cur.tubes.includes(i);
  const onOutcome = !cur || !!cur.outcomes;
  const jump = (id: NodeId) => {
    if (!f.guided) return;
    setStep(Math.max(0, steps.findIndex((s) => s.nodes[s.nodes.length - 1] === id || (id === "position" && s.nodes[0] === id))));
    setPaused(true);
  };
  const guide = landingArt("himGuide");

  return (
    <section id="how-it-works" className={`lp-section lp-how${f.polish ? " hp-polish" : ""}${f.guided ? " hp-guided" : ""}`} aria-labelledby="how-title">
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
            <h2 id="how-title" className="lp-h2">
              How it works
            </h2>
            <p className="lp-lede lp-measure">Your stake earns yield. Tesoro hands you that yield now, as Gemas, and the yield pays it back while you play.</p>
          </div>
        </header>

        <figure
          className="lp-flowmap"
          style={{ aspectRatio: `${W} / ${H}` }}
          onMouseEnter={() => f.guided && setPaused(true)}
          onMouseLeave={() => f.guided && setPaused(false)}
          aria-label="Open a Position, take an Advance as Gemas, then play yourself or back a Player. At settlement the winner takes the loser's Gemas, paid out as their yield lands; the loser's Position stays locked until its yield repays the Advance."
        >
          <svg viewBox={`0 0 ${W} ${H}`} fill="none" strokeLinecap="round" aria-hidden>
            <defs>
              <filter id="hp-tube-glow" x="-10%" y="-40%" width="120%" height="180%">
                <feGaussianBlur stdDeviation="6" />
              </filter>
              <marker id="hp-arc-head" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto">
                <path d="M1.5 1.5L8 5L1.5 8.5" fill="none" stroke="#2fdcae" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </marker>
            </defs>
            {["tube-glow", "tube-outer", "tube-core", "tube-hi"].map((layer) => (
              <g key={layer} className={layer} filter={layer === "tube-glow" ? "url(#hp-tube-glow)" : undefined}>
                {tubes.map((d, i) => (
                  <path key={d} d={d} className={`${onTube(i) ? "" : "off"}${i === ARC_INDEX ? " arc" : ""}`} />
                ))}
              </g>
            ))}
            {f.arc && <path d={ARC} className="hp-arc-flow" markerEnd="url(#hp-arc-head)" />}
            <g className="lp-flow-dots">
              {tubes.map((d, i) =>
                onTube(i) ? (
                  <circle key={d} r="4">
                    <animateMotion
                      dur={i === ARC_INDEX ? "7s" : `${2.4 + (i % 3) * 0.3}s`}
                      begin={`-${(i * 0.37).toFixed(2)}s`}
                      repeatCount="indefinite"
                      path={d}
                    />
                  </circle>
                ) : null,
              )}
            </g>
          </svg>

          {list.map((n) => (
            <div
              key={n.id}
              className={`lp-oct-node n-${n.id}${n.small ? " settle" : ""}${onNode(n.id) ? "" : " off"}${f.guided ? " hp-click" : ""}`}
              style={pct(n.x, n.y)}
              onClick={() => jump(n.id)}
              aria-hidden
            >
              <span className="lp-oct-frame" />
              {n.small ? <span className="lp-settle-label">Settle</span> : <NodeArt node={n} />}
              {f.arc && <span className="hp-num mono">{NUMBERS[n.id]}</span>}
            </div>
          ))}
          {f.polish && (
            <span className="hp-lock mono" style={pct(92, 132)}>
              <Lock /> Never played
            </span>
          )}
          {list
            .filter((n) => !n.small)
            .map((n) => (
              <div key={n.id} className={`lp-flow-label l-${n.id}${onNode(n.id) ? "" : " off"}${f.amounts && n.id === "advance" ? " hp-em-sub" : ""}`} style={pct(...n.label)}>
                <b>{n.title}</b>
                {n.sub && <span>{n.sub}</span>}
              </div>
            ))}
          {[true, false].map((win) => (
            <div
              key={String(win)}
              className={`lp-outcome-card cut cut-frame ${win ? "win" : "lose"}${onOutcome ? "" : " off"}`}
              style={{ ...pct(890, win ? 100 : 372), height: `${(130 / H) * 100}%` } as CSSProperties}
            >
              <div className="lp-oct-node small" aria-hidden>
                <span className="lp-oct-frame" />
                {landingArt(win ? "step5" : "step1") && <Picture k={win ? "step5" : "step1"} sizes="96px" />}
              </div>
              <OutcomeBody win={win} f={f} />
            </div>
          ))}
          {f.arc && (
            <div className={`hp-arc-label${onTube(ARC_INDEX) ? "" : " off"}`} style={pct(578, 598)}>
              <b>Either way, yield repays the Debt</b>
              <span>At zero your Position unlocks: Principal back, or another Advance</span>
            </div>
          )}
        </figure>

        {cur && (
          <div className="hp-caption" aria-live="polite">
            <span className="mono">
              {step + 1}/{steps.length}
            </span>
            <p>{cur.text}</p>
            <div className="hp-dots">
              {steps.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  className={i === step ? "on" : ""}
                  aria-label={`Step ${i + 1}`}
                  onClick={() => {
                    setStep(i);
                    setPaused(true);
                  }}
                />
              ))}
            </div>
          </div>
        )}

        <FlowPhone f={f} list={list} />
        {f.amounts && <p className="hp-example mono">Example: 10 SOL, 6-month Horizon, ~7% a year, SOL at $150.</p>}
        <p className="lp-flow-foot">
          <b>Your Principal is never played.</b> Only future yield moves.
        </p>
      </div>
    </section>
  );
}
