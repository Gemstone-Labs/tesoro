"use client";

import { useEffect, useState } from "react";
import { Connection } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { TEE_RPC } from "@/games/holdem/chain";
import { FillHistory } from "@/games/trading-duel/FillHistory";
import { LEAD, STATUS, TRADING_DUEL_PROGRAM_ID, addresses, assetOfMatchId, decodeDuel, type Book, type Duel } from "@/games/trading-duel/chain";
import { getTradingDuel } from "@/lib/chain/client";
import type { ChainMatch } from "@/lib/chain/read";

const usd = (v: bigint) => `$${(Number(v) / 1e8).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/**
 * What anyone may see of a Trading Duel: while it runs, only the coarse lead, the trade counts
 * and the clock from the public Duel (the Books are private to their Players); once it is
 * committed, the final equities and both Players' full fill histories.
 */
export function DuelSpectate({ m }: { m: ChainMatch }) {
  const asset = assetOfMatchId(m.id);
  const [duel, setDuel] = useState<Duel | null>(null);
  const [books, setBooks] = useState<[Book, Book] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const finished = m.status === "settled" || m.status === "refunded";

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      const chain = getTradingDuel();
      try {
        if (finished) {
          const [d, b] = await Promise.all([chain.readDuelOnBase(m.id), chain.readBooksOnBase(m.id)]);
          if (live) {
            setDuel(d);
            setBooks(b);
          }
          return;
        }
        if (m.status !== "active") return;
        // The public Duel is readable on the rollup without a Player's token; if it is refused, say so.
        const info = await new Connection(TEE_RPC, "confirmed").getAccountInfo(addresses(m.id).duel).catch(() => null);
        if (!live) return;
        if (info && (info.owner.equals(DELEGATION_PROGRAM_ID) || info.owner.equals(TRADING_DUEL_PROGRAM_ID))) {
          setDuel(decodeDuel(addresses(m.id).duel, chain.program.coder.accounts.decode("duel", info.data)));
          setHidden(false);
        } else {
          setHidden(true);
        }
      } catch {
        if (live && !finished) setHidden(true);
      }
      if (live && !finished) timer = setTimeout(read, 3000);
    };
    void read();
    const tick = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => {
      live = false;
      clearTimeout(timer);
      clearInterval(tick);
    };
  }, [m.id, m.status, finished]);

  const symbol = asset?.symbol ?? "SOL";
  if (finished) {
    if (!duel || !books) return <p className="mr-copy">Loading the trades…</p>;
    return (
      <section className="td-spectate" aria-label="Trading Duel result">
        {duel.status === STATUS.over && (
          <p className="mr-copy">
            Ended at {usd(duel.finalPrice)} per {symbol}. Final equity {duel.finalEquity[0].toString()} to {duel.finalEquity[1].toString()} Chips.
          </p>
        )}
        <FillHistory books={books} duel={duel} />
      </section>
    );
  }
  if (m.status !== "active") return null;
  if (!duel || hidden) return <p className="mr-copy">In progress on {symbol}. Positions are hidden until the end.</p>;
  if (duel.status !== STATUS.live || duel.endsAt === 0) return <p className="mr-copy">Starting on {symbol}. Positions are hidden until the end.</p>;
  const left = Math.max(0, Math.ceil(duel.endsAt - now));
  const ahead = m.sides[duel.lead === LEAD.seat0 ? 0 : 1];
  const lead = duel.lead === LEAD.level || !ahead ? "Level" : `${ahead.player.slice(0, 4)}…${ahead.player.slice(-4)} ahead`;
  return (
    <p className="mr-copy" role="status">
      Live on {symbol} · {left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left` : "closing"} · {lead} · trades {duel.trades[0]} to {duel.trades[1]}. Positions are hidden until the end.
    </p>
  );
}
