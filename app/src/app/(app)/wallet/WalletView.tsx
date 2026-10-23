"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CLUSTER } from "@/lib/cluster-settings";
import { Button, Sheet, SkeletonCards, CountUp } from "@/components/ui";
import { redeemableOf, useAccount } from "@/lib/account";
import { DEFAULT_HORIZON_MONTHS } from "@/lib/advance";
import { fmtAsset, fmtGemas, fmtUsd } from "@/lib/format";
import { onGetGemas } from "@/lib/get-gemas";
import { requestDeposit } from "@/lib/deposit/bus";
import { useViewMode } from "@/lib/deposit/use-view-mode";
import { ProViewSwitch } from "@/components/deposit/ProViewSwitch";
import { type Chain, type GemaHolding, type Position } from "@/lib/mock";
import { useGuideTip } from "@/components/guide/Guide";
import { AdvanceSheet } from "./AdvanceSheet";
import type { AccountSnapshot, ChainPosition } from "@/lib/chain/read";
import { returnRows } from "@/lib/chain/return-own";
import { gemasInAsset } from "@/lib/chain/ledger";
import { clockOf, nativeNow, speedupOf, stakeGrowthOf, unlockEstimateMs } from "@/lib/chain/native";
import { RedeemSheet, ReturnOwnSheet, ReturnSheet } from "./MoneySheets";
import { NativeOpenForm, NativePositionCard, NativeRedeemSheet, nativeRedeemables } from "./NativePositions";
import { EthOpenForm, EthOps, EthPositionCard, ethRedeemables, ethYieldWaiting } from "./EthPositions";
import { vaultsOn, type EthVault } from "@/lib/chain/eth";
import { OpenPanel, OpenFormView, OpenIntentContext, type OpenIntent } from "./OpenPanel";
import { BalanceHero } from "@/components/money/BalanceHero";
import { CARD, NextIn } from "@/components/money/card-copy";
import { HoverHint } from "@/components/money/Tip";
import { instantCandidates, useInstantRedeem } from "./instant";
import { ChainPockets, type Pocket, type PocketSource } from "./ChainPockets";
import { PositionTile, linearSeries } from "./PositionTile";
import "./wallet.css";

const REAL = CLUSTER.yieldModel === "real";

/**
 * The Advanced view. `part` splits it for the Vault page: "card" is the balance card both views share (with its Redeem
 * and Instant Redeem), "body" is everything under the view toggle. Without it, both.
 */
