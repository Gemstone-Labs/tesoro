"use client";

import { Check, Minus, X } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { GemaMark } from "@/components/ui/gema";

const ENTRIES = [500, 1000, 2500];
const fmt = (n: number) => n.toLocaleString("en-US");

/** One outcome as two lanes: what comes back to you and what goes to the Player. Widths are shares, not Fee-exact amounts. */
function Lanes({ you, them }: { you: ReactNode; them: ReactNode }) {
  return (
    <div className="lp-lanes">
      <span className="lp-lane-k mono">You</span>
      <span className="lp-lane">{you}</span>
      <span className="lp-lane-k mono">Player</span>
      <span className="lp-lane">{them}</span>
    </div>
  );
}

/** A Backer's Offer, live: pick the entry and the Player's share, and see who gets what. No Fee figures: they aren't set yet. */
export function OfferDemo() {
  const [entry, setEntry] = useState(1000);
  const [share, setShare] = useState(40);
  const id = useId();
  const yours = 100 - share;
  return (
    <div className="lp-offer cut cut-frame">
      <div className="lp-offer-top">
        <p className="lp-offer-title">Make an Offer</p>
        <span className="lp-offer-stake">
          <GemaMark size={16} /> {fmt(entry)}
        </span>
      </div>
      <div className="lp-entries" role="radiogroup" aria-label="Entry">
        {ENTRIES.map((e) => (
          <button key={e} type="button" role="radio" aria-checked={e === entry} className={`lp-entry cut cut-chip${e === entry ? " on" : ""}`} onClick={() => setEntry(e)}>
            {fmt(e)}
          </button>
        ))}
      </div>
      <div className="lp-offer-field">
        <label className="label" htmlFor={`${id}-share`}>
          Player&rsquo;s share <b className="lp-offer-pct">{share}%</b>
        </label>
        <input id={`${id}-share`} type="range" min={10} max={90} step={5} value={share} onChange={(e) => setShare(Number(e.target.value))} className="lp-range" />
      </div>

      <div className="lp-outcomes-v">
        <div className="lp-oc win">
          <span className="lp-oc-head">
            <Check aria-hidden /> Win
          </span>
          <Lanes
            you={
              <>
                <i className="seg entry" style={{ flex: 50 }}>
                  {fmt(entry)} back
                </i>
                <i className="seg you" style={{ flex: (50 * yours) / 100 }}>
                  +{yours}%
                </i>
              </>
            }
            them={
              <i className="seg them" style={{ flex: (50 * share) / 100, maxWidth: `${(50 * share) / 100}%` }}>
                +{share}%
              </i>
            }
          />
        </div>
        <div className="lp-oc lose">
          <span className="lp-oc-head">
            <X aria-hidden /> Loss
          </span>
          <Lanes
            you={
              <i className="seg lost" style={{ flex: 50, maxWidth: "50%" }}>
                −{fmt(entry)}
              </i>
            }
            them={<i className="seg zero">owes 0</i>}
          />
        </div>
        <div className="lp-oc draw">
          <span className="lp-oc-head">
            <Minus aria-hidden /> Draw
          </span>
          <Lanes
            you={
              <i className="seg entry" style={{ flex: 50, maxWidth: "50%" }}>
                {fmt(entry)} back
              </i>
            }
            them={<i className="seg zero">0</i>}
          />
        </div>
      </div>
      <p className="lp-offer-note mono">+% = share of the surplus, after Fees</p>
    </div>
  );
}
