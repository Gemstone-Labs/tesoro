"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, Card, ChainChip, FacetCrown, GemaMark, Meter, Sheet, SimulatedYieldLabel, SkeletonCards, CountUp } from "@/components/ui";
import { pendingBySource, redeemableOf, useAccount } from "@/lib/account";
import { fmtAsset, fmtGemas } from "@/lib/format";
import type { Chain, Position } from "@/lib/mock";
import { useGuideTip } from "@/components/guide/Guide";
import { AdvanceSheet } from "./AdvanceSheet";
import type { ChainPosition } from "@/lib/chain/read";
import { returnRows } from "@/lib/chain/return-own";
import { RedeemSheet, ReturnOwnSheet, ReturnSheet } from "./MoneySheets";
import { NativeOpenForm, NativePositionCard, NativeRedeemSheet, nativeRedeemables } from "./NativePositions";
import { EthOpenForm, EthOps, EthPositionCard, ethRedeemables } from "./EthPositions";
import { vaultsOn } from "@/lib/chain/eth";
import { OpenPanel, OpenFormView, HowGemasWork, NoPositions } from "./OpenPanel";
import { PositionTile, linearSeries } from "./PositionTile";
import "./wallet.css";

const shortId = (k: string) => (k.length > 12 ? `${k.slice(0, 4)}…${k.slice(-4)}` : k);

