"use client";

import { useState } from "react";
import {
  BalanceCard,
  BalanceSplit,
  Button,
  Card,
  ChainChip,
  Label,
  PendingBySource,
  SimulatedYieldLabel,
  UndoIcon,
} from "@/components/ui";
import { redeemableOf, useAccount } from "@/lib/account";
import { fmtAsset, fmtGemas, fmtWhen } from "@/lib/format";
import type { Position } from "@/lib/mock";
import { AdvanceSheet } from "./AdvanceSheet";
import { RedeemSheet, ReturnSheet } from "./MoneySheets";

export default function Wallet() {
  const { gemas, positions, holdings, auth } = useAccount();
  const [advanceFor, setAdvanceFor] = useState<Position | null>(null);
  const [returnFor, setReturnFor] = useState<Position | null>(null);
  const [redeemOpen, setRedeemOpen] = useState(false);

  if (auth.status === "signed-out") {
    return (
      <Card large as="section" aria-label="Sign in to see your Wallet">
        <div className="stack">
          <h1 className="page-title">Wallet</h1>
          <p className="meta">Your Positions, Gemas and Advances belong to your Account. Sign in to see them.</p>
          <Button block onClick={() => auth.openSignIn()}>Sign in</Button>
        </div>
      </Card>
    );
  }

  const redeemable = holdings.filter((h) => redeemableOf(h) > 0);
  const pendingItems = holdings
    .filter((h) => h.gemas - redeemableOf(h) > 0)
    .map((h) => ({
      key: `${h.source.positionId}`,
      chain: h.source.chain,
      owner: h.source.owner,
      pending: h.gemas - redeemableOf(h),
      accruedShare: h.accruedShare,
    }));

  return (
    <div className="cols cols-2">
      <div className="stack-lg">
        <div className="stack">
          <BalanceCard total={gemas.total} />
          <BalanceSplit redeemable={gemas.redeemable} pending={gemas.pending} redeemableSources={redeemable.length} />
          <Button variant="money" block disabled={gemas.redeemable === 0} onClick={() => auth.gate("Redeem", () => setRedeemOpen(true))}>
            Redeem {fmtGemas(gemas.redeemable)}
          </Button>
        </div>
        <Card large>
          <PendingBySource items={pendingItems} />
        </Card>
      </div>

      <section className="stack" aria-labelledby="pos-h">
        <div className="section-head">
          <Label>
            <span id="pos-h">Your Positions</span>
          </Label>
        </div>
        <SimulatedYieldLabel />
        {positions.map((p) => (
          <Card key={p.id} large as="article" aria-label={`${p.asset} Position`}>
            <div className="stack">
              <div className="spread">
                <span className="hstack">
                  <ChainChip chain={p.chain} />
                  <strong>{fmtAsset(p.principal, p.asset)} Position</strong>
                </span>
                <span className="meta tnum">{(p.apy * 100).toFixed(1)}% APY</span>
              </div>
              <dl className="kv">
                <dt>Principal</dt>
                <dd>{fmtAsset(p.principal, p.asset)} · locked</dd>
                <dt>Debt</dt>
                <dd>{fmtAsset(p.debt, p.asset)}</dd>
                <dt>Unlock Estimate</dt>
                <dd>{p.advance ? fmtWhen(p.advance.unlockEstimate) : "No open Advance"}</dd>
              </dl>
              {p.advance ? (
                <Button
                  size="sm"
                  icon={<UndoIcon />}
                  onClick={() => auth.gate("return Gemas", () => setReturnFor(p))}
                >
                  Return unspent Gemas
                </Button>
              ) : (
                <Button variant="money" size="sm" onClick={() => auth.gate("take an Advance", () => setAdvanceFor(p))}>
                  Take an Advance
                </Button>
              )}
            </div>
          </Card>
        ))}
        <p className="note">
          Unlock Estimate is an estimate, not a promise: it moves with the provider&apos;s actual yield.
        </p>
      </section>

      <AdvanceSheet position={advanceFor} onClose={() => setAdvanceFor(null)} />
      <ReturnSheet position={returnFor} onClose={() => setReturnFor(null)} />
      <RedeemSheet open={redeemOpen} onClose={() => setRedeemOpen(false)} />
    </div>
  );
}
