"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Info } from "lucide-react";
import { ViewSwitchLink } from "@/components/deposit/ViewSwitchLink";
import { BalanceHero } from "@/components/money/BalanceHero";
import { Button, Card, CheckIcon, SkeletonCards } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { CLUSTER } from "@/lib/cluster-settings";
import { requestDeposit, type DepositIntent } from "@/lib/deposit/bus";
import { PACK_MONTHS } from "@/lib/deposit/packs";
import { cashOutNow, cashOutReady, withdrawDeposit } from "@/lib/deposit/vault-actions";
import { fmtBackAt, vaultView, type DepositRow } from "@/lib/deposit/vault";
import { plainError } from "@/lib/errors";
import { fmtGemas, fmtUsd } from "@/lib/format";
import { GAME_NAMES, type GameId } from "@/lib/mock";
import "./vault.css";

const TEST_MODE = CLUSTER.yieldModel !== "real";

export default function VaultPage() {
  return (
    <Suspense>
      <Vault />
    </Suspense>
  );
}

/** `/vault?deposit=1&need=<gemas>&game=<id>` (a game that needs Gemas, the Lobby) opens the deposit modal, then drops the query. */
function useDepositQuery(settled: boolean) {
  const params = useSearchParams();
  const router = useRouter();
  const wanted = params.get("deposit") === "1";
  const game = params.get("game");
  const need = Math.floor(Number(params.get("need")));
  useEffect(() => {
    if (!wanted || !settled) return;
    const intent: DepositIntent | null = game && game in GAME_NAMES ? { game: game as GameId, need: need > 0 ? need : null } : null;
    requestDeposit(intent);
    router.replace("/vault");
  }, [wanted, settled, game, need, router]);
}

function Vault() {
  const { auth, snapshot, gemas, loading, ready, error, refresh } = useAccount();
  const [now] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useDepositQuery(auth.status === "signed-in" || auth.status === "signed-out");

  if (auth.status === "signed-out") {
    return (
      <Card large as="section" aria-label="Sign in to see your Vault">
        <div className="stack">
          <h1 className="page-title">Vault</h1>
          <p className="meta">Your Gemas, deposits and winnings belong to your Account. Sign in to see them.</p>
          <Button block onClick={() => auth.openSignIn()}>Sign in</Button>
        </div>
      </Card>
    );
  }

  const view = vaultView({ snapshot, gemasAvailable: gemas.available, nowMs: now });
  const signer = auth.signer;
  const w = view.winnings;

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
  const cashOut = () =>
    signer && snapshot && run("cash", async () => {
      const r = await cashOutReady(signer, snapshot, { cashOutTo: "wallet" });
      return `Cashed out ${fmtGemas(r.gemas)} Gemas to your wallet.`;
    });
  const cashOutSoon = () =>
    signer && snapshot && run("now", async () => {
      const r = await cashOutNow(signer, snapshot, { cashOutTo: "wallet" });
      return r.changed
        ? `Part of it went through (${fmtGemas(r.gemas)} Gemas). Your winnings changed while you were confirming: check the new amount and try again.`
        : `Cashed out ${fmtGemas(r.gemas)} Gemas to your wallet.`;
    });

  const loadingFirst = (loading || !ready) && !snapshot && !error;
  const waiting = w.readyNow > 0 || w.readyLater > 0;

  return (
    <div className="vt">
      <header className="page-head vt-head">
        <h1 className="page-title">Vault</h1>
        <div className="vt-head-side">
          <ViewSwitchLink to="advanced" className="vt-adv" />
          <Button variant="money" size="lg" onClick={() => requestDeposit()}>Get Gemas</Button>
        </div>
      </header>

      {error && !snapshot && (
        <p className="status err" role="alert">
          Could not read your Account. <Button size="sm" onClick={() => void refresh()}>Retry</Button>
        </p>
      )}
      {notice && <p className="status ok vt-notice" role="status"><CheckIcon aria-hidden="true" /> {notice}</p>}
      {problem && <p className="status err vt-notice" role="alert">{problem}</p>}

      <BalanceHero
        label="Gemas to play"
        figure={ready ? fmtGemas(view.gemas) : "—"}
        usdOf={ready ? view.gemas : undefined}
        busy={!ready}
        columns={[
          {
            label: "Ready to cash out",
            figure: ready ? fmtGemas(w.readyNow) : "—",
            usdOf: ready ? w.readyNow : undefined,
            emerald: true,
            note: ready && w.readyNow === 0 ? "Win Matches and your winnings show up here." : undefined,
            action: ready && w.readyNow > 0 && (
              <Button variant="money" disabled={!signer || busy !== null} onClick={() => void cashOut()}>
                {busy === "cash" ? "Cashing out…" : "Cash out"}
              </Button>
            ),
          },
          {
            label: "Ready later",
            figure: ready ? fmtGemas(w.readyLater) : "—",
            usdOf: ready ? w.readyLater : undefined,
            note: !ready ? undefined : w.readyLater === 0 ? "Nothing waiting." : w.readyLaterAtMs ? `around ${fmtBackAt(w.readyLaterAtMs)}` : `within about ${PACK_MONTHS} months`,
            action: ready && w.readyLater > 0 && (w.instant ? (
              <>
                <Button disabled={!signer || busy !== null} onClick={() => void cashOutSoon()}>
                  {busy === "now" ? "Cashing out…" : `Cash out now · you keep ${w.instant.keepPct}%`}
                </Button>
                <span className="meta">About {fmtUsd(Math.round(w.instant.usd * 100) / 100)} for {fmtGemas(w.instant.gemas)} Gemas.</span>
              </>
            ) : (
              <span className="meta">Cashing out now isn&apos;t available right now.</span>
            )),
          },
        ]}
      />

      {loadingFirst && <SkeletonCards count={2} avatar={false} label="Loading your Vault…" />}

      {ready && !view.isNew && (waiting || view.otherChainWinnings) && (
        <div className="vt-foot">
          {waiting && (
            <p className="note vt-note">
              <Info aria-hidden="true" />
              <span>{TEST_MODE ? "Cash out to your wallet. In test mode it pays test SOL." : "Cash out to your wallet."}</span>
            </p>
          )}
          {view.otherChainWinnings && <p className="note">You also have winnings on other chains: see the <ViewSwitchLink to="advanced" />.</p>}
        </div>
      )}

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
