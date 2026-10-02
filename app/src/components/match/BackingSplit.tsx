"use client";

import { GemaAmount, Label } from "@/components/ui";
import { backedSplit } from "@/lib/chain/ledger";
import type { ChainMatch } from "@/lib/chain/read";
import { fmtGemas } from "@/lib/format";

const short = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;

/**
 * How a settled Backing paid out, for whichever party is looking (the backed Player or the Backer).
 * The order is the program's: Backer's entry back first, then the Offer's split of the surplus.
 * A loss is the Backer's alone; the Player is never debited and gains no Debt.
 */
export function BackingSplit({ m }: { m: ChainMatch }) {
  const b = m.backing;
  const result = m.session ? m.session.result : m.winner;
  if (!b || m.status === "open" || m.status === "active") return null;
  const asPlayer = m.seat !== null;
  const party = asPlayer ? "Your Backer" : "Your Player";
  const other = asPlayer ? short(b.funder) : short(b.player);

  if (m.status === "refunded" || !result || result === "draw") {
    return (
      <div className="stack" aria-label="Backing">
        <Label>Backing</Label>
        <p className="meta">
          No result, so the entry of {fmtGemas(m.entry)} Gemas went back to {asPlayer ? `your Backer ${other}` : "you"}. Nobody won or lost.
        </p>
      </div>
    );
  }

  const won = (result === "opener") === (b.seat === 0);
  const s = backedSplit({ entry: m.entry, ...m.fees, shareBps: b.shareBps, won });
  return (
    <div className="stack" aria-label="Backing">
      <Label>{asPlayer ? `Backed by ${other}` : `You backed ${other}`}</Label>
      {won ? (
        <dl className="kv">
          <dt>1. {asPlayer ? "Your Backer's" : "Your"} entry back first</dt>
          <dd><GemaAmount value={s.backerEntryBack} size="sm" /></dd>
          <dt>Fees taken from the loser</dt>
          <dd>{fmtGemas(s.fees)}</dd>
          <dt>Surplus to split</dt>
          <dd>{fmtGemas(s.surplus)}</dd>
          <dt>2. {asPlayer ? "Your" : "Player's"} share ({b.shareBps / 100}%)</dt>
          <dd><GemaAmount value={s.playerShare} size="sm" sign /></dd>
          <dt>3. {asPlayer ? "Backer's" : "Your"} share ({100 - b.shareBps / 100}%)</dt>
          <dd><GemaAmount value={s.backerSurplus} size="sm" sign /></dd>
        </dl>
      ) : (
        <dl className="kv">
          <dt>{asPlayer ? `${party} bears` : "You bear"} the loss</dt>
          <dd><GemaAmount value={-m.entry} size="sm" sign /></dd>
          <dt>{asPlayer ? "You owe" : "Player owes"}</dt>
          <dd>0 Gemas · 0 Debt</dd>
        </dl>
      )}
      <p className="note">
        {asPlayer
          ? won
            ? "Your share is yours to keep. The Backer's Gemas were never in your Wallet, and you took on no Debt."
            : "You lost nothing and gained no Debt: the Backer's Gemas funded this entry."
          : "Only the Backer bears a loss. The backed Player never gains Debt and cannot redeem or redirect your Gemas."}
      </p>
    </div>
  );
}
