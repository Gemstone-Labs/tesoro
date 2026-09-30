"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Button, Card, ChainChip, ClockIcon, GemaMark, Label, Meter } from "@/components/ui";
import { redeemableOf, useAccount } from "@/lib/account";
import { fmtAsset, fmtGemas, fmtUsd, fmtWhen, gemasToUsd } from "@/lib/format";
import type { Chain, Position } from "@/lib/mock";
import { useGuideTip } from "@/components/guide/Guide";
import { AdvanceSheet } from "./AdvanceSheet";
import { DEMO_ADVANCE } from "@/lib/chain/config";
import { DemoAdvanceSheet } from "./DemoAdvanceSheet";
import { RedeemSheet, ReturnSheet } from "./MoneySheets";
import { NativeOpenForm, NativePositionCard, NativeRedeemSheet, nativeRedeemables } from "./NativePositions";
import { EthOpenForm, EthOps, EthPositionCard, ethRedeemables } from "./EthPositions";
import { OpenPanel, OpenFormView, CHAINS } from "./OpenPanel";
import { PositionTile, emptyRows, linearSeries } from "./PositionTile";
import "./wallet.css";

const CHAIN_NAME: Record<Chain, string> = { SOL: "SOL", ETH: "ETH", HYPE: "HYPE" };

