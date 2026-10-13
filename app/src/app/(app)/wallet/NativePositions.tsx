"use client";

import { useEffect, useRef, useState } from "react";
import { Button, CheckIcon, ClockIcon, GemaAmount, Sheet } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { fmtGemas, fmtInMinutes, fmtUsd, fmtWhen, gemasToUsd } from "@/lib/format";
import { ratesOf } from "@/lib/chain/fees";
import { covered, gemasInAsset, live } from "@/lib/chain/ledger";
import {
  LAMPORTS,
  MAX_PRICE_AGE_SECS,
  SIM_MONTH_MIN,
  projectedDebtGemas,
  quoteNativeAdvance,
  rateAt,
  surplusShares,
  accruedAt,
  yieldClockOf,
  redeemPayoutShares,
  sharesValue,
  unlockEstimateMs,
  type NativeInfo,
  type NativeMarket,
} from "@/lib/chain/native";
import { netApyPct } from "@/lib/chain/yield";
import { friendlyError, getTestSimSol, instantRedeemNative, openPositionWithAdvance, redeemNative, refreshYield, sweepNative, takeNextAdvance, unlockNative } from "@/lib/chain/native-flow";
import type { ChainHolding, ChainPosition } from "@/lib/chain/read";
import { ethRedeemables, instantRedeemEthSource, redeemEthHoldings, useEthCtx } from "./EthPositions";
import { useInstantRedeem } from "./instant";
import { RedeemExchange, ReturnOwnSheet, useReturnable, type RedeemDone, type RedeemPayout } from "./MoneySheets";
import { GemasLabel } from "./AdvanceQuote";
import { AdvanceFormView, AdvanceTakenNote } from "./AdvanceSheet";
import { OpenFormView } from "./OpenPanel";
import { PositionTile, sampledSeries } from "./PositionTile";

const fmtSol = (lamports: bigint | number, digits = 4) => (Number(lamports) / LAMPORTS).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}


const DONE: Record<string, string> = {
  faucet: "Got test simSOL",
  open: "Position opened",
  advance: "Advance taken",
  refresh: "Yield refreshed",
  unlock: "Principal unlocked",
  sweep: "Leftover yield collected",
  redeem: "Redeemed",
};

function Sig({ label, sig }: { label: string; sig: string }) {
  return (
    <a className="meta mono" href={explorer(sig)} target="_blank" rel="noreferrer">
      {DONE[label] ?? label} · receipt {sig.slice(0, 8)}…
    </a>
  );
}

/** Runs one wallet action with a busy flag, the error message and the last signature. */
function useAction(refresh: () => Promise<void>) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ label: string; sig: string } | null>(null);
  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    setError(null);
    try {
      const sig = await fn();
      setDone({ label, sig });
      await refresh();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, done, run, clear: () => { setError(null); setDone(null); } };
}

// ---- Get simSOL + Open a Position ---------------------------------------------------------------

/** The SOL deposit card's balance line: your simSOL and a Get test simSOL link, the receipt or error under it. */
export function NativeFaucet({ market, loading }: { market: NativeMarket | null; loading: boolean }) {
  const { auth, refresh } = useAccount();
  const a = useAction(refresh);
  const [step, setStep] = useState("Getting simSOL");
  const signer = auth.signer;
  return (
    <>
      <span>
        {loading ? "Loading your Account…" : <>You have <b className="tnum">{market ? fmtSol(market.simSol, 3) : "—"}</b> simSOL</>}
        {" · "}
        <button type="button" className="wl-link" disabled={!signer || a.busy !== null} onClick={() => signer && a.run("faucet", () => getTestSimSol(signer, auth.getAccessToken, setStep))}>
          {a.busy === "faucet" ? `${step}…` : "Get test simSOL"}
        </button>
      </span>
      {a.done && <Sig label="faucet" sig={a.done.sig} />}
      {a.error && <p className="status err" role="alert">{a.error}</p>}
    </>
  );
}

