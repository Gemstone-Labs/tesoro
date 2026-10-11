"use client";

import Image from "next/image";
import { AccountLink } from "@/components/account/AccountLink";
import { PlayerAvatar, PlayerName } from "@/components/account/Player";
import { CountUp } from "@/components/ui";
import { Callout } from "../fx";
import { ChipStack } from "./ChipStack";
import type { Say } from "./useTableFeed";

const chips = (n: bigint | number) => Number(n).toLocaleString("en-US");

/** The avatar with the turn ring around it: it drains as the clock runs, or just glows with no clock. */
function Avatar({ account, picture, active, fraction, low }: { account?: string; picture?: string; active: boolean; fraction: number; low: boolean }) {
  return (
    <span className={`hd-ava${active ? " active" : ""}${low ? " low" : ""}`}>
      <svg className="hd-ring" viewBox="0 0 64 64" aria-hidden="true">
        <circle className="hd-ring-track" cx="32" cy="32" r="29" />
        <circle className="hd-ring-arc" cx="32" cy="32" r="29" pathLength={1} strokeDasharray="1" strokeDashoffset={active ? 1 - Math.min(1, Math.max(0, fraction)) : 1} />
      </svg>
      {account ? <PlayerAvatar account={account} size={52} className="hd-ava-img" /> : picture ? <Image className="hd-ava-img" src={picture} alt="" width={52} height={52} /> : null}
    </span>
  );
}

export function Seat({
  who,
  address,
  account,
  picture,
  linked,
  stack,
  bet,
  dealer,
  active,
  fraction,
  low,
  allIn,
  missed,
  say,
  label,
  tag,
  mine,
  index,
  children,
}: {
  who: string;
  /** A plain label in place of a Player (the practice bot). */
  address?: string;
  /** The Player's Account key, as shown everywhere else (the table itself holds wallets). */
  account?: string;
  /** An avatar picture for a seat with no Account (practice). */
  picture?: string;
  /** Link the key to the Account: only once the Match has ended, never during a hand. */
  linked?: boolean;
  stack: bigint;
  bet: bigint;
  dealer: boolean;
  active: boolean;
  /** Share of the turn clock left, 0..1 (1 with no clock). */
  fraction: number;
  low: boolean;
  allIn: boolean;
  missed: number;
  /** What this seat just did. */
  say: Say | null;
  /** The plain-words name of the hand, under the cards. */
  label?: string | null;
  /** The hand's outcome for this seat, in words ("Winner", "Split"). */
  tag?: string | null;
  mine?: boolean;
  /** Seat number, for finding the bet on screen. */
  index: number;
  children: React.ReactNode;
}) {
  return (
    <div className={`hdx-seat${mine ? " mine" : ""}${active ? " active" : ""}`}>
      <div className="hd-cards">{children}</div>
      {label && (
        <span className="cut hd-handlabel" aria-live="polite">
          {label}
        </span>
      )}
      <div className={`cut hdx-plaque${tag ? " won" : ""}`} data-seat={index}>
        <Avatar account={account} picture={picture} active={active} fraction={fraction} low={low} />
        <div className="hd-plaque-text">
          <div className="hd-name">
            <strong>{who}</strong>
            {active && <span className="hd-turn">To act</span>}
            {tag && <span className="hd-turn won">{tag}</span>}
            <span className="mono hd-addr">{account ? linked ? <AccountLink account={account} newTab /> : <PlayerName account={account} /> : address}</span>
          </div>
          <div className="hd-stack mono" aria-label={`${who} stack ${chips(stack)} Chips`}>
            <CountUp value={Number(stack)} format={chips} /> <span className="hd-unit">Chips</span>
            {allIn && <span className="hd-tag">All-in</span>}
          </div>
          {missed > 0 && <span className="meta hd-missed">Missed {missed} of 3 turns</span>}
        </div>
        {dealer && (
          <span className="hd-btn" title="Dealer button, posts the small blind" aria-label="Dealer button">
            D
          </span>
        )}
      </div>
      <div data-bet={index} className={`hd-bet mono${bet > 0n ? " has" : ""}`} role={bet > 0n ? "img" : undefined} aria-label={bet > 0n ? `Bet ${chips(bet)} Chips` : undefined}>
        {bet > 0n && (
          <>
            <ChipStack amount={bet} />
            <span className="hd-bet-n">{chips(bet)}</span>
          </>
        )}
      </div>
      {say && (
        <div className="hd-say">
          <Callout key={say.id} text={say.text} tone={say.kind === "allin" ? "warn" : "plain"} duration={1600} className="hd-say-host" />
        </div>
      )}
    </div>
  );
}
