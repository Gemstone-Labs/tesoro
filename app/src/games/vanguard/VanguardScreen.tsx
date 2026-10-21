"use client";

import { useState, type ReactNode } from "react";
import { pushFeed } from "./feed";
import "./vanguard.css";

/** The selected piece's power: a button with the power's name, a preview step for Blast and Rescue, and a line saying what it does. */
export interface PowerInfo {
  label: string;
  hint: string;
  /** Waiting for the confirm tap (the preview is on the board). */
  armed: boolean;
  onPress: () => void;
  onCancel: () => void;
}

/** Become a Spy, on the selected General of the Army: a toggle, and a one-way warning the first time it is turned on. */
export interface SpyInfo {
  on: boolean;
  /** Show the warning and wait for a yes. */
  warning: boolean;
  onToggle: () => void;
  onConfirm: () => void;
  onDismiss: () => void;
}

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
  power?: PowerInfo | null;
  spy?: SpyInfo | null;
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
  const { power, spy } = turn;
  const twoHint = !showButton ? "" : !yourTurn ? "Banked. Press it on your turn to move twice." : moved ? "Press it before your first step." : "Press it to move twice this turn.";
  const hint = yourTurn && power ? power.hint : yourTurn && spy?.on ? "Becoming a Spy is free: now make your move. It stays secret until a fight shows it." : twoHint;
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
      {yourTurn && power && (
        <>
          <button type="button" className={`vg-power${power.armed ? " armed" : ""}`} onClick={power.onPress}>
            {power.armed ? `Confirm ${power.label}` : power.label}
          </button>
          {power.armed && (
            <button type="button" className="vg-link" onClick={power.onCancel}>
              Cancel
            </button>
          )}
        </>
      )}
      {yourTurn && spy && (
        <button type="button" className="vg-spy-t" aria-pressed={spy.on} onClick={spy.onToggle}>
          Become a Spy
        </button>
      )}
      {yourTurn && spy?.warning && (
        <div className="vg-warn" role="alertdialog" aria-label="Become a Spy is one way">
          <span>Your General of the Army becomes a Spy for good. It can beat the enemy 10 when it attacks, but it is only a 1 in every other fight and can never turn back.</span>
          <span className="vg-warn-row">
            <button type="button" className="vg-power armed" onClick={spy.onConfirm}>
              Become a Spy
            </button>
            <button type="button" className="vg-link" onClick={spy.onDismiss}>
              Not now
            </button>
          </span>
        </div>
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
export function VanguardScreen({ bar, foe, roster, stage, me, turn, say, children }: { bar: ReactNode; foe: ReactNode; roster: ReactNode; stage: ReactNode; me: ReactNode; turn: TurnInfo; say: string; children?: ReactNode }) {
  return (
    <div className="vg-screen">
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