/** The SOL tab of OPEN A POSITION: lock simSOL and take the Advance in one transaction. `market` null = not read yet. */
export function NativeOpenForm({ market, loading, onDone }: { market: NativeMarket | null; loading: boolean; onDone?: () => void }) {
  const { auth, refresh } = useAccount();
  const a = useAction(refresh);
  const balance = market ? Number(market.simSol) / LAMPORTS : 0;
  const [text, setText] = useState("");
  const [months, setMonths] = useState(3);
  const [step, setStep] = useState("Preparing");
  const now = useNow(5000);

  const amount = Number(text);
  const shares = market && Number.isFinite(amount) && amount > 0 ? BigInt(Math.round(amount * LAMPORTS)) : 0n;
  const rate = market ? rateAt(market.pool) : 0n;
  const principal = market ? sharesValue(shares, rate) : 0n;
  const priceAge = market?.price ? now / 1000 - market.price.updatedTs : Infinity;
  const priceOk = !!market?.price && priceAge <= MAX_PRICE_AGE_SECS - 60;
  const { yieldFeeBps } = ratesOf(market?.treasury);
  const quote = market && priceOk ? quoteNativeAdvance(principal, market.pool.apyBps, months, market.price!.microUsd, yieldFeeBps) : null;
  const gemas = quote ? Number(quote.gemas) : 0;
  // A fresh Position's Debt is the whole Advance: the Estimate is when the vault's yield covers it.
  const estimate = market && quote && shares > 0n && gemas > 0
    ? unlockEstimateMs({
        source: { issued: quote.gemas, returned: 0n, redeemed: 0n, yieldUnits: 0n, unitNum: 10n ** 13n, unitDen: market.price!.microUsd },
        vaultShares: shares,
        redeemedUnits: 0n,
        principalLamports: principal,
        pool: market.pool,
        clock: { rateBps: market.pool.apyBps, lastAccrualTs: Math.floor(now / 1000) },
        nowMs: now,
        yieldFeeBps,
      })
    : null;
  const tooMuch = !!market && shares > market.simSol;
  const valid = !!market && shares > 0n && !tooMuch && gemas > 0;

  if (a.done) {
    return (
      <div className="stack">
        <div className="status ok" role="status">
          <CheckIcon /> Position opened · <GemaAmount value={gemas} size="md" /> issued
        </div>
        <Sig label="open" sig={a.done.sig} />
        <Button block onClick={() => { a.clear(); setText(""); onDone?.(); }}>Done</Button>
      </div>
    );
  }

  return (
    <OpenFormView
      chain="SOL"
      apy={market ? `${market.pool.apyBps / 100}% APY` : undefined}
      inert={!market}
      amountText={text}
      onAmount={setText}
      amountInvalid={tooMuch}
      balance={<NativeFaucet market={market} loading={loading} />}
      max={market ? balance : undefined}
      months={months}
      onMonths={setMonths}
      gemas={gemas}
      yieldText={`${quote ? fmtSol(quote.projectedUnits) : "0"} SOL`}
      yieldFeeBps={yieldFeeBps}
      estimate={estimate ? `${fmtWhen(estimate)} (${fmtInMinutes(estimate, now)})` : "—"}
      details={[
        ["Worth at issuance", fmtUsd(gemasToUsd(gemas))],
        ["Principal", `${fmtSol(principal)} SOL`],
        ["Projected yield (after the Yield Fee)", `${quote ? fmtSol(quote.projectedUnits) : "—"} SOL`],
        [
          "Price feed",
          market?.price ? `SOL $${(Number(market.price.microUsd) / 1e6).toFixed(2)} · ${Math.max(0, Math.round(priceAge / 60))} min ago` : "not published yet",
        ],
      ]}
      alerts={
        <>
          {market && !priceOk && <p className="status err" role="alert">The SOL price is updating. Try again in a few minutes.</p>}
          {tooMuch && <p className="status err" role="alert">That is more simSOL than you have.</p>}
          {a.error && <p className="status err" role="alert">{a.error}</p>}
        </>
      }
      note={<span className="sim">Simulated yield · 1 month = {SIM_MONTH_MIN} min</span>}
      buttonLabel={a.busy ? `${step}…` : <GemasLabel action="Open a Position" gemas={gemas} />}
      disabled={!valid || !priceOk || a.busy !== null || !auth.signer}
      onSubmit={() => auth.signer && a.run("open", async () => (await openPositionWithAdvance(auth.signer!, auth.getAccessToken, shares, months, setStep)).signature)}
    />
  );
}