export function WalletView({ part = "all" }: { part?: "all" | "card" | "body" }) {
  const card = part !== "body";
  const body = part !== "card";
  const { gemas, positions, holdings, auth, onChain, loading, ready, error, refresh, snapshot } = useAccount();
  const [tab, setTab] = useState<Chain>("SOL");
  const [advanceFor, setAdvanceFor] = useState<Position | null>(null);
  const [returnFor, setReturnFor] = useState<Position | null>(null);
  const [chainReturnFor, setChainReturnFor] = useState<ChainPosition | null>(null);
  const [redeemOpen, setRedeemOpen] = useState(false);
  // A chain's own Redeem pays only that chain; the balance's Redeem pays every chain.
  const [redeemChain, setRedeemChain] = useState<Chain | undefined>(undefined);
  const [months, setMonths] = useState(DEFAULT_HORIZON_MONTHS);
  const [now] = useState(() => Date.now());
  const [openSheet, setOpenSheet] = useState(false);
  const [intent, setIntent] = useState<OpenIntent | null>(null);
  const router = useRouter();
  const { mode, setMode } = useViewMode();
  const simpleCard = mode === "simple";
  // The Vault's Buy Gemas button, the top bar's Gemas pill and `/vault?open=1` open this sheet (a game adds what it needs).
  useEffect(() => {
    if (!body) return;
    return onGetGemas((from) => auth.gate("buy Gemas", () => {
      setIntent(from ? { game: from.game, need: from.need ?? null } : null);
      setOpenSheet(true);
    }));
  }, [auth, body]);
  const { offer: instantOffer } = useInstantRedeem();
  const wonPending = instantCandidates(snapshot?.holdings ?? []).length > 0;
  // What Instant Redeem would pay now, in dollars: the Gemas the Treasury can buy, less the fee. "Up to" when it can't buy them all.
  const instantGemas = (instantOffer?.rows ?? []).reduce((t, r) => t + r.gemas, 0);
  const instantCandidatesGemas = instantCandidates(snapshot?.holdings ?? []).reduce((t, h) => t + Number(h.pending), 0);
  const instantCapped = instantGemas > 0 && instantGemas < instantCandidatesGemas;
  const instantUsdText = `≈ ${fmtUsd(Math.floor((instantGemas * (100 - (instantOffer?.feePct ?? 25))) / 100) / 100)}`;
  useGuideTip({
    id: "wallet-first",
    pose: "himExplain",
    title: "Pending is not lost",
    text: REAL
      ? "Gemas you win stay Pending until the yield of their Lock lands, then they become redeemable."
      : "Gemas you win stay Pending until the yield of their Lock lands, then they become redeemable. Yield here is simulated: 1 month = 10 min.",
  });

  const market = snapshot?.market ?? null;
  const nativeIds = new Set((snapshot?.positions ?? []).filter((p) => p.native).map((p) => p.address.toBase58()));
  const ethIds = new Set((snapshot?.positions ?? []).filter((p) => p.eth).map((p) => p.address.toBase58()));
  const nativeRedeemable =
    nativeRedeemables(snapshot?.holdings ?? []).reduce((s, h) => s + Number(h.redeemable), 0) +
    ethRedeemables(snapshot?.holdings ?? []).reduce((s, h) => s + Number(h.redeemable), 0);
  const redeemAmount = onChain ? nativeRedeemable : gemas.redeemable;
  // Won ETH or HYPE Gemas that are all pending: Redeem fetches the latest yield first, so it stays pressable.
  const canFetchYield = onChain && ethYieldWaiting(snapshot?.holdings ?? []).length > 0;
  // Pending is what is left of the Total after Redeemable now, so the hero adds up and matches the chain cards (which use the same figures).
  const pendingAmount = Math.max(0, gemas.total - redeemAmount);
  // Pending split by who pays it: your own Locks' yield (just waits) and other Players' (won: Instant Redeem can buy it now).
  const heldOnChain = snapshot?.holdings ?? [];
  const ownPending = heldOnChain.filter((h) => h.isOwn).reduce((t, h) => t + Number(h.free - h.redeemable), 0);
  const wonPendingGemas = heldOnChain.filter((h) => !h.isOwn).reduce((t, h) => t + Number(h.free - h.redeemable), 0);
  // The Simple view's Winnings: every won Gema you hold (cashed out through Redeem, or Instant Redeem while pending).
  const winnings = onChain ? heldOnChain.filter((h) => !h.isOwn).reduce((t, h) => t + Number(h.free), 0) : gemas.redeemable;
  // Which sheet opens is decided when it renders, not when the tap happened: a tap while the session
  // is still loading must not open the offline sheet once the Account turns out to be on chain.
  const openRedeem = (chain?: Chain) =>
    auth.gate("Redeem", () => {
      setRedeemChain(chain);
      setRedeemOpen(true);
    });
  const offline = auth.status === "unconfigured";
  const generic = positions.filter((p) => !nativeIds.has(p.id) && !ethIds.has(p.id));

  const genericTile = (p: Position, label: string) => {
    const yearly = p.principal * p.apy;
    const monthsToZero = yearly > 0 ? p.debt / (yearly / 12) : null;
    const zeroAt = p.debt > 0 && monthsToZero !== null ? now + monthsToZero * 10 * 60_000 : null;
    const chainPos = snapshot?.positions.find((x) => x.address.toBase58() === p.id) ?? null;
    const canReturn = !!chainPos && !!snapshot && returnRows(snapshot.holdings, chainPos.address, snapshot.accountKey).length > 0;
    return (
      <PositionTile
        key={p.id}
        chain={p.chain}
        label={label}
        compact
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
            {!onChain && p.advance && (
              <Button size="sm" onClick={() => auth.gate("return Gemas", () => setReturnFor(p))}>Return Gemas</Button>
            )}
            {onChain && canReturn && <Button size="sm" onClick={() => setChainReturnFor(chainPos)}>Return Gemas</Button>}
          </div>
        )}
      </PositionTile>
    );
  };

  /** A chain's own Positions, numbered in the order they were read; unlocked ones apart, they only pile up. */
  const chainTiles = (chain: Chain) => {
    const positions: React.ReactNode[] = [];
    const closed: React.ReactNode[] = [];
    let n = 0;
    for (const p of (snapshot?.positions ?? []).filter((x) => (chain === "SOL" ? x.native : x.eth && x.asset === chain))) {
      const label = `${chain} Lock ${++n}`;
      const tile = p.native ? (
        <NativePositionCard key={p.address.toBase58()} position={p} market={market} label={label} compact />
      ) : (
        <EthPositionCard key={p.address.toBase58()} position={p} market={null} label={label} compact />
      );
      (p.status === "unlocked" ? closed : positions).push(tile);
    }
    for (const p of generic.filter((x) => x.chain === chain)) positions.push(genericTile(p, `${chain} Lock ${++n}`));
    return { positions, closed };
  };

  /** When the soonest of your own repaying Positions on a chain covers its Debt: those Gemas turn redeemable then. Null when unknown. */
  const nextRedeemAt = (chain: Chain): number | null => {
    const times: number[] = [];
    const speedup = speedupOf(market?.pool);
    const stake = stakeGrowthOf(market);
    for (const p of snapshot?.positions ?? []) {
      const info = p.native;
      if (chain !== "SOL" || !info || p.status !== "locked") continue;
      const cur = nativeNow(info, speedup, Math.floor(now / 1000), stake);
      if (!cur.source || cur.debtGemas === 0n) continue;
      const at = unlockEstimateMs({ clock: clockOf(info), speedup, appliedNet: info.appliedNet, source: cur.source, nowMs: now, stake });
      if (at !== null) times.push(at);
    }
    for (const p of generic.filter((x) => x.chain === chain && x.debt > 0)) {
      const yearly = p.principal * p.apy;
      const at = p.advance?.unlockEstimate ? Date.parse(p.advance.unlockEstimate) : yearly > 0 ? now + (p.debt / (yearly / 12)) * 10 * 60_000 : NaN;
      if (Number.isFinite(at)) times.push(at);
    }
    return times.length ? Math.min(...times) : null;
  };

  const pockets: Pocket[] = (["SOL", "ETH", "HYPE"] as Chain[])
    .map((chain) => ({ chain, nextRedeemAt: nextRedeemAt(chain), ...chainTiles(chain), ...(onChain && snapshot ? chainGemas(snapshot.holdings, chain) : mockGemas(holdings, chain)), fetchYield: onChain && ethYieldWaiting(snapshot?.holdings ?? [], chain).length > 0 }))
    .filter((p) => p.positions.length > 0 || p.closed.length > 0 || p.gemas > 0);
  const hasPositions = pockets.some((p) => p.positions.length > 0 || p.closed.length > 0);
  const heroNext = pockets.filter((p) => p.gemas > p.redeemable && p.nextRedeemAt).reduce<number | null>((m, p) => (m === null || p.nextRedeemAt! < m ? p.nextRedeemAt! : m), null);

  return (
    <div className={part === "all" ? "wl" : "wl-part"}>
      {card && simpleCard && <BalanceHero
        label="Gemas"
        labelInfo={REAL ? undefined : <>Test mode · simulated yield, 1 month = 10 min. 1 Gema = $0.01.</>}
        figure={ready ? <CountUp value={gemas.total} /> : "—"}
        usdOf={ready ? gemas.total : undefined}
        busy={!ready}
        simulated={false}
        rows={[{
          label: "Winnings",
          emerald: true,
          figure: ready ? fmtGemas(winnings) : "—",
          usdOf: ready ? winnings : undefined,
          action: (
            <Button disabled={!ready || winnings === 0} onClick={() => openRedeem()}>
              Cash out
            </Button>
          ),
        }]}
        error={error && (
          <p className="status err wl-hero-err" role="alert">
            Could not read your Account from {CLUSTER.solana.label}. <Button size="sm" onClick={() => void refresh()}>Retry</Button>
          </p>
        )}
      />}
      {card && !simpleCard && <BalanceHero
        label={CARD.total}
        labelInfo={REAL ? undefined : <>Test mode · simulated yield, 1 month = 10 min. 1 Gema = $0.01.</>}
        figure={ready ? <CountUp value={gemas.total} /> : "—"}
        usdOf={ready ? gemas.total : undefined}
        busy={!ready}
        simulated={!REAL}
        totalNote={ready && gemas.reserved > 0 ? <>In play: <b className="tnum">{fmtGemas(gemas.reserved)}</b> {CARD.inPlay}</> : undefined}
        rows={[
          {
            label: CARD.now,
            figure: ready ? fmtGemas(redeemAmount) : "—",
            usdOf: ready ? redeemAmount : undefined,
            emerald: true,
            info: CARD.nowInfo(!REAL),
            action: (
              <HoverHint align="end" hint={ready && redeemAmount === 0 ? (canFetchYield ? CARD.redeemCheck : CARD.redeemEmpty) : null}>
                <Button variant="money" disabled={redeemAmount === 0 && !canFetchYield} onClick={() => openRedeem()}>{CARD.redeem}</Button>
              </HoverHint>
            ),
          },
          {
            label: CARD.own,
            figure: ready ? fmtGemas(onChain ? ownPending : pendingAmount) : "—",
            usdOf: ready ? (onChain ? ownPending : pendingAmount) : undefined,
            info: (
              <>
                {CARD.ownInfo} {ready && ownPending > 0 && <NextIn at={heroNext} />}
              </>
            ),
          },
          {
            label: CARD.won,
            figure: ready ? fmtGemas(onChain ? wonPendingGemas : 0) : "—",
            usdOf: ready ? (onChain ? wonPendingGemas : 0) : undefined,
            info: CARD.wonInfo(100 - (instantOffer?.feePct ?? 25)),
            action: (
              <HoverHint
                align="end"
                hint={!ready ? null : !wonPending ? CARD.instantNoneWon : instantOffer?.unavailable ? CARD.instantUnavailable : CARD.instantGet(instantUsdText, instantCapped)}
              >
                <Button disabled={!ready || !wonPending || !instantOffer || !!instantOffer.unavailable} onClick={() => openRedeem()}>
                  {CARD.instant}
                </Button>
              </HoverHint>
            ),
            note: instantOffer && !instantOffer.unavailable && instantGemas > 0 ? CARD.instantNote(instantUsdText, instantCapped) : undefined,
          },
        ]}
        error={error && (
          <p className="status err wl-hero-err" role="alert">
            Could not read your Account from {CLUSTER.solana.label}. <Button size="sm" onClick={() => void refresh()}>Retry</Button>
          </p>
        )}
      />}

      {body && <section className="wl-positions" aria-label="Your Gemas and Locks by chain">
        {onChain && loading && positions.length === 0 && (
          <div className="wl-pockets">
            <SkeletonCards count={2} avatar={false} className="wl-tile" label="Loading your Locks…" />
          </div>
        )}
        {gemas.reserved > 0 && (
          <p className="note" role="status">
            {fmtGemas(gemas.reserved)} of your Gemas are reserved for your Backing Offers; {fmtGemas(gemas.available)} available. <a href="/backing">See Backing</a>
          </p>
        )}
        {pockets.length > 0 && <ChainPockets pockets={pockets} onRedeem={openRedeem} />}
        {onChain && <EthOps />}
      </section>}

      {body && <footer className="wl-foot">
        {hasPositions && <p className="note">Unlock Estimate is an estimate, not a promise: it moves with the provider&apos;s actual yield. Charts are projections from the live yield rate.</p>}
        {onChain && <p className="note">{REAL ? "Redeem pays the staking token (jitoSOL for SOL Locks) from the yield your Lock has earned so far." : "Redeem pays test SOL (simulated) from the yield your Lock has earned so far."}</p>}
      </footer>}

      {body && <Sheet
        open={openSheet}
        onClose={() => setOpenSheet(false)}
        title="Buy Gemas"
        actions={<ProViewSwitch on tip={false} onChange={() => {
          // Pro view off: save it and swap to the deposit packs, with the game the Player came from.
          setMode("simple");
          setOpenSheet(false);
          requestDeposit(intent);
        }} />}
      >
        <OpenIntentContext.Provider value={intent}>
        <OpenPanel tab={tab} onTab={setTab}>
          {tab === "SOL" && (onChain ? <NativeOpenForm market={market} loading={loading} onDone={() => setOpenSheet(false)} /> : <IdleForm unit="SOL" months={months} onMonths={setMonths} />)}
          {tab === "ETH" && (onChain ? <EthVaultForm unit="ETH" vault={vaultsOn("hoodi")[0]} onOpened={(key) => router.push(`/wallet/opening?op=${encodeURIComponent(key)}`)} /> : <IdleForm unit="ETH" months={months} onMonths={setMonths} />)}
          {tab === "HYPE" && (onChain ? <EthVaultForm unit="HYPE" vault={vaultsOn("hyperevm")[0]} onOpened={(key) => router.push(`/wallet/opening?op=${encodeURIComponent(key)}`)} /> : <IdleForm unit="HYPE" months={months} onMonths={setMonths} />)}
        </OpenPanel>
        </OpenIntentContext.Provider>
      </Sheet>}
      <NativeRedeemSheet open={redeemOpen && onChain} asset={redeemChain} onClose={() => setRedeemOpen(false)} />
      <AdvanceSheet position={advanceFor} onClose={() => setAdvanceFor(null)} />
      <ReturnSheet position={returnFor} onClose={() => setReturnFor(null)} />
      {chainReturnFor && <ReturnOwnSheet position={chainReturnFor} open onClose={() => setChainReturnFor(null)} />}
      <RedeemSheet open={redeemOpen && offline} onClose={() => setRedeemOpen(false)} />
    </div>
  );
}

