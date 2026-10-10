"use client";

import { useEffect, useState } from "react";
import { Radio } from "lucide-react";
import { useAccount } from "@/lib/account";
import { ago } from "@/lib/catalogue";
import { shortKey } from "@/lib/chain/useBackingBoard";
import { useRecentSettled } from "@/lib/chain/useRecentSettled";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";

const STEP_MS = 4500;

/** A one-line live ticker of recent settled Matches on Solana devnet. */
export function Ticker() {
  const { matches, loading } = useRecentSettled(8);
  const { snapshot } = useAccount();
  const [i, setI] = useState(0);
  const me = snapshot?.accountKey.toBase58();

  useEffect(() => {
    if (matches.length < 2) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setI((n) => n + 1), STEP_MS);
    return () => clearInterval(t);
  }, [matches.length]);

  const m = matches.length > 0 ? matches[i % matches.length] : null;
  return (
    <div className="cut cut-chip ticker" role="status" aria-live="off" aria-label="Recent settled Matches">
      <Radio aria-hidden="true" />
      {m ? (
        <span key={m.id.toString()} className="ticker-line">
          <b>{m.winner === me ? "You" : shortKey(m.winner)}</b> won <b>{fmtGemas(m.payout)}</b> Gemas
          <i aria-hidden="true">·</i>
          {GAME_NAMES[m.game]}
          {m.scores && (
            <>
              <i aria-hidden="true">·</i>
              {m.scores[0]}–{m.scores[1]}
            </>
          )}
          <i aria-hidden="true">·</i>
          {ago(m.at)}
        </span>
      ) : (
        <span className="ticker-line dim">{loading ? "Loading recent Matches…" : "Live · finished Matches appear here"}</span>
      )}
    </div>
  );
}
