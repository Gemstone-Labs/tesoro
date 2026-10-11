"use client";

import { ChevronDown } from "lucide-react";
import { useId, useSyncExternalStore } from "react";
import { Button, GemaMark } from "@/components/ui";
import { CheckIcon, XIcon } from "@/components/ui/icons";
import { backedSplit } from "@/lib/chain/ledger";
import { LEADERBOARD_BPS } from "@/lib/chain/season";
import { fmtGemas } from "@/lib/format";

/** A worked Offer for the empty Requests tab. Fees are the test-mode registry's (2% Platform + 3% Studio) plus the 1% Leaderboard Fee. */
const EXAMPLE = { entry: 1000, platformBps: 200, studioBps: 300, leaderboardBps: LEADERBOARD_BPS, shareBps: 5000 };

/** Whether the viewer hid the card, remembered in this browser only. */
const HIDDEN_KEY = "tesoro-backing-how-hidden";
const EVENT = "tesoro-backing-how";
function readHidden() {
  try {
    return localStorage.getItem(HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}
function writeHidden(hidden: boolean) {
  try {
    if (hidden) localStorage.setItem(HIDDEN_KEY, "1");
    else localStorage.removeItem(HIDDEN_KEY);
  } catch {}
  window.dispatchEvent(new Event(EVENT));
}
function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

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

function Split({ won, title, meta, segments }: { won: boolean; title: string; meta: React.ReactNode; segments: Segment[] }) {
  return (
    <div className="bk-ex-case">
      <div className="bk-ex-case-h">
        <span className={`bk-ex-ico ${won ? "won" : "lost"}`}>{won ? <CheckIcon /> : <XIcon />}</span>
        <b>{title}</b>
        <span className="meta">{meta}</span>
      </div>
      <div className="bk-ex-bar" role="img" aria-label={segments.map((s) => `${s.label}: ${fmtGemas(Math.abs(s.n))} Gemas`).join(", ")}>
        {segments.map((s) => <i key={s.key} className={s.key} style={{ flexGrow: Math.abs(s.n) || EXAMPLE.entry }} />)}
      </div>
      <ul className="bk-ex-legend" aria-hidden="true">
        {segments.map((s) => (
          <li key={s.key} className={s.key} style={{ flexGrow: Math.abs(s.n) || EXAMPLE.entry }}>
            <span className="bk-ex-sw" />
            {s.label}
            <Gemas n={s.n} sign />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * HOW BACKING WORKS: shown while there are no live Requests. One example Offer with the real split
 * rule, drawn to scale: where every Gema of the Pot goes if the Player wins, and what a loss costs.
 * The viewer can hide it down to its title bar.
 */
export function BackingExample({ onPost }: { onPost: () => void }) {
  const hidden = useSyncExternalStore(subscribe, readHidden, () => false);
  const bodyId = useId();
  const share = EXAMPLE.shareBps / 100;
  const win = backedSplit({ ...EXAMPLE, won: true });

  return (
    <section className={`cut cut-card bk-span bk-ex${hidden ? " closed" : ""}`} aria-labelledby="bk-ex-h">
      <header className="bk-ex-head">
        <h2 id="bk-ex-h" className="h-section">How Backing works</h2>
        <div className="bk-ex-actions">
          {!hidden && <Button onClick={onPost}>Post a Request</Button>}
          <button type="button" className="bk-ex-fold" aria-expanded={!hidden} aria-controls={bodyId} onClick={() => writeHidden(!hidden)}>
            {hidden ? "Show" : "Hide"}
            <ChevronDown aria-hidden="true" />
          </button>
        </div>
      </header>
      <div id={bodyId} className="bk-ex-body" hidden={hidden}>
        <p className="bk-ex-lede">
          You pay a Player’s whole entry. If they win, the Pot pays you first. Example: a <Gemas n={EXAMPLE.entry} /> Match, and the Player keeps {share}%.
        </p>
        <Split
          won
          title="Player wins"
          meta={<>Pot <Gemas n={EXAMPLE.entry * 2} /></>}
          segments={[
            { key: "back", label: "Your entry back", n: win.backerEntryBack },
            { key: "you", label: `Your share (${100 - share}%)`, n: win.backerSurplus },
            { key: "player", label: `Player’s share (${share}%)`, n: win.playerShare },
            { key: "fees", label: "Fees", n: win.fees },
          ]}
        />
        <Split
          won={false}
          title="Player loses"
          meta="The Pot goes to the opponent"
          segments={[
            { key: "lost", label: "You lose your entry", n: -EXAMPLE.entry },
            { key: "opp", label: "The Player loses nothing", n: 0 },
          ]}
        />
      </div>
    </section>
  );
}
