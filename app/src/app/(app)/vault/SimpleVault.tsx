"use client";

import { useState } from "react";
import { Info } from "lucide-react";
import { ViewSwitchLink } from "@/components/deposit/ViewSwitchLink";
import { Button, CheckIcon, SkeletonCards } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { requestDeposit } from "@/lib/deposit/bus";
import { PACK_MONTHS } from "@/lib/deposit/packs";
import { withdrawDeposit } from "@/lib/deposit/vault-actions";
import { fmtBackAt, vaultView, type DepositRow } from "@/lib/deposit/vault";
import { plainError } from "@/lib/errors";
import { fmtUsd } from "@/lib/format";
import "./vault.css";

export function SimpleVault() {
  const { auth, snapshot, gemas, loading, ready, error, refresh } = useAccount();
  const [now] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const view = vaultView({ snapshot, gemasAvailable: gemas.available, gemasTotal: gemas.total, nowMs: now });
  const signer = auth.signer;

  const run = async (id: string, work: () => Promise<string>) => {
    setBusy(id);
    setNotice(null);
    setProblem(null);
    try {
      setNotice(await work());
    } catch (e) {
      setProblem(plainError(e));
    } finally {
      await refresh();
      setBusy(null);
    }
  };
  const withdraw = (d: DepositRow) =>
    signer && snapshot && run(`withdraw:${d.id}`, async () => {
      await withdrawDeposit(signer, snapshot, d.id);
      return `${d.label} withdrawn. Your SOL is back in your wallet.`;
    });
  const loadingFirst = (loading || !ready) && !snapshot && !error;

  return (
    <div className="wl-part">
      {error && !snapshot && (
        <p className="status err" role="alert">
          Could not read your Account. <Button size="sm" onClick={() => void refresh()}>Retry</Button>
        </p>
      )}
      {notice && <p className="status ok vt-notice" role="status"><CheckIcon aria-hidden="true" /> {notice}</p>}
      {problem && <p className="status err vt-notice" role="alert">{problem}</p>}

      {loadingFirst && <SkeletonCards count={2} avatar={false} label="Loading your Vault…" />}

      {ready && view.isNew && (
        <section className="cut cut-card vt-empty" aria-label="Get started">
          <h2 className="display">Deposits</h2>
          <p className="meta">Make a deposit to get Gemas and start playing. Your deposit stays yours: you get it back after about {PACK_MONTHS} months.</p>
          <Button variant="money" size="lg" onClick={() => requestDeposit()}>Get Gemas</Button>
        </section>
      )}

      {ready && !view.isNew && (
        <section className="cut cut-card vt-deposits" aria-label="Your deposits">
          <h2 className="display">Deposits</h2>
          {view.deposits.length === 0 && <p className="meta">No deposits right now.</p>}
          <div className="vt-list">
            {view.deposits.map((d) => (
              <article key={d.id} className={`vt-dep ${d.state}`}>
                <p className="vt-dep-line">
                  <b>{d.label}</b>
                  {d.state !== "ready" && d.worthUsd !== null && <><i aria-hidden="true">·</i><span>worth about {fmtUsd(Math.round(d.worthUsd))} today</span></>}
                  <i aria-hidden="true">·</i>
                  {d.state === "ready" && <span className="ok"><CheckIcon aria-hidden="true" /> Ready to withdraw</span>}
                  {d.state === "growing" && <span>{d.backAtMs ? `Back around ${fmtBackAt(d.backAtMs)}` : `Back after about ${PACK_MONTHS} months`}</span>}
                  {d.state === "late" && <span className="warn">{d.backAtMs ? `Taking a little longer · about ${fmtBackAt(d.backAtMs)}` : "Taking a little longer. We'll show a new date soon."}</span>}
                </p>
                {d.state === "ready" && (
                  <Button variant="money" size="sm" disabled={!signer || busy !== null} onClick={() => void withdraw(d)}>
                    {busy === `withdraw:${d.id}` ? "Withdrawing…" : "Withdraw"}
                  </Button>
                )}
              </article>
            ))}
          </div>
          <div className="vt-info">
            <p className="note vt-note"><Info aria-hidden="true" /><span>You get your deposit back after about {PACK_MONTHS} months!</span></p>
            <p className="note vt-note"><Info aria-hidden="true" /><span>What you get back depends on the SOL price when you withdraw.</span></p>
          </div>
          {view.withdrawn > 0 && <p className="note">{view.withdrawn} earlier {view.withdrawn === 1 ? "deposit" : "deposits"} withdrawn.</p>}
          {view.otherChainDeposits && <p className="note">You also have deposits on other chains: see the <ViewSwitchLink to="advanced" /> to manage them.</p>}
        </section>
      )}
    </div>
  );
}