export default function Wallet() {
  const { gemas, positions, holdings, auth, onChain, loading, ready, error, refresh, snapshot } = useAccount();
  const [tab, setTab] = useState<Chain>("SOL");
  const [advanceFor, setAdvanceFor] = useState<Position | null>(null);
  const [returnFor, setReturnFor] = useState<Position | null>(null);
  const [chainReturnFor, setChainReturnFor] = useState<ChainPosition | null>(null);
  const [redeemOpen, setRedeemOpen] = useState(false);
  const [months, setMonths] = useState(3);
  const [now] = useState(() => Date.now());
  const [openSheet, setOpenSheet] = useState(false);
  const router = useRouter();
  // `/wallet?open=1` (the Lobby's Get Gemas) lands with the Open a Position sheet already up.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("open") !== "1") return;
    const t = setTimeout(() => setOpenSheet(true), 0);
    return () => clearTimeout(t);
  }, []);
  useGuideTip({
    id: "wallet-first",
    pose: "himExplain",
    title: "Pending is not lost",
    text: "Gemas you win stay Pending until the yield of their Source lands, then they become redeemable. Yield here is simulated: 1 month = 10 min.",
  });

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

  const market = snapshot?.market ?? null;
  const nativeIds = new Set((snapshot?.positions ?? []).filter((p) => p.native).map((p) => p.address.toBase58()));
  const ethIds = new Set((snapshot?.positions ?? []).filter((p) => p.eth).map((p) => p.address.toBase58()));
  const nativeRedeemable =
    nativeRedeemables(snapshot?.holdings ?? []).reduce((s, h) => s + Number(h.redeemable), 0) +
    ethRedeemables(snapshot?.holdings ?? []).reduce((s, h) => s + Number(h.redeemable), 0);
  const redeemAmount = onChain ? nativeRedeemable : gemas.redeemable;
  // Which sheet opens is decided when it renders, not when the tap happened: a tap while the session
  // is still loading must not open the offline sheet once the Account turns out to be on chain.
  const openRedeem = () => auth.gate("Redeem", () => setRedeemOpen(true));
  const offline = auth.status === "unconfigured";

  const pendingRows = pendingBySource(holdings);

  const generic = positions.filter((p) => !nativeIds.has(p.id) && !ethIds.has(p.id));
  const openTab = (c: Chain) => {
    setTab(c);
    setOpenSheet(true);
  };

  const genericTile = (p: Position) => {
    const yearly = p.principal * p.apy;
    const monthsToZero = yearly > 0 ? p.debt / (yearly / 12) : null;
    const zeroAt = p.debt > 0 && monthsToZero !== null ? now + monthsToZero * 10 * 60_000 : null;
    const canRedeem = holdings.some((h) => h.source.positionId === p.id && redeemableOf(h) > 0);
    const chainPos = snapshot?.positions.find((x) => x.address.toBase58() === p.id) ?? null;
    const canReturn = !!chainPos && !!snapshot && returnRows(snapshot.holdings, chainPos.address, snapshot.accountKey).length > 0;
    return (
      <PositionTile
        key={p.id}
        chain={p.chain}
        label={`${p.asset} Position`}
        state={!p.advance ? "idle" : p.debt > 0 ? "repaying" : "paid"}
        principal={fmtAsset(p.principal, p.asset)}
        debt={p.advance ? fmtAsset(p.debt, p.asset) : null}
        apy={`${(p.apy * 100).toFixed(1)}%`}
        unlockAt={p.advance?.unlockEstimate ? Date.parse(p.advance.unlockEstimate) : zeroAt}
        now={now}
        series={p.advance && p.debt > 0 ? linearSeries(p.debt, now, zeroAt) : null}
      >
        {!p.advance && !onChain ? (
          <Button variant="money" size="sm" block onClick={() => auth.gate("take an Advance", () => setAdvanceFor(p))}>Take an Advance</Button>
        ) : (
          <div className="wl-actions-row">
            <Button variant="money" size="sm" disabled={!canRedeem} onClick={openRedeem}>Redeem</Button>
            {!onChain && p.advance && (
              <Button size="sm" onClick={() => auth.gate("return Gemas", () => setReturnFor(p))}>Return Gemas</Button>
            )}
            {onChain && canReturn && <Button size="sm" onClick={() => setChainReturnFor(chainPos)}>Return Gemas</Button>}
          </div>
        )}
      </PositionTile>
    );
  };

  const chainTiles = (chain: Chain) => {
    const tiles: React.ReactNode[] = [];
    if (chain === "SOL") {
      for (const p of (snapshot?.positions ?? []).filter((x) => x.native)) {
        tiles.push(<NativePositionCard key={p.address.toBase58()} position={p} market={market} onRedeem={openRedeem} />);
      }
    }
    if (chain === "ETH" || chain === "HYPE") {
      for (const p of (snapshot?.positions ?? []).filter((x) => x.eth && x.asset === chain)) {
        tiles.push(<EthPositionCard key={p.address.toBase58()} position={p} market={null} />);
      }
    }
    for (const p of generic.filter((x) => x.chain === chain)) tiles.push(genericTile(p));
    return tiles;
  };

  const positionTiles = (["SOL", "ETH", "HYPE"] as Chain[]).flatMap((c) => chainTiles(c));
  const hasPositions = positionTiles.length > 0;
  const noPositions = !hasPositions && !loading;
  const openPosition = () => auth.gate("open a Position", () => openTab(tab));

  return (
    <div className="wl">
      <header className="page-head wl-head">
        <div>
          <h1 className="page-title">Wallet</h1>
          <p className="page-sub">1 Gema = $0.01</p>
        </div>
        {!noPositions && <Button variant="money" size="lg" onClick={openPosition}>Open a Position</Button>}
      </header>

      <section className="cut cut-frame facet-panel wl-hero" aria-label="Balance">
        <FacetCrown />
        <div className="wl-total">
          <h2>Total Balance</h2>
          <div className="wl-total-fig">
            <GemaMark size={72} glint />
            <b aria-busy={!ready}>{ready ? <CountUp value={gemas.total} /> : "—"}</b>
            <span>Gemas</span>
          </div>
        </div>
        <div className="wl-second">
          <div className="wl-redeemable" aria-label="Redeemable now">
            <h2>Redeemable now</h2>
            <b>{ready ? fmtGemas(redeemAmount) : "—"}</b>
            <Button variant="money" disabled={redeemAmount === 0} onClick={openRedeem}>Redeem</Button>
          </div>
          <div className="wl-pending" aria-label="Pending">
            <h2>Pending</h2>
            <b>{ready ? fmtGemas(gemas.pending) : "—"}</b>
          </div>
        </div>
        {error && (
          <p className="status err wl-hero-err" role="alert">
            Could not read your Account from Solana devnet. <Button size="sm" onClick={() => void refresh()}>Retry</Button>
          </p>
        )}
        <SimulatedYieldLabel className="wl-hero-sim" />
        <details className="wl-pbs">
          <summary>Pending by Source</summary>
          <p className="meta">Each Source becomes redeemable as its Position&apos;s yield lands.</p>
          {pendingRows.length === 0 && <p className="meta">Nothing pending.</p>}
          {pendingRows.map((s) => {
            const accrued = Math.round(s.accruedShare * 100);
            return (
              <div className="wl-pbs-row" key={s.key}>
                <ChainChip chain={s.chain} />
                <span className="wl-pbs-src">
                  {s.owner}
                  <small>{shortId(s.positionId)}</small>
                </span>
                <b className="tnum">{fmtGemas(s.pending)}</b>
                <Meter value={s.accruedShare} label={`${s.asset} Source of ${s.owner}: yield accrued`} />
                <span className="tnum">{accrued}% of yield accrued</span>
              </div>
            );
          })}
        </details>
      </section>

      <section className="wl-positions" aria-labelledby="pos-h">
        <h2 id="pos-h" className="h-section">Your positions</h2>
        <div className="wl-lower">
          <div className="wl-list">
            {onChain && loading && positions.length === 0 && (
              <div className="wl-grid">
                <SkeletonCards count={2} avatar={false} className="wl-tile" label="Loading your Positions…" />
              </div>
            )}
            {gemas.reserved > 0 && (
              <p className="note" role="status">
                {fmtGemas(gemas.reserved)} of your Gemas are reserved for your Backing Offers; {fmtGemas(gemas.available)} available. <a href="/backing">See Backing</a>
              </p>
            )}
            {hasPositions && <div className="wl-grid">{positionTiles}</div>}
            {noPositions && <NoPositions onOpen={openPosition} />}
            {onChain && <EthOps />}
          </div>
          {!noPositions && <HowGemasWork />}
        </div>
      </section>

      <footer className="wl-foot">
        {hasPositions && <p className="note">Unlock Estimate is an estimate, not a promise: it moves with the provider&apos;s actual yield. Charts are projections from the live yield rate.</p>}
        {onChain && <p className="note">Redeem pays simSOL (simulated) from the yield your Source Position has earned so far.</p>}
      </footer>

      <Sheet open={openSheet} onClose={() => setOpenSheet(false)} title="Open a Position">
        <OpenPanel tab={tab} onTab={setTab}>
          {tab === "SOL" && (onChain ? <NativeOpenForm market={market} loading={loading} onDone={() => setOpenSheet(false)} /> : <IdleForm unit="SOL" months={months} onMonths={setMonths} />)}
          {tab === "ETH" && (onChain ? <EthOpenForm vault={vaultsOn("hoodi")[0]} onOpened={(key) => router.push(`/wallet/opening?op=${encodeURIComponent(key)}`)} /> : <IdleForm unit="ETH" months={months} onMonths={setMonths} />)}
          {tab === "HYPE" && (onChain ? <EthOpenForm vault={vaultsOn("hyperevm")[0]} onOpened={(key) => router.push(`/wallet/opening?op=${encodeURIComponent(key)}`)} /> : <IdleForm unit="HYPE" months={months} onMonths={setMonths} />)}
        </OpenPanel>
      </Sheet>
      <NativeRedeemSheet open={redeemOpen && onChain} onClose={() => setRedeemOpen(false)} />
      <AdvanceSheet position={advanceFor} onClose={() => setAdvanceFor(null)} />
      <ReturnSheet position={returnFor} onClose={() => setReturnFor(null)} />
      {chainReturnFor && <ReturnOwnSheet position={chainReturnFor} open onClose={() => setChainReturnFor(null)} />}
      <RedeemSheet open={redeemOpen && offline} onClose={() => setRedeemOpen(false)} />
    </div>
  );
}

/** The open form's shape before there is a market to quote from. */
function IdleForm({ unit, months, onMonths }: { unit: Chain; months: number; onMonths: (m: number) => void }) {
  return (
    <OpenFormView
      chain={unit}
      yieldText={`0 ${unit}`}
      inert
      amountText=""
      onAmount={() => undefined}
      months={months}
      onMonths={onMonths}
      gemas={null}
      estimate="—"
      note="Sign in to see your balance and a real quote."
      buttonLabel="Open a Position"
      disabled
      onSubmit={() => undefined}
    />
  );
}