// ---- Position card ------------------------------------------------------------------------------

export function NativePositionCard({ position, market, onRedeem }: { position: ChainPosition; market: NativeMarket | null; onRedeem: () => void }) {
  const info = position.native as NativeInfo;
  const { auth, snapshot, refresh } = useAccount();
  const a = useAction(refresh);
  const now = useNow(5000);
  const signer = auth.signer;
  const returnable = useReturnable(position);
  const [returning, setReturning] = useState(false);
  const [advancing, setAdvancing] = useState(false);

  const src = info.source?.math ?? null;
  const onChainDebt = src ? live(src) - covered(src) : 0n;
  const debtSol = src && onChainDebt > 0n ? (onChainDebt * src.unitNum + src.unitDen - 1n) / src.unitDen : 0n;
  const pool = market?.pool ?? null;
  const clock = yieldClockOf(info);
  const { yieldFeeBps } = ratesOf(market?.treasury);
  const projected = pool ? projectedDebtGemas(src, info.vaultShares, info.redeemedUnits, info.principalLamports, pool, now, clock, yieldFeeBps) : onChainDebt;
  const liveYield = pool ? accruedAt({ vaultShares: info.vaultShares, redeemedUnits: info.redeemedUnits, principalLamports: info.principalLamports, pool, clock, nowMs: now, yieldFeeBps }) : info.cumulativeYield;
  const accruedYield = liveYield > info.cumulativeYield ? liveYield : info.cumulativeYield;
  const unapplied = onChainDebt - projected;
  const estimate =
    pool && src && onChainDebt > 0n
      ? unlockEstimateMs({ source: src, vaultShares: info.vaultShares, redeemedUnits: info.redeemedUnits, principalLamports: info.principalLamports, pool, clock: clock ?? { rateBps: info.rateBps, lastAccrualTs: Math.floor(now / 1000) }, nowMs: now, yieldFeeBps })
      : null;
  const locked = info.status === "locked";
  const canUnlock = locked && projected === 0n;
  // Unknown until the pool is read: keep the action rather than hide a real surplus.
  const surplus = pool ? surplusShares(info, rateAt(pool)) : null;
  const redeemable = (snapshot?.holdings ?? []).some((h) => h.native && h.position.equals(position.address) && h.redeemable > 0n);
  const series =
    pool && src && locked && onChainDebt > 0n
      ? sampledSeries((at) => Number(projectedDebtGemas(src, info.vaultShares, info.redeemedUnits, info.principalLamports, pool, at, clock, yieldFeeBps)), now, estimate ? estimate - now : 10 * 60_000)
      : null;

  return (
    <PositionTile
      chain="SOL"
      label="SOL Position"
      state={!locked ? "unlocked" : !src ? "idle" : onChainDebt === 0n ? "paid" : "repaying"}
      principal={`${fmtSol(info.principalLamports, 3)} SOL`}
      debt={!src ? null : onChainDebt > 0n ? `${fmtGemas(Number(onChainDebt))} Gemas` : "0"}
      debtAsset={onChainDebt > 0n ? `${fmtSol(debtSol, 3)} SOL` : undefined}
      apy={`${netApyPct(info.rateBps, yieldFeeBps).toFixed(1)}%`}
      yieldFeeBps={yieldFeeBps}
      unlockAt={estimate}
      now={now}
      series={series}
      notes={
        <>
          <p className="note">Accrued yield {fmtSol(accruedYield, 5)} SOL (simulated). Tesoro keeps {yieldFeeBps / 100}% of the yield (the Yield Fee), so this is your {100 - yieldFeeBps / 100}%.</p>
          {unapplied > 0n && locked && (
            <p className="note">
              <ClockIcon width={12} height={12} /> ~{fmtGemas(Number(unapplied))} Gemas of Debt are already repaid by yield and get applied on the next refresh (it happens automatically every ~20 s).
            </p>
          )}
          {locked && !canUnlock && <p className="note">Unlock returns the Principal once Debt is zero. Only this Position&apos;s own yield repays it.</p>}
          {canUnlock && <p className="note">Debt is zero: Unlock to get your SOL back, or take another Advance on the same Principal.</p>}
        </>
      }
    >
      {locked && (
        <>
          <Button size="sm" block disabled={!signer || a.busy !== null} onClick={() => signer && a.run("refresh", () => refreshYield(signer, info))}>
            {a.busy === "refresh" ? "Refreshing…" : "Refresh yield"}
          </Button>
          {canUnlock && (
            <Button variant="money" size="sm" block disabled={!signer || a.busy !== null} onClick={() => setAdvancing(true)}>Take another Advance</Button>
          )}
          <div className="wl-actions-row">
            <Button variant="money" size="sm" disabled={!signer || a.busy !== null || !redeemable} onClick={onRedeem}>Redeem</Button>
            <Button size="sm" disabled={!signer || a.busy !== null || !canUnlock} onClick={() => signer && a.run("unlock", () => unlockNative(signer, info))}>
              {a.busy === "unlock" ? "Unlocking…" : "Unlock"}
            </Button>
          </div>
          {returnable > 0n && (
            <Button size="sm" block disabled={!signer || a.busy !== null} onClick={() => setReturning(true)}>Return Gemas</Button>
          )}
          <ReturnOwnSheet position={position} open={returning} onClose={() => setReturning(false)} />
          <NativeAdvanceSheet info={info} market={market} open={advancing} onClose={() => setAdvancing(false)} />
        </>
      )}
      {!locked && surplus !== 0n && (
        <Button size="sm" block disabled={!signer || a.busy !== null} onClick={() => signer && a.run("sweep", () => sweepNative(signer, info))}>
          {a.busy === "sweep" ? "Collecting…" : surplus ? `Collect leftover yield · ${fmtSol(surplus, 4)} simSOL` : "Collect leftover yield"}
        </Button>
      )}
      {a.done && <Sig label={a.done.label} sig={a.done.sig} />}
      {a.error && <p className="status err" role="alert">{a.error}</p>}
    </PositionTile>
  );
}

