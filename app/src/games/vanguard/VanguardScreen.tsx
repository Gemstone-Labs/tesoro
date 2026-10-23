"use client";

import { useState, type ReactNode } from "react";
import { BookOpen } from "lucide-react";
import { GameMenu } from "../fx";
import { pushFeed } from "./feed";
import "./vanguard.css";

/** The selected piece's power: one button with the power's name and a line saying what it does. One tap does it. */
export interface PowerInfo {
  label: string;
  hint: string;
  onPress: () => void;
}

/** Become a Spy, on the selected General of the Army: the same kind of button; one tap switches it (on the turn's action), a second tap takes it back. */
export interface SpyInfo {
  on: boolean;
  onPress: () => void;
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

/** The bar over the opponent: PRACTICE in Practice and the ⋯ menu (Ranks and powers, sound, full screen, Leave in Practice). */
export function VgBar({ practice = false, onRules }: { practice?: boolean; onRules: () => void }) {
  return (
    <div className="vg-bar">
      <h1 className="sr-only">Vanguard</h1>
      {practice && <span className="cut cut-chip game-tag">Practice</span>}
      <GameMenu items={[{ label: "Ranks and powers", icon: <BookOpen aria-hidden="true" />, onSelect: onRules }]} leaveHref={practice ? "/play" : undefined} />
    </div>
  );
}

/** An army's flag and the pieces it has left: a number, not a sentence. */
export function ArmyCount({ army, left }: { army: "us" | "it"; left: number }) {
  return (
    <span className={`vg-army ${army}`} aria-label={`${army === "us" ? "US Army" : "Royal Italian Army"}, ${left} of 20 pieces left`}>
      <i aria-hidden="true" />
      <b className="tnum">{left}</b>
    </span>
  );
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
  const hint = yourTurn && power ? power.hint : yourTurn && spy ? (spy.on ? "One way: it stays a Spy." : "Free with your move. One way: it stays a Spy.") : twoHint;
  // nothing to say before the Match starts or after it ends: no empty box
  if (!turn.label) return null;
  return (
    <div className="vg-turnbox">
      <span className="vg-turn" role="status">{turn.label}</span>
      {showButton && (
        <button key={earned} type="button" className={`vg-two${ready ? " ready" : ""}${earned ? " earned" : ""}`} onClick={turn.onUse} disabled={!ready}>
          Two-Step{banked > 1 ? ` ×${banked}` : ""}
        </button>
      )}
      {yourTurn && power && (
        <button type="button" className="vg-power" onClick={power.onPress}>
          {power.label}
        </button>
      )}
      {yourTurn && spy && (
        <button type="button" className={`vg-power${spy.on ? " on" : ""}`} aria-pressed={spy.on} onClick={spy.onPress}>
          {spy.on ? "Undo Spy" : "Become a Spy"}
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
