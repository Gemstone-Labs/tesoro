"use client";

import { useId, useState } from "react";
import { Button, GemaMark } from "@/components/ui";
import { backedSplit } from "@/lib/chain/ledger";
import { LEADERBOARD_BPS } from "@/lib/chain/season";
import { fmtGemas } from "@/lib/format";

/** A worked Offer for the empty Requests tab. Fees are the test-mode registry's (2% Platform + 3% Studio) plus the 1% Leaderboard Fee. */
const EXAMPLE = { entry: 1000, platformBps: 200, studioBps: 300, leaderboardBps: LEADERBOARD_BPS, shareBps: 5000 };

function Gemas({ n, sign = false }: { n: number; sign?: boolean }) {
  return (
    <b className="tnum bk-ex-n">
      <GemaMark size={14} />
      {sign && n < 0 ? "−" : ""}
      {fmtGemas(Math.abs(n))}
    </b>
  );
}

type Segment = { key: string; label: string; n: number };

/**
 * HOW BACKING WORKS: shown while there are no live Requests. One example Offer with the real split
 * rule, drawn to scale: where every Gema of the Pot goes if the Player wins, or loses (toggle).
 */
export function BackingExample({ onPost }: { onPost: () => void }) {
  const [won, setWon] = useState(true);
  const group = useId();
  const share = EXAMPLE.shareBps / 100;
  const win = backedSplit({ ...EXAMPLE, won: true });
  const segments: Segment[] = won
    ? [
        { key: "back", label: "Your entry back", n: win.backerEntryBack },
        { key: "you", label: `Your share (${100 - share}%)`, n: win.backerSurplus },
        { key: "player", label: `Player’s share (${share}%)`, n: win.playerShare },
        { key: "fees", label: "Fees", n: win.fees },
      ]
    : [
        { key: "lost", label: "You lose your entry", n: -EXAMPLE.entry },
        { key: "opp", label: "The Player loses nothing", n: 0 },
      ];
  // Every segment stays mounted so the bar morphs between outcomes; absent ones shrink to nothing.
  const grow: Record<string, number> = won
    ? { back: win.backerEntryBack, you: win.backerSurplus, player: win.playerShare, fees: win.fees, lost: 0, opp: 0 }
    : { back: 0, you: 0, player: 0, fees: 0, lost: EXAMPLE.entry, opp: EXAMPLE.entry };

  return (
    <section className="cut cut-card bk-span bk-ex" aria-labelledby="bk-ex-h">
      <header className="bk-ex-head">
        <div>
          <h2 id="bk-ex-h" className="h-section">How Backing works</h2>
          <p>
            You pay a Player’s whole entry. If they win, the Pot pays you first. Example: a <Gemas n={EXAMPLE.entry} /> Match, and the Player keeps {share}%.
          </p>
        </div>
        <Button onClick={onPost}>Post a Request</Button>
      </header>
      <div className="bk-ex-case">
        <div className="bk-ex-bar-h">
          <fieldset className="cut rail bk-ex-toggle" style={{ ["--i" as string]: won ? 0 : 1 }}>
            <legend className="sr-only">Outcome</legend>
            <span className="rail-thumb" aria-hidden="true" />
            {[true, false].map((w) => (
              <label key={String(w)}>
                <input type="radio" name={group} checked={won === w} onChange={() => setWon(w)} />
                <span className="cut">{w ? "Player wins" : "Player loses"}</span>
              </label>
            ))}
          </fieldset>
          <span className="meta">{won ? <>Pot <Gemas n={EXAMPLE.entry * 2} /></> : "The Pot goes to the opponent"}</span>
        </div>
        <div className="bk-ex-bar" role="img" aria-label={segments.map((s) => `${s.label}: ${fmtGemas(Math.abs(s.n))} Gemas`).join(", ")}>
          {Object.entries(grow).map(([key, g]) => <i key={key} className={key} style={{ flexGrow: g }} />)}
        </div>
        <ul className="bk-ex-legend" aria-hidden="true">
          {segments.map((s) => (
            <li key={s.key} className={s.key} style={{ flexGrow: grow[s.key] }}>
              <span className="bk-ex-sw" />
              {s.label}
              <Gemas n={s.n} sign />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
