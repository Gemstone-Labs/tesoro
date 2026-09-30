"use client";

import { useEffect, useState } from "react";
import { Button, CheckIcon, Card, Chip, ClockIcon, GemaAmount, Label, Sheet, SimulatedYieldLabel, Slider } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { fmtGemas, fmtUsd, fmtWhen, gemasToUsd } from "@/lib/format";
import { covered, live } from "@/lib/chain/ledger";
import {
  LAMPORTS,
  MAX_PRICE_AGE_SECS,
  SIM_MONTH_MIN,
  projectedDebtGemas,
  quoteNativeAdvance,
  rateAt,
  redeemPayoutShares,
  sharesValue,
  unlockEstimateMs,
  type NativeInfo,
  type NativeMarket,
} from "@/lib/chain/native";
import { friendlyError, getTestSimSol, openPositionWithAdvance, redeemNative, refreshYield, sweepNative, unlockNative } from "@/lib/chain/native-flow";
import type { ChainHolding, ChainPosition } from "@/lib/chain/read";
import { ethRedeemables, redeemEthHoldings, useEthCtx } from "./EthPositions";

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

function inMinutes(targetMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((targetMs - nowMs) / 1000));
  if (s < 45) return "any moment now";
  const m = Math.round(s / 60);
  return `in ~${m} min`;
}