// ---- Take another Advance ------------------------------------------------------------------------

/** A new Advance on a locked SOL Position whose Debt is zero: the same Principal, a new Horizon. */
export function NativeAdvanceSheet({ info, market, open, onClose }: { info: NativeInfo; market: NativeMarket | null; open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Take another Advance" className="adv-sheet">
      {open && <NativeAdvanceForm info={info} market={market} onClose={onClose} />}
    </Sheet>
  );
}

function NativeAdvanceForm({ info, market, onClose }: { info: NativeInfo; market: NativeMarket | null; onClose: () => void }) {
  const { auth, refresh } = useAccount();
  const a = useAction(refresh);
  const [months, setMonths] = useState(3);
  const [step, setStep] = useState("Preparing");
  const now = useNow(5000);
  const priceAge = market?.price ? now / 1000 - market.price.updatedTs : Infinity;
  const priceOk = !!market?.price && priceAge <= MAX_PRICE_AGE_SECS - 60;
  const { yieldFeeBps } = ratesOf(market?.treasury);
  const quote = priceOk ? quoteNativeAdvance(info.principalLamports, info.rateBps, months, market!.price!.microUsd, yieldFeeBps) : null;
  const gemas = quote ? Number(quote.gemas) : 0;
  // The Advance is the Horizon's projected yield at the Position's own rate net of the Yield Fee, which is all the Position earns, so yield repays it in exactly the Horizon.
  const unlock = gemas > 0 ? now + months * SIM_MONTH_MIN * 60_000 : null;
  const title = `${fmtSol(info.principalLamports, 3)} SOL Position`;

  if (a.done) {
    return (
      <div className="adv">
        <AdvanceTakenNote gemas={gemas} from={title} unlock={unlock ? fmtWhen(unlock) : "—"} />
        <Sig label="advance" sig={a.done.sig} />
        <Button block onClick={onClose}>Done</Button>
      </div>
    );
  }

  return (
    <AdvanceFormView
      chain="SOL"
      title={title}
      apy={`${(info.rateBps / 100).toFixed(1)}% APY`}
      months={months}
      onMonths={setMonths}
      yieldText={`${quote ? fmtSol(quote.projectedUnits) : "0"} SOL`}
      yieldFeeBps={yieldFeeBps}
      gemas={gemas}
      unlock={unlock ? `${fmtWhen(unlock)} (${fmtInMinutes(unlock, now)})` : "—"}
      alerts={
        <>
          {market && !priceOk && <p className="status err" role="alert">The SOL price is updating. Try again in a few minutes.</p>}
          {a.error && <p className="status err" role="alert">{a.error}</p>}
        </>
      }
      buttonLabel={a.busy ? `${step}…` : <GemasLabel action="Take Advance" gemas={gemas} />}
      disabled={gemas <= 0 || a.busy !== null || !auth.signer}
      onSubmit={() => auth.signer && a.run("advance", () => takeNextAdvance(auth.signer!, auth.getAccessToken, info, months, setStep))}
    />
  );
}

