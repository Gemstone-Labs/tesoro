"use client";

import { useEffect, useState } from "react";
import { Button, CheckIcon, Chip, ClockIcon, GemaAmount, Sheet, SimulatedYieldLabel } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { fmtGemas, fmtInMinutes, fmtUsd, fmtWhen, gemasToUsd } from "@/lib/format";
import { covered, live } from "@/lib/chain/ledger";
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
import { friendlyError, getTestSimSol, openPositionWithAdvance, redeemNative, refreshYield, sweepNative, unlockNative } from "@/lib/chain/native-flow";
import type { ChainHolding, ChainPosition } from "@/lib/chain/read";
import { ethRedeemables, redeemEthHoldings, useEthCtx } from "./EthPositions";
import { ReturnOwnSheet, useReturnable } from "./MoneySheets";
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

/** The simSOL faucet, shown above the SOL open form: balance, a Get test simSOL button, the Simulated label. */
export function NativeFaucet({ market, loading }: { market: NativeMarket | null; loading: boolean }) {
  const { auth, refresh } = useAccount();
  const a = useAction(refresh);
  const [step, setStep] = useState("Getting simSOL");
  const signer = auth.signer;
  return (
    <div className="wl-faucet">
      <div className="spread">
        <span className="meta">
          {loading ? "Loading your Account…" : <>Your simSOL <b className="tnum">{market ? fmtSol(market.simSol, 3) : "—"}</b></>}
        </span>
        <Chip tone="warn">Simulated</Chip>
      </div>
      <Button size="sm" block disabled={!signer || a.busy !== null} onClick={() => signer && a.run("faucet", () => getTestSimSol(signer, auth.getAccessToken, setStep))}>
        {a.busy === "faucet" ? `${step}…` : "Get test simSOL"}
      </Button>
      {a.done && <Sig label="faucet" sig={a.done.sig} />}
      {a.error && <p className="status err" role="alert">{a.error}</p>}
    </div>
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
  const quote = market && priceOk ? quoteNativeAdvance(principal, market.pool.apyBps, months, market.price!.microUsd) : null;
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
      unit="SOL"
      inert={!market}
      head={<NativeFaucet market={market} loading={loading} />}
      amountText={text}
      onAmount={setText}
      amountInvalid={tooMuch}
      amountHint={market ? <>You have {balance.toLocaleString("en-US", { maximumFractionDigits: 3 })} simSOL. Principal is locked, never played with.</> : undefined}
      months={months}
      onMonths={setMonths}
      gemas={gemas}
      estimate={estimate ? `${fmtWhen(estimate)} (${fmtInMinutes(estimate, now)})` : "—"}
      details={[
        ["Worth at issuance", fmtUsd(gemasToUsd(gemas))],
        ["Principal", `${fmtSol(principal)} SOL`],
        ["Projected yield", `${quote ? fmtSol(quote.projectedUnits) : "—"} SOL`],
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
      note={
        <>
          One transaction opens the Position and takes the Advance. The Unlock Estimate is an estimate, not a promise: it moves with the
          pool&apos;s actual yield. <span className="sim">Simulated yield · 1 month = {SIM_MONTH_MIN} min</span>
        </>
      }
      buttonLabel={a.busy ? `${step}…` : gemas > 0 ? `Open a Position · ${fmtGemas(gemas)} Gemas` : "Open a Position"}
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

  const src = info.source?.math ?? null;
  const onChainDebt = src ? live(src) - covered(src) : 0n;
  const debtSol = src && onChainDebt > 0n ? (onChainDebt * src.unitNum + src.unitDen - 1n) / src.unitDen : 0n;
  const pool = market?.pool ?? null;
  const clock = yieldClockOf(info);
  const projected = pool ? projectedDebtGemas(src, info.vaultShares, info.redeemedUnits, info.principalLamports, pool, now, clock) : onChainDebt;
  const liveYield = pool ? accruedAt({ vaultShares: info.vaultShares, redeemedUnits: info.redeemedUnits, principalLamports: info.principalLamports, pool, clock, nowMs: now }) : info.cumulativeYield;
  const accruedYield = liveYield > info.cumulativeYield ? liveYield : info.cumulativeYield;
  const unapplied = onChainDebt - projected;
  const estimate =
    pool && src && onChainDebt > 0n
      ? unlockEstimateMs({ source: src, vaultShares: info.vaultShares, redeemedUnits: info.redeemedUnits, principalLamports: info.principalLamports, pool, clock: clock ?? { rateBps: info.rateBps, lastAccrualTs: Math.floor(now / 1000) }, nowMs: now })
      : null;
  const locked = info.status === "locked";
  const canUnlock = locked && projected === 0n;
  // Unknown until the pool is read: keep the action rather than hide a real surplus.
  const surplus = pool ? surplusShares(info, rateAt(pool)) : null;
  const redeemable = (snapshot?.holdings ?? []).some((h) => h.native && h.position.equals(position.address) && h.redeemable > 0n);
  const series =
    pool && src && locked && onChainDebt > 0n
      ? sampledSeries((at) => Number(projectedDebtGemas(src, info.vaultShares, info.redeemedUnits, info.principalLamports, pool, at, clock)), now, estimate ? estimate - now : 10 * 60_000)
      : null;

  return (
    <PositionTile
      chain="SOL"
      label="SOL Position"
      state={!locked ? "unlocked" : !src ? "idle" : onChainDebt === 0n ? "paid" : "repaying"}
      principal={`${fmtSol(info.principalLamports, 3)} SOL`}
      debt={!src ? null : onChainDebt > 0n ? `${fmtGemas(Number(onChainDebt))} Gemas` : "0"}
      debtAsset={onChainDebt > 0n ? `${fmtSol(debtSol, 3)} SOL` : undefined}
      apy={`${(info.rateBps / 100).toFixed(1)}%`}
      unlockAt={estimate}
      now={now}
      series={series}
      notes={
        <>
          <p className="note">Accrued yield {fmtSol(accruedYield, 5)} SOL (simulated).</p>
          {unapplied > 0n && locked && (
            <p className="note">
              <ClockIcon width={12} height={12} /> ~{fmtGemas(Number(unapplied))} Gemas of Debt are already repaid by yield and get applied on the next refresh (it happens automatically every ~20 s).
            </p>
          )}
          {locked && !canUnlock && <p className="note">Unlock returns the Principal once Debt is zero. Only this Position&apos;s own yield repays it.</p>}
        </>
      }
    >
      {locked && (
        <>
          <Button size="sm" block disabled={!signer || a.busy !== null} onClick={() => signer && a.run("refresh", () => refreshYield(signer, info))}>
            {a.busy === "refresh" ? "Refreshing…" : "Refresh yield"}
          </Button>
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
  const [sigs, setSigs] = useState<string[]>([]);
  const rows = nativeRedeemables(snapshot?.holdings ?? []);
  const ethRows = ethRedeemables(snapshot?.holdings ?? []);
  const ethCtx = useEthCtx();
  const pool = snapshot?.market?.pool ?? null;
  const infoOf = (h: ChainHolding) => snapshot?.positions.find((p) => p.address.equals(h.position))?.native ?? null;
  const payout = (h: ChainHolding) => {
    const src = infoOf(h)?.source;
    if (!pool || !src || !src.key.equals(h.source)) return null;
    return redeemPayoutShares(src.math, h.redeemable, rateAt(pool));
  };
  const total = [...rows, ...ethRows].reduce((s, h) => s + Number(h.redeemable), 0);

  const redeem = async () => {
    if (!auth.signer) return;
    setBusy(true);
    setError(null);
    try {
      for (const h of rows) {
        const sig = await redeemNative(auth.signer, h.position, h.source, h.redeemable);
        setSigs((s) => [...s, sig]);
      }
      if (ethRows.length > 0) {
        if (!ethCtx) throw new Error("Your ETH wallet is not ready yet. Try again in a moment.");
        await redeemEthHoldings(ethCtx, snapshot?.holdings ?? []);
        if (rows.length === 0) onClose();
      }
      await refresh();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="meta">
        Each Gema redeems for its Source asset, only as far as that Source Position&apos;s yield has actually accrued.
        Winning Gemas never shorten your own lock. Paid in simSOL (Simulated) to your wallet, simETH (Simulated) on Hoodi for ETH Positions, or simHYPE (Simulated) on HyperEVM for HYPE Positions.
      </p>
      <dl className="kv">
        {rows.map((h) => {
          const p = payout(h);
          return (
            <div key={h.holding.toBase58()} style={{ display: "contents" }}>
              <dt>{h.isOwn ? "Your Position" : `Won · ${h.sourceOwner.slice(0, 4)}…${h.sourceOwner.slice(-4)}`}</dt>
              <dd>
                {fmtGemas(Number(h.redeemable))} → {p !== null ? `${fmtSol(p, 5)} simSOL` : "simSOL"}
              </dd>
            </div>
          );
        })}
        {ethRows.map((h) => (
          <div key={h.holding.toBase58()} style={{ display: "contents" }}>
            <dt>{h.isOwn ? `Your ${h.asset} Position` : `Won · ${h.sourceOwner.slice(0, 4)}…${h.sourceOwner.slice(-4)}`}</dt>
            <dd>{fmtGemas(Number(h.redeemable))} → {h.asset === "HYPE" ? "simHYPE on HyperEVM" : "simETH on Hoodi"}</dd>
          </div>
        ))}
      </dl>
      {rows.length + ethRows.length > 0 && <SimulatedYieldLabel />}
      {ethRows.length > 0 && <p className="meta">ETH- and HYPE-Sourced Gemas pay out on their own chain: the simETH (Hoodi) or simHYPE (HyperEVM) arrives a few minutes later, with progress shown on the Wallet.</p>}
      {rows.length + ethRows.length === 0 && sigs.length === 0 && <p className="meta">Nothing is redeemable yet. Yield accrues on the Source Position over time.</p>}
      {sigs.length > 0 && (
        <div className="status ok" role="status">
          <CheckIcon /> Redeemed {sigs.length} {sigs.length === 1 ? "Source" : "Sources"} into simSOL
        </div>
      )}
      {sigs.map((s) => <Sig key={s} label="redeem" sig={s} />)}
      {error && <p className="status err" role="alert">{error}</p>}
      {rows.length + ethRows.length > 0 ? (
        <Button variant="money" block disabled={busy || !auth.signer} onClick={redeem}>
          {busy ? "Redeeming…" : `Redeem ${fmtGemas(total)}`}
        </Button>
      ) : (
        <Button block onClick={onClose}>Close</Button>
      )}
    </>
  );
}