export default function Wallet() {
  const { gemas, positions, holdings, auth, onChain, loading, snapshot } = useAccount();
  const [demoOpen, setDemoOpen] = useState(false);
  const [tab, setTab] = useState<Chain>("SOL");
  const [nativeRedeemOpen, setNativeRedeemOpen] = useState(false);
  const [advanceFor, setAdvanceFor] = useState<Position | null>(null);
  const [returnFor, setReturnFor] = useState<Position | null>(null);
  const [redeemOpen, setRedeemOpen] = useState(false);
  const [months, setMonths] = useState(3);
  const [now] = useState(() => Date.now());
  const panel = useRef<HTMLDivElement>(null);
  const router = useRouter();
  useGuideTip({
    id: "wallet-first",
    bust: "himExplain",
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
  const openRedeem = () => auth.gate("Redeem", () => (onChain ? setNativeRedeemOpen(true) : setRedeemOpen(true)));

  // Pending by Source: each Source's unredeemable Gemas, grouped by its chain.
  const byChain = new Map<Chain, number>();
  for (const h of holdings) {
    const pend = h.gemas - redeemableOf(h);
    if (pend > 0) byChain.set(h.source.chain, (byChain.get(h.source.chain) ?? 0) + pend);
  }
  const pendingRows = [...byChain.entries()].sort((a, b) => b[1] - a[1]);

  const generic = positions.filter((p) => !nativeIds.has(p.id) && !ethIds.has(p.id));
  const openTab = (c: Chain) => {
    setTab(c);
    panel.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  const genericTile = (p: Position) => {
    const yearly = p.principal * p.apy;
    const monthsToZero = yearly > 0 ? p.debt / (yearly / 12) : null;
    const zeroAt = p.debt > 0 && monthsToZero !== null ? now + monthsToZero * 10 * 60_000 : null;
    const canRedeem = holdings.some((h) => h.source.positionId === p.id && redeemableOf(h) > 0);
    return (
      <PositionTile
        key={p.id}
        chain={p.chain}
        label={`${p.asset} Position`}
        status="active"
        rows={{
          principal: fmtAsset(p.principal, p.asset),
          debt: fmtAsset(p.debt, p.asset),
          apy: `${(p.apy * 100).toFixed(1)}%`,
          unlock: p.advance ? (p.advance.unlockEstimate ? fmtWhen(p.advance.unlockEstimate).replace(" UTC", "") : "Once yield accrues") : "No open Advance",
        }}
        chartTitle={`Debt (${p.asset})`}
        series={p.advance && p.debt > 0 ? linearSeries(p.debt, now, zeroAt) : null}
        fmt={(n) => n.toLocaleString("en-US", { maximumFractionDigits: 3 })}
      >
        {!p.advance && !onChain ? (
          <Button variant="money" size="sm" block onClick={() => auth.gate("take an Advance", () => setAdvanceFor(p))}>Take an Advance</Button>
        ) : (
          <div className="wl-actions-row">
            <Button variant="money" size="sm" disabled={!canRedeem} onClick={openRedeem}>Redeem</Button>
            {!onChain && p.advance && (
              <Button size="sm" onClick={() => auth.gate("return Gemas", () => setReturnFor(p))}>Return Gemas</Button>
            )}
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
    if (chain === "ETH") {
      for (const p of (snapshot?.positions ?? []).filter((x) => x.eth)) {
        tiles.push(<EthPositionCard key={p.address.toBase58()} position={p} market={null} />);
      }
    }
    for (const p of generic.filter((x) => x.chain === chain)) tiles.push(genericTile(p));
    if (tiles.length > 0) return tiles;
    return [
      <PositionTile key="none" chain={chain} label={`${chain} Position`} status={chain === "HYPE" ? "soon" : "none"} rows={emptyRows} chartTitle={`Debt (${chain})`} series={null}>
        {chain === "HYPE" ? (
          <>
            <Button size="sm" block disabled>HyperEVM coming soon</Button>
            <p className="note wl-tile-note">HYPE Positions open once HyperEVM support lands. Nothing to do here yet.</p>
          </>
        ) : (
          <Button variant="money" size="sm" block onClick={() => auth.gate(`open a ${chain} Position`, () => openTab(chain))}>
            Open {chain === "ETH" ? "an" : "a"} {chain} Position
          </Button>
        )}
      </PositionTile>,
    ];
  };

  return (
    <div className="wl">
      <header className="page-head wl-head">
        <div>
          <h1 className="page-title">Wallet</h1>
          <p className="page-sub">Manage your positions, advances and Gemas.</p>
        </div>
        <div className="page-head-side">
          <b>1 Gema = $0.01</b>
          <span className="sim">Simulated yield · 1 month = 10 min</span>
        </div>
      </header>

      <div className="wl-top">
        <section className="cut cut-card facet-panel wl-total" aria-label="Total Balance">
          <h2>Total Balance</h2>
          <div className="wl-total-fig">
            <GemaMark size={96} glint />
            <b>{fmtGemas(gemas.total)}</b>
            <span>Gemas</span>
          </div>
          <p className="meta tnum">≈ {fmtUsd(gemasToUsd(gemas.total))} at issuance · <span className="sim">Simulated yield · 1 month = 10 min</span></p>
        </section>

        <section className="cut cut-card facet-panel wl-redeemable" aria-label="Redeemable now">
          <h2>Redeemable now</h2>
          <b>{fmtGemas(redeemAmount)}</b>
          <span>Gemas</span>
          <Button variant="money" block disabled={redeemAmount === 0} onClick={openRedeem}>Redeem</Button>
        </section>

        <section className="cut cut-card wl-pending" aria-label="Pending">
          <h2>Pending</h2>
          <ClockIcon className="wl-clock" aria-hidden="true" />
          <b>{fmtGemas(gemas.pending)}</b>
          <span>Gemas</span>
        </section>
      </div>

      <section className="cut cut-card wl-pbs" aria-label="Pending by Source">
        <div className="wl-pbs-head">
          <h2>Pending by Source</h2>
          <span>Share of {fmtGemas(gemas.pending)} pending · redeemable as each Source&apos;s yield lands</span>
        </div>
        {pendingRows.length === 0 && <p className="meta">Nothing pending.</p>}
        {pendingRows.map(([chain, amt]) => {
          const share = gemas.pending > 0 ? amt / gemas.pending : 0;
          return (
            <div className="wl-pbs-row" key={chain}>
              <ChainChip chain={chain} />
              <b className="tnum">{fmtGemas(amt)}</b>
              <Meter value={share} label={`${CHAIN_NAME[chain]} share of pending`} />
              <span className="tnum">{Math.round(share * 100)}%</span>
            </div>
          );
        })}
      </section>

      <section className="wl-positions" aria-labelledby="pos-h">
        <h2 id="pos-h" className="h-section">Your positions</h2>
        {onChain && loading && positions.length === 0 && <p className="meta">Reading Positions from Solana devnet…</p>}
        {gemas.reserved > 0 && (
          <p className="note" role="status">
            {fmtGemas(gemas.reserved)} of your Gemas are reserved for your Backing Offers; {fmtGemas(gemas.available)} available. <a href="/backing">See Backing</a>
          </p>
        )}
        <div className="wl-grid">
          {CHAINS.map((c) => (
            <div className="wl-col" key={c}>{chainTiles(c)}</div>
          ))}
        </div>
        <p className="note">Unlock Estimate is an estimate, not a promise: it moves with the provider&apos;s actual yield. Charts are projections from the live yield rate.</p>
        {onChain && <EthOps />}
      </section>

      <div className="wl-side" ref={panel}>
        <OpenPanel tab={tab} onTab={setTab}>
          {tab === "SOL" && (onChain ? <NativeOpenForm market={market} loading={loading} /> : <IdleForm unit="SOL" months={months} onMonths={setMonths} />)}
          {tab === "ETH" && (onChain ? <EthOpenForm onOpened={(key) => router.push(`/wallet/opening?op=${encodeURIComponent(key)}`)} /> : <IdleForm unit="ETH" months={months} onMonths={setMonths} />)}
          {tab === "HYPE" && (
            <div className="stack">
              <IdleForm unit="HYPE" months={months} onMonths={setMonths} soon />
            </div>
          )}
        </OpenPanel>
        {onChain && DEMO_ADVANCE && (
          <Card large>
            <div className="stack">
              <Label>Dev only</Label>
              <Button block onClick={() => setDemoOpen(true)}>Take a demo Advance</Button>
              <span className="sim">Simulated · demo Advance (NEXT_PUBLIC_DEMO_ADVANCE)</span>
            </div>
          </Card>
        )}
        {onChain && <p className="note">Redeem pays simSOL (Simulated) from the Source Position&apos;s accrued yield. Balances are read from Solana devnet.</p>}
      </div>

      <NativeRedeemSheet open={nativeRedeemOpen} onClose={() => setNativeRedeemOpen(false)} />
      {DEMO_ADVANCE && <DemoAdvanceSheet open={demoOpen} onClose={() => setDemoOpen(false)} />}
      <AdvanceSheet position={advanceFor} onClose={() => setAdvanceFor(null)} />
      <ReturnSheet position={returnFor} onClose={() => setReturnFor(null)} />
      <RedeemSheet open={redeemOpen} onClose={() => setRedeemOpen(false)} />
    </div>
  );
}

/** The open form's shape before there is a market to quote from (or for a chain that is not open). */
function IdleForm({ unit, months, onMonths, soon = false }: { unit: string; months: number; onMonths: (m: number) => void; soon?: boolean }) {
  return (
    <OpenFormView
      unit={unit}
      inert
      amountText=""
      onAmount={() => undefined}
      months={months}
      onMonths={onMonths}
      gemas={null}
      estimate="—"
      note={soon ? "HyperEVM Positions are not open yet." : "Sign in to see your balance and a real quote."}
      buttonLabel={soon ? "HyperEVM coming soon" : "Open a Position"}
      disabled
      onSubmit={() => undefined}
    />
  );
}
