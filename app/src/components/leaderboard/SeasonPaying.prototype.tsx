"use client";

// PROTOTYPE: the "Season N has ended and its prizes are being paid" notice, ?variant=now|A|B|C|D.
// Throwaway: the winner gets rewritten into Leaderboard.tsx / leaderboard.css, the rest stays on proto/season-paying-11-10-2026.
import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { PrototypeSwitcher, usePrototypeVariant } from "@/components/prototype/PrototypeSwitcher";
import { Chest } from "@/components/shell/PoolChest";
import { GemaMark } from "@/components/ui";
import { PRIZE_BPS, PRIZE_PLACES } from "@/lib/chain/season";
import "./season-paying.prototype.css";

const VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Payout ribbon" },
  { key: "B", name: "Hero tab" },
  { key: "C", name: "Winners slot" },
  { key: "D", name: "Handover track" },
] as const;

export interface PayingProps {
  /** The season that ended. */
  settling: number;
  /** When it ended (unix seconds) = this season's start. */
  endedAt: number;
  /** Server clock, ticking; null before the first tick. */
  now: number | null;
  /** This season. */
  current: number;
}

function ago(secs: number): string {
  const m = Math.max(1, Math.floor(secs / 60));
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}
const endedLabel = (at: number) =>
  new Date(at * 1000).toLocaleString("en", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });

/** Lifts the chest lid every few seconds while prizes are going out. */
function usePop(ms: number) {
  const [pop, setPop] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setPop((p) => p + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
  return pop;
}

/** Mounted twice: `above` the hero (only B uses it) and `below` it (the rest, plus the switcher). */
export function SeasonPaying({ slot, ...props }: PayingProps & { slot: "above" | "below" }) {
  const v = usePrototypeVariant(VARIANTS.map((x) => x.key));
  const View = { now: Now, A: Ribbon, B: HeroTab, C: WinnersSlot, D: Handover }[v];
  if (slot === "above") return v === "B" ? <View {...props} /> : null;
  return (
    <>
      {v !== "B" && <View {...props} />}
      <PrototypeSwitcher variants={VARIANTS} />
    </>
  );
}

function Now({ settling }: PayingProps) {
  return (
    <p className="note" role="status">
      Season {settling} has ended and its prizes are being paid.
    </p>
  );
}

/** A: a gold-edged strip under the hero. Chest throwing Gemas, the status in words, a running bar. */
function Ribbon({ settling, endedAt, now }: PayingProps) {
  const pop = usePop(2600);
  return (
    <section className="cut cut-card sp-ribbon" role="status" aria-label={`Season ${settling} payout`}>
      <span className="sp-ribbon-chest">
        <Chest size={64} pop={pop} />
      </span>
      <div className="sp-ribbon-copy">
        <span className="sp-kicker">
          Season {settling} · ended {now === null ? "" : ago(now - endedAt)}
        </span>
        <b className="sp-ribbon-title">Prizes are on their way</b>
        <p>The top {PRIZE_PLACES} are being paid from the Leaderboard Pool. The winners show here once it’s done.</p>
      </div>
      <div className="sp-ribbon-state">
        <span className="sp-paying">Paying</span>
        <span className="sp-run" aria-hidden="true" />
      </div>
    </section>
  );
}

/** B: no block of its own. A gold tab clipped onto the hero's top edge, like a label on the chest. */
function HeroTab({ settling, current }: PayingProps) {
  return (
    <div className="sp-tab-row">
      <div className="sp-tab" role="status">
        <span className="sp-tab-gem" aria-hidden="true">
          <GemaMark size={16} />
        </span>
        <span>
          <b>Season {settling} is paying out</b>
          <span className="sp-tab-sub"> · Season {current} is on, every win counts</span>
        </span>
      </div>
    </div>
  );
}

/** C: the winners section, already in place, its ten seats waiting to be filled. Light runs down the seats in order. */
function WinnersSlot({ settling, endedAt, now }: PayingProps) {
  return (
    <section className="sp-slot" aria-labelledby="sp-slot-h">
      <header className="lb-sec-head">
        <h2 id="sp-slot-h" className="h-section">Season {settling} winners</h2>
        <span className="sp-slot-state" role="status">
          <span className="sp-dot" aria-hidden="true" />
          Paying the top {PRIZE_PLACES}
          {now !== null && <span className="sp-slot-ago"> · ended {ago(now - endedAt)}</span>}
        </span>
      </header>
      <ol className="sp-seats">
        {PRIZE_BPS.map((bps, i) => (
          <li key={i} className={`cut cut-card sp-seat${i < 3 ? " top" : ""}`} style={{ "--i": i } as React.CSSProperties}>
            <span className="sp-seat-rank">{i + 1}</span>
            <span className="sp-seat-ghost" aria-hidden="true">
              <i />
              <i />
            </span>
            <span className="sp-seat-share">{bps / 100}%</span>
            <span className="sp-seat-sweep" aria-hidden="true" />
          </li>
        ))}
      </ol>
      <p className="note">Names and prizes appear here as soon as the payout is done.</p>
    </section>
  );
}

/** D: the week turning over as three steps: ended, paying, winners posted. The middle one is live. */
function Handover({ settling, endedAt, current }: PayingProps) {
  const steps = [
    { title: `Season ${settling} ended`, sub: endedLabel(endedAt), state: "done" },
    { title: `Paying the top ${PRIZE_PLACES}`, sub: "From the Leaderboard Pool", state: "live" },
    { title: "Winners posted", sub: "Right here, with their prizes", state: "next" },
  ] as const;
  return (
    <section className="cut cut-card sp-hand" role="status" aria-label={`Season ${settling} payout`}>
      <ol className="sp-steps">
        {steps.map((s, i) => (
          <li key={i} className={`sp-step ${s.state}`} aria-current={s.state === "live" ? "step" : undefined}>
            <span className="sp-node" aria-hidden="true">
              {s.state === "done" ? <Check size={16} strokeWidth={3} /> : s.state === "live" ? <GemaMark size={18} /> : null}
            </span>
            <b>{s.title}</b>
            <small>{s.sub}</small>
          </li>
        ))}
      </ol>
      <p className="sp-hand-foot">
        Season {current} is already on: every win from now counts toward next Monday.
      </p>
    </section>
  );
}
