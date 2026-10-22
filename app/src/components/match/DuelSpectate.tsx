"use client";

import { useEffect, useState } from "react";
import { Connection } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { TEE_RPC } from "@/games/holdem/chain";
import { STATUS, TRADING_DUEL_PROGRAM_ID, assetOfIndex, decodeDuel, decodeTable, tablePda, type Duel } from "@/games/trading-duel/chain";
import { COLUMNS, NO_PICK, lockAt } from "@/games/trading-duel/grid";
import { getTradingDuel } from "@/lib/chain/client";
import type { ChainMatch } from "@/lib/chain/read";
import { useEndState, type EndStateRead } from "@/lib/end-state";


/**
 * What anyone may see of a Trading Duel: while it runs, the clock, the points of the finished
 * columns and how many picks each side has locked, from the public Duel (a pick stays private
 * to its Player until its column locks); once it is committed, the final points and every pick.
 */
export function DuelSpectate({ m }: { m: ChainMatch }) {
  const asset = assetOfIndex(m.asset);
  const [duel, setDuel] = useState<Duel | null>(null);
  /** A finished Match's table read is over (found the board or not): the screen never waits on it forever. */
  const [chainDone, setChainDone] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const finished = m.status === "settled" || m.status === "refunded";
  // The table's committed copy holds the board only until the next Match on that table commits; then the history has it.
  const end = useEndState(m.address.toBase58(), finished && chainDone && !duel, "trading-duel");

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      const chain = getTradingDuel();
      try {
        const a = await chain.readAssignment(m.address);
        if (finished) {
          const d = a ? await chain.readDuelOnBase(a) : null;
          if (live) {
            setDuel(d);
            setChainDone(true);
          }
          return;
        }
        if (m.status !== "active") return;
        if (!a) {
          if (live) setDuel(null);
        } else {
          // The public table is readable on the rollup without a Player's token; if it is refused, say so.
          const address = tablePda(a.generation, a.index);
          const info = await new Connection(TEE_RPC, "confirmed").getAccountInfo(address).catch(() => null);
          if (!live) return;
          if (info && (info.owner.equals(DELEGATION_PROGRAM_ID) || info.owner.equals(TRADING_DUEL_PROGRAM_ID))) {
            setDuel(decodeDuel(a, decodeTable(address, chain.program.coder.accounts.decode("table", info.data))));
            setHidden(false);
          } else {
            setHidden(true);
          }
        }
      } catch {
        if (live && !finished) setHidden(true);
        if (live && finished) setChainDone(true);
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
    return <FinishedDuel symbol={symbol} sides={[side(0), side(1)]} duel={duel} chainDone={chainDone} end={end} />;
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

const pickCount = (picks: number[]) => picks.filter((r) => r !== NO_PICK).length;

/**
 * The result line of a finished Duel: the table's committed copy while it still holds the Match, else the end state the keeper
 * kept in the history, else an honest "no longer available". It shows "Loading" only while a read is actually in flight.
 */
export function FinishedDuel({ symbol, sides, duel, chainDone, end }: { symbol: string; sides: [string, string]; duel: Duel | null; chainDone: boolean; end: EndStateRead }) {
  let scores: [number, number] | null = null;
  let picks: [number, number] | null = null;
  if (duel) {
    scores = duel.scores;
    picks = [pickCount(duel.revealed[0]), pickCount(duel.revealed[1])];
  } else if (end.status === "found" && end.state.game === "trading-duel") {
    scores = end.state.scores;
    picks = [pickCount(end.state.picks[0]), pickCount(end.state.picks[1])];
  }
  if (!scores || !picks) {
    if (!chainDone || end.status === "loading") return <p className="mr-copy">Loading the result…</p>;
    return <p className="mr-copy">The board of this Match is no longer available. The result above is final.</p>;
  }
  return (
    <section className="td-spectate" aria-label="Trading Duel result">
      <p className="mr-copy">
        {symbol} · {sides[0]} {scores[0]} points ({picks[0]} of {COLUMNS} columns picked), {sides[1]} {scores[1]} points ({picks[1]} picked).
      </p>
    </section>
  );
}
