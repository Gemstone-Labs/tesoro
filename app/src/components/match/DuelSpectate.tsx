"use client";

import { useEffect, useState } from "react";
import { Connection } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { TEE_RPC } from "@/games/holdem/chain";
import { STATUS, TRADING_DUEL_PROGRAM_ID, addresses, assetOfIndex, decodeDuel, type Duel } from "@/games/trading-duel/chain";
import { COLUMNS, NO_PICK, lockAt } from "@/games/trading-duel/grid";
import { getTradingDuel } from "@/lib/chain/client";
import type { ChainMatch } from "@/lib/chain/read";


/**
 * What anyone may see of a Trading Duel: while it runs, the clock, the points of the finished
 * columns and how many picks each side has locked, from the public Duel (a pick stays private
 * to its Player until its column locks); once it is committed, the final points and every pick.
 */
export function DuelSpectate({ m }: { m: ChainMatch }) {
  const asset = assetOfIndex(m.asset);
  const [duel, setDuel] = useState<Duel | null>(null);
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
          const d = await chain.readDuelOnBase(m.address);
          if (live) setDuel(d);
          return;
        }
        if (m.status !== "active") return;
        // The public Duel is readable on the rollup without a Player's token; if it is refused, say so.
        const info = await new Connection(TEE_RPC, "confirmed").getAccountInfo(addresses(m.address).duel).catch(() => null);
        if (!live) return;
        if (info && (info.owner.equals(DELEGATION_PROGRAM_ID) || info.owner.equals(TRADING_DUEL_PROGRAM_ID))) {
          setDuel(decodeDuel(addresses(m.address).duel, chain.program.coder.accounts.decode("duel", info.data)));
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
  }, [m.id, m.address, m.status, finished]);

  const symbol = asset?.symbol ?? "SOL";
  const side = (seat: 0 | 1) => (m.sides[seat] ? `${m.sides[seat]!.player.slice(0, 4)}…${m.sides[seat]!.player.slice(-4)}` : `Seat ${seat + 1}`);
  const picks = (d: Duel, seat: 0 | 1) => d.revealed[seat].filter((r) => r !== NO_PICK).length;
  if (finished) {
    if (!duel) return <p className="mr-copy">Loading the result…</p>;
    return (
      <section className="td-spectate" aria-label="Trading Duel result">
        <p className="mr-copy">
          {symbol} · {side(0)} {duel.scores[0]} points ({picks(duel, 0)} of {COLUMNS} columns picked), {side(1)} {duel.scores[1]} points ({picks(duel, 1)} picked).
        </p>
      </section>
    );
  }
  if (m.status !== "active") return null;
  if (!duel || hidden) return <p className="mr-copy">In progress on {symbol}. Picks stay hidden until their column locks.</p>;
  if (duel.status !== STATUS.live || duel.endsAt === 0) return <p className="mr-copy">Starting on {symbol}. Picks stay hidden until their column locks.</p>;
  const left = Math.max(0, Math.ceil(duel.endsAt - now));
  const locked = Array.from({ length: COLUMNS }, (_, c) => now - duel.startsAt >= lockAt(c)).filter(Boolean).length;
  return (
    <p className="mr-copy" role="status">
      Live on {symbol} · {left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left` : "closing"} · {side(0)} {duel.scores[0]} to {side(1)} {duel.scores[1]} points · {locked} of {COLUMNS} columns locked, {picks(duel, 0)} and {picks(duel, 1)} picks shown. Picks stay hidden until their column locks.
    </p>
  );
}
