"use client";

import { useState } from "react";
import { ViewSwitchLink } from "@/components/deposit/ViewSwitchLink";
import { Button, SkeletonCards } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { requestDeposit } from "@/lib/deposit/bus";
import { PACK_MONTHS } from "@/lib/deposit/packs";
import { vaultView, type DepositRow } from "@/lib/deposit/vault";
import { plainError } from "@/lib/errors";
import { fmtUsd } from "@/lib/format";
import { withdrawAndConfirm } from "./confirm-withdraw";
import { DepositCards } from "./DepositCards";
import "./vault.css";

export function SimpleVault() {
  const { auth, snapshot, gemas, loading, ready, error, refresh } = useAccount();
  const [now] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const view = vaultView({ snapshot, gemasAvailable: gemas.available, gemasTotal: gemas.total, nowMs: now });
  const signer = auth.signer;

  const run = async (id: string, work: () => Promise<void>) => {
    setBusy(id);
    setProblem(null);
    try {
      await work();
    } catch (e) {
      setProblem(plainError(e));
    } finally {
      await refresh();
      setBusy(null);
    }
  };
  const withdraw = (d: DepositRow) =>
    signer && snapshot && run(`withdraw:${d.id}`, () => withdrawAndConfirm(d.label, signer, auth.getAccessToken, snapshot, d.id));
  const loadingFirst = (loading || !ready) && !snapshot && !error;

  return (
    <div className="wl-part">
      {error && !snapshot && (
        <p className="status err" role="alert">
          Could not read your Account. <Button size="sm" onClick={() => void refresh()}>Retry</Button>
        </p>
      )}
      {problem && <p className="status err vt-notice" role="alert">{problem}</p>}

      {loadingFirst && <SkeletonCards count={2} avatar={false} label="Loading your Vault…" />}

      {ready && view.isNew && (
        <section className="cut cut-card vt-empty" aria-label="Get started">
          <h2 className="display">Deposits</h2>
          <p className="meta">Make a deposit to get Gemas and start playing. Your deposit stays yours: you get it back after about {PACK_MONTHS} months.</p>
          <Button variant="money" size="lg" onClick={() => requestDeposit()}>Buy Gemas</Button>
        </section>
      )}

      {ready && !view.isNew && (
        <section className="cut cut-card vt-deposits" aria-label="Your deposits">
          <header className="vt-deposits-head">
            <h2 className="display">Deposits</h2>
            {view.deposits.length > 0 && (
              <p className="vt-total"><b>{fmtUsd(Math.round(view.deposits.reduce((t, d) => t + (d.worthUsd ?? 0), 0)))}</b> in your Vault</p>
            )}
          </header>
          {view.deposits.length === 0 && <p className="meta">No deposits right now.</p>}
          <DepositCards deposits={view.deposits} busyId={busy} canWithdraw={!!signer} onWithdraw={(d) => void withdraw(d)} />
          {view.otherChainDeposits && <p className="note">You also have deposits on other chains: see the <ViewSwitchLink to="advanced" /> to manage them.</p>}
        </section>
      )}
    </div>
  );
}