// ---- Redeem -------------------------------------------------------------------------------------

export function nativeRedeemables(holdings: ChainHolding[]) {
  return holdings.filter((h) => h.native && h.redeemable > 0n);
}

export function NativeRedeemSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Redeem">
      {open && <RedeemForm onClose={onClose} />}
    </Sheet>
  );
}

function RedeemForm({ onClose }: { onClose: () => void }) {
  const { auth, snapshot, refresh } = useAccount();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<RedeemDone | null>(null);
  const sigs = useRef<string[]>([]);
  const rows = nativeRedeemables(snapshot?.holdings ?? []);
  const ethRows = ethRedeemables(snapshot?.holdings ?? []);
  const ethCtx = useEthCtx();
  const pool = snapshot?.market?.pool ?? null;
  const from = (h: ChainHolding) => (h.isOwn ? `Your ${h.asset} Position` : `Won · ${h.sourceOwner.slice(0, 4)}…${h.sourceOwner.slice(-4)}`);
  const payouts: RedeemPayout[] = [
    ...rows.map((h) => ({
      key: h.holding.toBase58(),
      asset: "SOL" as const,
      from: from(h),
      gemas: Number(h.redeemable),
      amount: pool ? Number(redeemPayoutShares(h, h.redeemable, rateAt(pool))) / LAMPORTS : null,
      token: "simSOL",
      later: false,
    })),
    ...ethRows.map((h) => ({
      key: h.holding.toBase58(),
      asset: h.asset,
      from: from(h),
      gemas: Number(h.redeemable),
      amount: gemasInAsset(h.redeemable, h),
      token: h.asset,
      later: true,
    })),
  ];

  const { offer: instant, plan } = useInstantRedeem();

  const redeemNow = async () => {
    if (!auth.signer) return;
    setBusy(true);
    setError(null);
    try {
      for (const { holding: h, line } of plan) {
        if (h.native) sigs.current.push(await instantRedeemNative(auth.signer, h.position, h.source, line.gemas, h.redeemable));
        else {
          if (!ethCtx) throw new Error("Your ETH wallet is not ready yet. Try again in a moment.");
          await instantRedeemEthSource(ethCtx, h.eth!, h.source, line.gemas);
        }
      }
      setDone({ gemas: plan.reduce((s, p) => s + Number(p.line.gemas), 0), later: plan.some((p) => !p.holding.native), instant: true, receipts: sigs.current.map((sig) => ({ label: "Redeemed now", sig })) });
      await refresh();
    } catch (e) {
      setError(friendlyError(e));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const redeem = async () => {
    if (!auth.signer) return;
    const gemas = payouts.reduce((s, p) => s + p.gemas, 0);
    setBusy(true);
    setError(null);
    try {
      for (const h of rows) sigs.current.push(await redeemNative(auth.signer, h.position, h.source, h.redeemable));
      if (ethRows.length > 0) {
        if (!ethCtx) throw new Error("Your ETH wallet is not ready yet. Try again in a moment.");
        await redeemEthHoldings(ethCtx, snapshot?.holdings ?? []);
      }
      setDone({ gemas, later: ethRows.length > 0, receipts: sigs.current.map((sig) => ({ label: "Redeemed", sig })) });
      await refresh();
    } catch (e) {
      setError(friendlyError(e));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return <RedeemExchange payouts={payouts} instant={instant} busy={busy} error={error} done={done} canSign={Boolean(auth.signer)} onRedeem={() => void redeem()} onInstant={() => void redeemNow()} onClose={onClose} />;
}