function Sig({ label, sig }: { label: string; sig: string }) {
  return (
    <a className="meta mono" href={explorer(sig)} target="_blank" rel="noreferrer">
      {label} · {sig.slice(0, 10)}…
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

export function NativeGetGemas({ market, loading, onOpen }: { market: NativeMarket | null; loading: boolean; onOpen: () => void }) {
  const { auth, refresh } = useAccount();
  const a = useAction(refresh);
  const signer = auth.signer;
  return (
    <Card large>
      <div className="stack">
        <Label>Get Gemas</Label>
        <p className="meta">
          {loading
            ? "Reading your Account from Solana devnet…"
            : "Lock simSOL in a Position and take an Advance of its projected yield as Gemas to play with."}
        </p>
        <dl className="kv">
          <dt>Your simSOL</dt>
          <dd className="tnum">{market ? fmtSol(market.simSol, 3) : "—"} simSOL</dd>
        </dl>
        <div className="hstack wrap">
          <Button block disabled={!signer || a.busy !== null} onClick={() => signer && a.run("faucet", () => getTestSimSol(signer, auth.getAccessToken))}>
            {a.busy === "faucet" ? "Getting simSOL…" : "Get test simSOL"}
          </Button>
          <Chip tone="warn">Simulated</Chip>
        </div>
        <Button variant="money" block disabled={!signer || !market || market.simSol === 0n} onClick={() => auth.gate("open a Position", onOpen)}>
          Open a Position
        </Button>
        {a.done && <Sig label="simSOL faucet" sig={a.done.sig} />}
        {a.error && <p className="status err" role="alert">{a.error}</p>}
        <span className="sim">Simulated · simSOL is a test token from the sim_lst pool, its yield runs 1 month = {SIM_MONTH_MIN} min</span>
      </div>
    </Card>
  );
}

export function OpenPositionSheet({ open, onClose, market }: { open: boolean; onClose: () => void; market: NativeMarket | null }) {
  return (
    <Sheet open={open} onClose={onClose} title="Open a Position">
      {open && market && <OpenForm market={market} onClose={onClose} />}
    </Sheet>
  );
}

function OpenForm({ market, onClose }: { market: NativeMarket; onClose: () => void }) {
  const { auth, refresh } = useAccount();
  const a = useAction(refresh);
  const balance = Number(market.simSol) / LAMPORTS;
  const [text, setText] = useState(() => String(Math.max(0.1, Math.min(balance, 1))));
  const [months, setMonths] = useState(3);
  const now = useNow(5000);

  const amount = Number(text);
  const shares = Number.isFinite(amount) && amount > 0 ? BigInt(Math.round(amount * LAMPORTS)) : 0n;
  const rate = rateAt(market.pool, now / 1000);
  const principal = sharesValue(shares, rate);
  const priceAge = market.price ? now / 1000 - market.price.updatedTs : Infinity;
  const priceOk = !!market.price && priceAge <= MAX_PRICE_AGE_SECS - 60;
  const quote = priceOk ? quoteNativeAdvance(principal, market.pool.apyBps, months, market.price!.microUsd) : null;
  const gemas = quote ? Number(quote.gemas) : 0;
  // A fresh Position's Debt is the whole Advance: the Estimate is when the vault's yield covers it.
  const estimate = quote && shares > 0n && gemas > 0
    ? unlockEstimateMs({
        source: { issued: quote.gemas, returned: 0n, redeemed: 0n, yieldUnits: 0n, unitNum: 10n ** 13n, unitDen: market.price!.microUsd },
        vaultShares: shares,
        redeemedUnits: 0n,
        principalLamports: principal,
        pool: market.pool,
        nowMs: now,
      })
    : null;
  const tooMuch = shares > market.simSol;
  const valid = shares > 0n && !tooMuch && gemas > 0;

  if (a.done) {
    return (
      <>
        <div className="status ok" role="status">
          <CheckIcon /> Position opened · <GemaAmount value={gemas} size="md" /> issued
        </div>
        <Sig label="open_native_position + take_native_advance" sig={a.done.sig} />
        <Button block onClick={onClose}>Done</Button>
      </>
    );
  }

  return (
    <>
      <Chip tone="warn">Simulated yield · 1 month = {SIM_MONTH_MIN} min</Chip>
      <div className="field">
        <label className="label" htmlFor="simsol-amount">simSOL to lock as Principal</label>
        <input
          id="simsol-amount"
          className="cut input tnum"
          inputMode="decimal"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-invalid={tooMuch}
        />
        <span className="meta">You have {balance.toLocaleString("en-US", { maximumFractionDigits: 3 })} simSOL. Principal is locked, never played with.</span>
      </div>
      <Slider
        label="Horizon"
        value={months}
        min={1}
        max={12}
        onChange={setMonths}
        display={`${months} ${months === 1 ? "month" : "months"}`}
        minLabel="1 month"
        maxLabel="12 months"
      />
      <dl className="kv">
        <dt>Gemas issued</dt>
        <dd><GemaAmount value={gemas} size="lg" /></dd>
        <dt>Worth at issuance</dt>
        <dd>{fmtUsd(gemasToUsd(gemas))}</dd>
        <dt>Principal</dt>
        <dd className="tnum">{fmtSol(principal)} SOL</dd>
        <dt>Projected yield</dt>
        <dd className="tnum">{quote ? fmtSol(quote.projectedUnits) : "—"} SOL</dd>
        <dt>Unlock Estimate</dt>
        <dd>{estimate ? `${fmtWhen(new Date(estimate).toISOString())} (${inMinutes(estimate, now)})` : "—"}</dd>
      </dl>
      <p className="meta mono">
        {market.price
          ? `Devnet price feed · SOL $${(Number(market.price.microUsd) / 1e6).toFixed(2)} · updated ${Math.max(0, Math.round(priceAge / 60))} min ago`
          : "Devnet price feed · not published yet"}
      </p>
      {!priceOk && <p className="status err" role="alert">The devnet price feed is stale or missing. The keeper refreshes it hourly; try again shortly.</p>}
      {tooMuch && <p className="status err" role="alert">That is more simSOL than you have.</p>}
      <p className="note">
        One transaction opens the Position and takes the Advance. The Unlock Estimate is an estimate, not a promise: it
        moves with the pool&apos;s actual yield.
      </p>
      {a.error && <p className="status err" role="alert">{a.error}</p>}
      <Button
        variant="money"
        block
        disabled={!valid || !priceOk || a.busy !== null || !auth.signer}
        onClick={() => auth.signer && a.run("open", async () => (await openPositionWithAdvance(auth.signer!, auth.getAccessToken, shares, months)).signature)}
      >
        {a.busy ? "Signing…" : `Open Position · ${fmtGemas(gemas)} Gemas`}
      </Button>
    </>
  );
}

// ---- Position card ------------------------------------------------------------------------------

export function NativePositionCard({ position, market }: { position: ChainPosition; market: NativeMarket | null }) {
  const info = position.native as NativeInfo;
  const { auth, refresh } = useAccount();
  const a = useAction(refresh);
  const now = useNow(5000);
  const signer = auth.signer;

  const src = info.source?.math ?? null;
  const onChainDebt = src ? live(src) - covered(src) : 0n;
  const debtSol = src && onChainDebt > 0n ? (onChainDebt * src.unitNum + src.unitDen - 1n) / src.unitDen : 0n;
  const pool = market?.pool ?? null;
  const projected = pool ? projectedDebtGemas(src, info.vaultShares, info.redeemedUnits, info.principalLamports, pool, now) : onChainDebt;
  const liveYield = pool ? sharesValue(info.vaultShares, rateAt(pool, now / 1000)) + info.redeemedUnits - info.principalLamports : info.cumulativeYield;
  const accruedYield = liveYield > info.cumulativeYield ? liveYield : info.cumulativeYield;
  const unapplied = onChainDebt - projected;
  const estimate =
    pool && src && onChainDebt > 0n
      ? unlockEstimateMs({ source: src, vaultShares: info.vaultShares, redeemedUnits: info.redeemedUnits, principalLamports: info.principalLamports, pool, nowMs: now })
      : null;
  const locked = info.status === "locked";
  const canUnlock = locked && projected === 0n;

  return (
    <Card large as="article" aria-label="SOL Position">
      <div className="stack">
        <div className="spread">
          <span className="hstack">
            <Chip tone="neutral">SOL · simSOL</Chip>
            <strong>{fmtSol(info.principalLamports, 3)} SOL Position</strong>
          </span>
          <span className="meta tnum">{(info.rateBps / 100).toFixed(1)}% APY</span>
        </div>
        <dl className="kv">
          <dt>Principal</dt>
          <dd className="tnum">{fmtSol(info.principalLamports)} SOL · {locked ? "locked" : "returned"}</dd>
          <dt>Debt</dt>
          <dd className="tnum">
            {fmtGemas(Number(onChainDebt))} Gemas{onChainDebt > 0n ? ` · ${fmtSol(debtSol)} SOL` : ""}
          </dd>
          <dt>Accrued yield</dt>
          <dd className="tnum">{fmtSol(accruedYield, 5)} SOL</dd>
          <dt>Unlock Estimate</dt>
          <dd>
            {!locked
              ? "Unlocked"
              : !src
                ? "No open Advance"
                : onChainDebt === 0n
                  ? "Debt is zero"
                  : estimate
                    ? `${fmtWhen(new Date(estimate).toISOString())} (${inMinutes(estimate, now)})`
                    : "Once yield accrues"}
          </dd>
        </dl>
        {unapplied > 0n && locked && (
          <p className="meta">
            <ClockIcon width={14} height={14} /> ~{fmtGemas(Number(unapplied))} Gemas of Debt are already repaid by yield and get applied on the next refresh
            (the keeper does it every ~20 s, or press Refresh yield).
          </p>
        )}
        <SimulatedYieldLabel />
        {locked && (
          <div className="hstack wrap">
            <Button size="sm" disabled={!signer || a.busy !== null} onClick={() => signer && a.run("refresh", () => refreshYield(signer, info))}>
              {a.busy === "refresh" ? "Refreshing…" : "Refresh yield"}
            </Button>
            <Button size="sm" disabled={!signer || a.busy !== null || !canUnlock} onClick={() => signer && a.run("unlock", () => unlockNative(signer, info))}>
              {a.busy === "unlock" ? "Unlocking…" : "Unlock"}
            </Button>
          </div>
        )}
        {locked && !canUnlock && <p className="note">Unlock returns the Principal once Debt is zero. Only this Position&apos;s own yield repays it.</p>}
        {!locked && (
          <Button size="sm" disabled={!signer || a.busy !== null} onClick={() => signer && a.run("sweep", () => sweepNative(signer, info))}>
            {a.busy === "sweep" ? "Sweeping…" : "Sweep surplus"}
          </Button>
        )}
        {a.done && <Sig label={a.done.label} sig={a.done.sig} />}
        {a.error && <p className="status err" role="alert">{a.error}</p>}
      </div>
    </Card>
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
  const now = useNow(5000);
  const rows = nativeRedeemables(snapshot?.holdings ?? []);
  const ethRows = ethRedeemables(snapshot?.holdings ?? []);
  const ethCtx = useEthCtx();
  const pool = snapshot?.market?.pool ?? null;
  const infoOf = (h: ChainHolding) => snapshot?.positions.find((p) => p.address.equals(h.position))?.native ?? null;
  const payout = (h: ChainHolding) => {
    const src = infoOf(h)?.source;
    if (!pool || !src || !src.key.equals(h.source)) return null;
    return redeemPayoutShares(src.math, h.redeemable, rateAt(pool, now / 1000));
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
      if (ethRows.length > 0 && ethCtx) {
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
        Winning Gemas never shorten your own lock. Paid in simSOL (Simulated) to your wallet.
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
            <dt>{h.isOwn ? "Your ETH Position" : `Won · ${h.sourceOwner.slice(0, 4)}…${h.sourceOwner.slice(-4)}`}</dt>
            <dd>{fmtGemas(Number(h.redeemable))} → simETH on Hoodi</dd>
          </div>
        ))}
      </dl>
      {ethRows.length > 0 && <p className="meta">ETH-Sourced Gemas redeem through the bridge: the simETH arrives on Hoodi a few minutes later, with progress shown on the Wallet.</p>}
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
