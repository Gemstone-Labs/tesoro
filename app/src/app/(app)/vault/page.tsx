"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Info } from "lucide-react";
import { ViewSwitchLink } from "@/components/deposit/ViewSwitchLink";
import { Button, Card, CheckIcon, FacetCrown, GemaAmount, GemaMark, GemaUsd, SkeletonCards } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { CLUSTER } from "@/lib/cluster-settings";
import { requestDeposit, type DepositIntent } from "@/lib/deposit/bus";
import { PACK_MONTHS } from "@/lib/deposit/packs";
import { SIM_MONTH_MIN } from "@/lib/chain/native";
import { cashOutNow, cashOutReady, withdrawDeposit } from "@/lib/deposit/vault-actions";
import { fmtBackAt, vaultView, type DepositRow } from "@/lib/deposit/vault";
import { plainError } from "@/lib/errors";
import { fmtGemas, fmtUsd } from "@/lib/format";
import { GAME_NAMES, type GameId } from "@/lib/mock";
import "./vault.css";

const TEST_MODE = CLUSTER.yieldModel !== "real";
const solText = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: 3 })} SOL`;

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
  const hours = (PACK_MONTHS * SIM_MONTH_MIN) / 60;

  return (
    <div className="vt">
      <header className="page-head vt-head">
        <div>
          <h1 className="page-title">Vault</h1>
          <p className="page-sub">Your Gemas, your deposits and your winnings.</p>
        </div>
        <Button variant="money" size="lg" onClick={() => requestDeposit()}>Get Gemas</Button>
      </header>
      <p className="vt-view">
        <ViewSwitchLink to="advanced" />
        {TEST_MODE && <span className="dep-test">Test mode · no card needed · {PACK_MONTHS} months = about {hours} hours</span>}
      </p>

      {error && !snapshot && (
        <p className="status err" role="alert">
          Could not read your Account. <Button size="sm" onClick={() => void refresh()}>Retry</Button>
        </p>
      )}
      {notice && <p className="status ok vt-notice" role="status"><CheckIcon aria-hidden="true" /> {notice}</p>}
      {problem && <p className="status err vt-notice" role="alert">{problem}</p>}

      <section className="cut cut-frame facet-panel vt-gemas" aria-label="Your Gemas">
        <FacetCrown />
        <h2>Gemas you can play with</h2>
        <div className="vt-gemas-fig" aria-busy={!ready}>
          <GemaMark size={56} glint />
          <b>{ready ? fmtGemas(view.gemas) : "—"}</b>
          {ready && <GemaUsd value={view.gemas} />}
        </div>
      </section>

      {loadingFirst && <SkeletonCards count={2} avatar={false} label="Loading your Vault…" />}

      {ready && view.isNew && (
        <section className="cut cut-card vt-empty" aria-label="Get started">
          <h2>Your Vault is empty</h2>
          <p className="meta">Make a deposit to get Gemas and start playing. Your deposit stays yours: you get it back after about {PACK_MONTHS} months.</p>
          <Button variant="money" size="lg" onClick={() => requestDeposit()}>Get Gemas</Button>
        </section>
      )}

      {ready && !view.isNew && (
        <>
          <section className="vt-section" aria-label="Your deposits">
            <h2>Your deposits</h2>
            {view.deposits.length === 0 && <p className="meta">No deposits right now.</p>}
            <div className="vt-list">
              {view.deposits.map((d) => (
                <article key={d.id} className={`cut cut-card vt-dep ${d.state}`}>
                  <h3>{d.label}</h3>
                  <p className="meta">
                    {solText(d.sol)}
                    {d.worthUsd !== null && <> · worth about {fmtUsd(Math.round(d.worthUsd))} today</>}
                    {d.gemasGiven ? <> · gave you {fmtGemas(d.gemasGiven)} Gemas</> : null}
                  </p>
                  <p className="vt-dep-state">
                    {d.state === "ready" && <><CheckIcon aria-hidden="true" /> Ready to withdraw</>}
                    {d.state === "growing" && <>{d.backAtMs ? `Back around ${fmtBackAt(d.backAtMs)}` : `Back after about ${PACK_MONTHS} months`}</>}
                    {d.state === "late" && <>{d.backAtMs ? `Taking a little longer: about ${fmtBackAt(d.backAtMs)}` : "Taking a little longer. We'll show a new date soon."}</>}
                  </p>
                  {d.state === "ready" && (
                    <div className="vt-dep-side">
                      <Button size="sm" disabled={!signer || busy !== null} onClick={() => void withdraw(d)}>
                        {busy === `withdraw:${d.id}` ? "Withdrawing…" : "Withdraw"}
                      </Button>
                    </div>
                  )}
                </article>
              ))}
            </div>
            {view.withdrawn > 0 && <p className="note">{view.withdrawn} earlier {view.withdrawn === 1 ? "deposit" : "deposits"} withdrawn.</p>}
            {view.otherChainDeposits && <p className="note">You also have deposits on other chains: see the <ViewSwitchLink to="advanced" /> to manage them.</p>}
          </section>

          <section className="vt-section" aria-label="Your winnings">
            <h2>Your winnings</h2>
            {w.readyNow === 0 && w.readyLater === 0 ? (
              <p className="meta">Win Matches and your winnings show up here, ready to cash out.</p>
            ) : (
              <div className="vt-wins">
                <div className="cut cut-card vt-win now">
                  <h3>Ready now</h3>
                  <GemaAmount value={w.readyNow} size="lg" usd />
                  <p className="meta">Free to cash out.</p>
                  <Button variant="money" disabled={!signer || w.readyNow === 0 || busy !== null} onClick={() => void cashOut()}>
                    {busy === "cash" ? "Cashing out…" : "Cash out"}
                  </Button>
                </div>
                <div className="cut cut-card vt-win">
                  <h3>Ready later</h3>
                  <GemaAmount value={w.readyLater} size="lg" usd />
                  <p className="meta">
                    {w.readyLater === 0
                      ? "Nothing waiting."
                      : w.readyLaterAtMs
                        ? `Free to cash out from about ${fmtBackAt(w.readyLaterAtMs)}.`
                        : `Free to cash out as the deposits behind them earn, within about ${PACK_MONTHS} months.`}
                  </p>
                  {w.instant ? (
                    <>
                      <Button disabled={!signer || busy !== null} onClick={() => void cashOutSoon()}>
                        {busy === "now" ? "Cashing out…" : "Cash out now"}
                      </Button>
                      <p className="note">You keep {w.instant.keepPct}%: about {fmtUsd(Math.round(w.instant.usd * 100) / 100)} for {fmtGemas(w.instant.gemas)} Gemas.</p>
                    </>
                  ) : (
                    w.readyLater > 0 && <p className="note">Cashing out now isn&apos;t available right now.</p>
                  )}
                </div>
              </div>
            )}
            <div className="vt-foot">
              <p className="note dep-info">
                <Info aria-hidden="true" />
                <span>{TEST_MODE ? "Cash out to your wallet. In test mode it pays test SOL." : "Cash out to your wallet."}</span>
              </p>
              {view.otherChainWinnings && <p className="note">You also have winnings on other chains: see the <ViewSwitchLink to="advanced" />.</p>}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
