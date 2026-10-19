"use client";

import { useState, type ReactNode } from "react";
import { pushFeed } from "./feed";
import { usePanelStyle } from "./panels";
import { PanelSwitcher } from "./PanelSwitcher";
import "./vanguard.css";
import "./panels.css";

export interface TurnInfo {
  /** Whose turn it is, in words ("Your turn", "Italy's turn", "Two-Step · 1 left"); empty before the Match starts and after it ends. */
  label: string;
  /** Two-Step Turns you have banked. */
  banked: number;
  /** A Two-Step Turn is being played right now. */
  active: boolean;
  /** It is your turn and you may act. */
  yourTurn: boolean;
  /** You already made a step this turn, so a Two-Step Turn can't start. */
  moved: boolean;
  onUse: () => void;
}

/** Where the Two-Step Turn button is and what it tells you: next to whose turn it is, never tucked in a seat bar. */
export function TurnBox({ turn }: { turn: TurnInfo }) {
  const { banked, active, yourTurn, moved } = turn;
  // a new Two-Step Turn earned replays the highlight: the button remounts under a new key
  const [seen, setSeen] = useState(banked);
  const [earned, setEarned] = useState(0);
  if (banked !== seen) {
    setSeen(banked);
    if (banked > seen) setEarned((n) => n + 1);
  }
  const showButton = turn.label !== "" && banked > 0 && !active;
  const ready = showButton && yourTurn && !moved;
  const hint = !showButton ? "" : !yourTurn ? "Banked. Press it on your turn to move twice." : moved ? "Press it before your first step." : "Press it to move twice this turn.";
  // nothing to say before the Match starts or after it ends: no empty box
  if (!turn.label) return null;
  return (
    <div className="vg-turnbox">
      <span className="vg-turn">{turn.label}</span>
      {showButton && (
        <button key={earned} type="button" className={`vg-two${ready ? " ready" : ""}${earned ? " earned" : ""}`} onClick={turn.onUse} disabled={!ready}>
          Use Two-Step Turn{banked > 1 ? ` ×${banked}` : ""}
        </button>
      )}
      {hint && <small className="vg-hint">{hint}</small>}
    </div>
  );
}

/** Messages, newest first: the latest is prominent, a few older ones fade (the narrow layout shows only the latest). */
function Feed({ say }: { say: string }) {
  const [feed, setFeed] = useState(() => pushFeed([], say));
  const [last, setLast] = useState(say);
  // how many messages have come in: numbers the lines and remounts the newest so it animates in
  const [count, setCount] = useState(say ? 1 : 0);
  if (say !== last) {
    setLast(say);
    const next = pushFeed(feed, say);
    setFeed(next);
    if (next[0] !== feed[0]) setCount((n) => n + 1);
  }
  const no = (i: number) => String(Math.max(1, count - i)).padStart(3, "0");
  return (
    <div className="vg-feed">
      <h3 className="vg-feed-h">Field log</h3>
      <p key={count} className="vg-say" aria-live="polite" data-n={no(0)}>{feed[0] ?? ""}</p>
      {feed.slice(1).map((m, i) => (
        <p key={`${i}-${m}`} className="vg-old" aria-hidden="true" data-age={i + 1} data-n={no(i + 1)}>{m}</p>
      ))}
    </div>
  );
}

/**
 * The Vanguard screen, shared by Practice and a real Match. Stacked on narrow screens (header, Italy's seat,
 * roster, board, your seat, turn, message). Wide (about 900px or more): the board centred at the height that fits,
 * Italy's seat and the roster on the left, the message feed, turn state, Two-Step Turn button and your seat on the right.
 */
export function VanguardScreen({ bar, foe, roster, stage, me, turn, say, switchable, children }: { bar: ReactNode; foe: ReactNode; roster: ReactNode; stage: ReactNode; me: ReactNode; turn: TurnInfo; say: string; /** Practice only: show the temporary side-panel style switcher. */ switchable?: boolean; children?: ReactNode }) {
  const [panels, pick] = usePanelStyle(!!switchable);
  return (
    <div className="vg-screen" data-panels={panels}>
      {switchable && <PanelSwitcher value={panels} onChange={pick} />}
      <div className="vg-layout">
        <div className="vg-left">
          {bar}
          {foe}
          {roster}
        </div>
        {stage}
        <div className="vg-right">
          {me}
          <TurnBox turn={turn} />
          <Feed say={say} />
          {children}
        </div>
      </div>
    </div>
  );
}
