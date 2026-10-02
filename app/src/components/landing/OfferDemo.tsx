"use client";

import { Check, Minus, X } from "lucide-react";
import { useId, useState } from "react";
import { GemaMark } from "@/components/ui/gema";

const ENTRIES = [500, 1000, 2500];
const fmt = (n: number) => n.toLocaleString("en-US");

/** A Backer's Offer, live: pick the entry and the Player's share, and see who gets what. No Fee figures: they aren't set yet. */
export function OfferDemo() {
  const [entry, setEntry] = useState(1000);
  const [share, setShare] = useState(40);
  const id = useId();
  const yours = 100 - share;
  return (
    <div className="lp-offer cut cut-frame">
      <p className="lp-offer-title">Make an Offer</p>
      <div className="lp-offer-field">
        <span className="label" id={`${id}-entry`}>
          Entry
        </span>
        <div className="lp-entries" role="radiogroup" aria-labelledby={`${id}-entry`}>
          {ENTRIES.map((e) => (
            <button key={e} type="button" role="radio" aria-checked={e === entry} className={`lp-entry cut cut-chip${e === entry ? " on" : ""}`} onClick={() => setEntry(e)}>
              {e === entry && <GemaMark size={14} />}
              {fmt(e)}
            </button>
          ))}
        </div>
      </div>
      <div className="lp-offer-field">
        <label className="label" htmlFor={`${id}-share`}>
          Player&rsquo;s share of the surplus <b className="lp-offer-pct">{share}%</b>
        </label>
        <input id={`${id}-share`} type="range" min={10} max={90} step={5} value={share} onChange={(e) => setShare(Number(e.target.value))} className="lp-range" style={{ ["--p" as string]: `${share}%` }} />
      </div>
      <ul className="lp-outcome-list">
        <li>
          <span className="lp-outcome-head">
            <Check aria-hidden /> <b>They win</b>
          </span>
          <span className="lp-split" aria-hidden>
            <span className="entry" style={{ flex: 50 }}>
              Your {fmt(entry)} back
            </span>
            <span className="you" style={{ flex: (50 * yours) / 100 }}>
              {yours}%
            </span>
            <span className="them" style={{ flex: (50 * share) / 100 }}>
              {share}%
            </span>
          </span>
          <span className="lp-body">
            Your {fmt(entry)} Gemas come back first. The surplus (the opponent&rsquo;s entry after Fees) splits {yours}% to you, {share}% to the Player.
          </span>
        </li>
        <li>
          <span className="lp-outcome-head">
            <X aria-hidden /> <b>They lose</b>
          </span>
          <span className="lp-body">You lose the {fmt(entry)} Gemas. The Player owes nothing.</span>
        </li>
        <li>
          <span className="lp-outcome-head">
            <Minus aria-hidden /> <b>Draw or refund</b>
          </span>
          <span className="lp-body">Your {fmt(entry)} Gemas come back.</span>
        </li>
      </ul>
    </div>
  );
}
