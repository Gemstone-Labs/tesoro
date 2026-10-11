"use client";

import { AccountLink } from "@/components/account/AccountLink";
import { PlayerName } from "@/components/account/Player";
import { GemaAmount } from "@/components/ui";
import { backedSplit } from "@/lib/chain/ledger";
import type { ChainMatch } from "@/lib/chain/read";
import { fmtGemas } from "@/lib/format";

type Segment = { key: string; label: string; n: number; sign: boolean; you: boolean };
type Css = React.CSSProperties & Record<`--${string}`, string>;

/**
 * How a settled Backing paid out, for whichever party is looking (the backed Player or the Backer).
 * The Pot is drawn to scale in the program's order: Backer's entry back first, then the Offer's
 * split of the surplus, then Fees. A loss is the Backer's alone; the Player is never debited and
 * gains no Debt. Bar and legend share one column track, so each label sits under its segment;
 * on phones the legend wraps to two columns and the bar goes back to true scale.
 */
export function BackingSplit({ m }: { m: ChainMatch }) {
  const b = m.backing;
  if (!b || m.status === "open" || m.status === "active") return null;
  const result = m.session ? m.session.result : m.winner;
  const asPlayer = m.seat !== null;
  const share = b.shareBps / 100;
  const kind = m.status === "refunded" || !result || result === "draw" ? "back" : (result === "opener") === (b.seat === 0) ? "won" : "lost";
  const s = backedSplit({ entry: m.entry, ...m.fees, shareBps: b.shareBps, won: kind === "won" });

  const segments: Segment[] =
    kind === "won"
      ? [
          { key: "back", label: asPlayer ? "Backer's entry back" : "Your entry back", n: s.backerEntryBack, sign: false, you: !asPlayer },
          { key: "backer", label: `${asPlayer ? "Backer's" : "Your"} share (${100 - share}%)`, n: s.backerSurplus, sign: true, you: !asPlayer },
          { key: "player", label: `${asPlayer ? "Your" : "Player's"} share (${share}%)`, n: s.playerShare, sign: true, you: asPlayer },
          { key: "fees", label: "Fees", n: s.fees, sign: false, you: false },
        ]
      : kind === "lost"
        ? [
            { key: "lost", label: asPlayer ? "Backer's entry, to the winner" : "Your entry, to the winner", n: -m.entry, sign: true, you: !asPlayer },
            { key: "none", label: asPlayer ? "You lose nothing" : "The Player loses nothing", n: 0, sign: false, you: asPlayer },
          ]
        : [{ key: "back", label: asPlayer ? "Entry back to your Backer" : "Your entry back", n: m.entry, sign: false, you: !asPlayer }];
  // A zero still needs room for its label; the tiny Fees slice gets enough for "Fees" and its figure.
  const total = segments.reduce((t, g) => t + Math.abs(g.n), 0);
  const weight = (g: Segment) => Math.abs(g.n) || total * 0.2;
  const cols = segments.map((g) => `minmax(${g.key === "fees" ? 76 : 96}px, ${weight(g)}fr)`).join(" ");
  const scale = segments.map((g) => `minmax(8px, ${weight(g)}fr)`).join(" ");

  return (
    <section className="cut cut-card bks" aria-label="Backing" style={{ "--cols": cols, "--scale": scale } as Css}>
      <header className="bks-h">
        <span className="bks-who">
          {asPlayer ? <>Backed by <PlayerName account={b.funder} /></> : <>You backed <AccountLink account={b.player} /></>}
          <span className="bks-pill">{share}% to the Player</span>
        </span>
        <span className="meta">
          {kind === "won" ? (
            <>The Pot <GemaAmount value={m.entry * 2} size="sm" /></>
          ) : kind === "lost" ? (
            "The Pot went to the opponent"
          ) : (
            `${result === "draw" ? "Draw" : "No result"}: the entry went back`
          )}
        </span>
      </header>
      <div className={`bks-bar ${kind}`} role="img" aria-label={segments.map((g) => `${g.label}: ${fmtGemas(Math.abs(g.n))} Gemas`).join(", ")}>
        {segments.map((g, i) => <i key={g.key} className={`${g.key}${g.you ? " you" : ""}`} style={{ "--i": String(i) } as Css} />)}
      </div>
      <ul className="bks-legend" aria-hidden="true">
        {segments.map((g) => (
          <li key={g.key} className={`${g.key}${g.you ? " you" : ""}`}>
            <span className="bks-sw" />
            <span>{g.label}</span>
            <b><GemaAmount value={g.n} size="sm" sign={g.sign} mark={g.n > 0} /></b>
          </li>
        ))}
      </ul>
      <p className="note">
        {kind === "back"
          ? asPlayer
            ? "Nobody won or lost, and you owe nothing."
            : "Nobody won or lost."
          : asPlayer
            ? kind === "won"
              ? "Your share is yours to keep. The Backer's Gemas were never in your Wallet, and you took on no Debt."
              : "You lost nothing and gained no Debt: the Backer's Gemas funded this entry."
            : "Only the Backer bears a loss. The backed Player never gains Debt and cannot redeem or redirect your Gemas."}
      </p>
    </section>
  );
}
