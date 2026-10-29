"use client";

import { useState } from "react";
import { Button, toast } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { friendlyError, redeemNative } from "@/lib/chain/native-flow";
import { smallLeftovers } from "@/lib/chain/ready-by";
import type { ChainHolding } from "@/lib/chain/read";
import { fmtGemas } from "@/lib/format";
import { redeemEthHoldings, useEthCtx } from "./EthPositions";

/**
 * "Redeem small leftovers": the tiny lines of one chain that have something to Redeem, redeemed in a
 * row so they stop piling up in the basket (each line holds a slot that costs rent). Shown only when
 * there are at least two, or one that is too small to be worth a Redeem of its own.
 */
export function SmallLeftovers({ lines, chain }: { lines: ChainHolding[]; chain: "SOL" | "ETH" | "HYPE" }) {
  const { auth, refresh } = useAccount();
  const ethCtx = useEthCtx();
  const small = smallLeftovers(lines.filter((l) => l.asset === chain && (l.native || l.eth)));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (small.length === 0) return null;
  const gemas = small.reduce((s, l) => s + Number(l.redeemable), 0);
  const run = async () => {
    if (!auth.signer) return;
    setBusy(true);
    setError(null);
    try {
      let done = 0;
      for (const l of small.filter((x) => x.native)) {
        setNote(`Redeeming ${++done} of ${small.length}…`);
        await redeemNative(auth.signer, auth.getAccessToken, l, l.redeemable);
      }
      const eth = small.filter((x) => x.eth);
      if (eth.length > 0) {
        if (!ethCtx) throw new Error("Your ETH wallet is not ready yet. Try again in a moment.");
        await redeemEthHoldings(ethCtx, eth, setNote);
      }
      setNote(null);
      toast(`Redeemed ${small.length} small ${small.length === 1 ? "line" : "lines"}.`);
      await refresh();
    } catch (e) {
      setError(friendlyError(e));
      setNote(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="wl-leftovers">
      <Button size="sm" disabled={busy || !auth.signer} onClick={() => void run()}>
        {busy ? "Redeeming…" : `Redeem small leftovers (${small.length})`}
      </Button>
      <span className="meta">{fmtGemas(gemas)} Gemas in {small.length} small {small.length === 1 ? "line" : "lines"}. Clears them out of your Account.</span>
      {note && !error && <span className="meta" role="status">{note}</span>}
      {error && <span className="status err" role="alert">{error}</span>}
    </div>
  );
}