/** The ETH and HYPE tabs: on the mainnet cluster a chain whose vault address is not set has nothing to open yet. */
function EthVaultForm({ unit, vault, onOpened }: { unit: "ETH" | "HYPE"; vault: EthVault | undefined; onOpened: (opKey: string) => void }) {
  if (!vault) return <p className="note">Locking {unit} is not available yet. It will appear here as soon as it is.</p>;
  return <EthOpenForm vault={vault} onOpened={onOpened} />;
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
      buttonLabel="Get Gemas"
      disabled
      onSubmit={() => undefined}
    />
  );
}

const short = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;

/** One chain's Gemas from the Account read: what they redeem for, and the Players the won ones came from. */
function chainGemas(all: AccountSnapshot["holdings"], chain: Chain): Omit<Pocket, "chain" | "positions" | "closed"> {
  const hs = all.filter((h) => h.asset === chain);
  const payable = hs.filter((h) => h.native || h.eth);
  const sources = new Map<string, PocketSource>();
  for (const h of hs) {
    if (h.isOwn) continue;
    const cur = sources.get(h.sourceOwner) ?? { key: h.sourceOwner, account: h.sourceOwner, owner: short(h.sourceOwner), gemas: 0, redeemable: 0 };
    cur.gemas += Number(h.amount);
    cur.redeemable += Number(h.redeemable);
    sources.set(h.sourceOwner, cur);
  }
  return {
    gemas: hs.reduce((t, h) => t + Number(h.amount), 0),
    gemasAsset: hs.reduce((t, h) => t + gemasInAsset(h.amount, h), 0),
    redeemable: payable.reduce((t, h) => t + Number(h.redeemable), 0),
    redeemableAsset: payable.reduce((t, h) => t + gemasInAsset(h.redeemable, h), 0),
    sources: [...sources.values()],
  };
}

/** The same from offline (sample) holdings, which carry no prices or Account keys. */
function mockGemas(all: GemaHolding[], chain: Chain): Omit<Pocket, "chain" | "positions" | "closed"> {
  const hs = all.filter((h) => h.source.chain === chain);
  const sources = new Map<string, PocketSource>();
  for (const h of hs) {
    if (h.own) continue;
    const cur = sources.get(h.source.owner) ?? { key: h.source.owner, account: null, owner: h.source.owner, gemas: 0, redeemable: 0 };
    cur.gemas += h.gemas;
    cur.redeemable += redeemableOf(h);
    sources.set(h.source.owner, cur);
  }
  return {
    gemas: hs.reduce((t, h) => t + h.gemas, 0),
    gemasAsset: null,
    redeemable: hs.reduce((t, h) => t + redeemableOf(h), 0),
    redeemableAsset: null,
    sources: [...sources.values()],
  };
}
