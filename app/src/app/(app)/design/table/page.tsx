"use client";

import { useEffect, useState } from "react";
import { notFound } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import { PHASE, SPEED_TURBO, STATUS, type Table } from "@/games/holdem/chain";
import { HoldemTable } from "@/games/holdem/HoldemTable";
import { DEV_WALLET } from "@/lib/chain/config";

const pk = (s: string) => new PublicKey(s);
const NO = 255;

/** DEV ONLY (NEXT_PUBLIC_DEV_WALLET=1): the Hold'em table on a fixed hand, for screenshots. `?facing=1` puts a bet in front of you. */
export default function TablePreview() {
  if (!DEV_WALLET) notFound();
  const [deadline] = useState(() => Math.floor(Date.now() / 1000) + 30);
  const [facing, setFacing] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setFacing(new URLSearchParams(window.location.search).get("facing") === "1"), 0);
    return () => clearTimeout(t);
  }, []);
  const table: Table = {
    address: pk("11111111111111111111111111111111"),
    tesoroMatch: pk("11111111111111111111111111111111"),
    players: [pk("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"), pk("4rG3LUgjMq1a7vJq2sTqkQmZ8m4wq2pVbR8vN3Ykq7Xd")],
    speed: SPEED_TURBO,
    status: STATUS.live,
    finalized: false,
    winner: NO,
    startDeadline: 0,
    handNo: 784592,
    dealer: 1,
    phase: PHASE.river,
    smallBlind: 100n,
    bigBlind: 200n,
    stacks: [1500n, facing ? 1100n : 1500n],
    bets: [0n, facing ? 400n : 0n],
    committed: [300n, 300n],
    pot: 600n,
    toAct: 0,
    lastRaise: 200n,
    board: [11, 18, 33, 39, 9],
    deadline,
    missed: [0, 0],
    lastHand: { handNo: 0, result: NO, pot: 0n, showdown: false, shown: [[NO, NO], [NO, NO]], board: [] },
  };
  return (
    <HoldemTable table={table} seat={0} hole={{ handNo: 784592, cards: [51, 49] }} busy={null} ended={false} entry={1000} onAct={() => undefined} onClaim={() => undefined} />
  );
}
