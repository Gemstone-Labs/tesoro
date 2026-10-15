"use client";

import { useEffect, useRef, useState } from "react";
import { Button, CheckIcon, GemaAmount, Sheet } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { DEFAULT_HORIZON_MONTHS, EXTEND_ADVANCE_ENABLED } from "@/lib/advance";
import { fmtGemas, fmtInMinutes, fmtUsd, fmtWhen, gemasToUsd } from "@/lib/format";
import { ratesOf } from "@/lib/chain/fees";
import { gemasInAsset } from "@/lib/chain/ledger";
import {
  LAMPORTS,
  MAX_PRICE_AGE_SECS,
  SIM_MONTH_MIN,
  clockOf,
  debtGemasAt,
  nativeNow,
  quoteExtendAdvance,
  quoteNativeAdvance,
  rateAt,
  redeemPayoutShares,
  sharesValue,
  speedupOf,
  unlockEstimateMs,
  type NativeInfo,
  type NativeMarket,
} from "@/lib/chain/native";
import { advanceUnits, netApyPct } from "@/lib/chain/yield";
import { extendAdvance, friendlyError, setExtendLimit, getTestSimSol, instantRedeemNative, openPositionWithAdvance, redeemNative, takeNextAdvance, unlockNative } from "@/lib/chain/native-flow";
import { runInstant } from "@/lib/chain/instant-run";
import { MAX_ADVANCE_MONTHS, blockedLabel, extendLimitView, fetchExtendLimit, type ExtendLimitData } from "@/lib/chain/extend-limit";
import { getChain } from "@/lib/chain/client";
import type { ChainHolding, ChainPosition } from "@/lib/chain/read";
import { ethRedeemables, instantRedeemEthSource, redeemEthHoldings, useEthCtx } from "./EthPositions";
import { useInstantRedeem } from "./instant";
import { RedeemExchange, ReturnOwnSheet, useReturnable, type RedeemDone, type RedeemPayout } from "./MoneySheets";
import { GemasLabel } from "./AdvanceQuote";
import { AdvanceFormView, AdvanceTakenNote } from "./AdvanceSheet";
import { OpenFormView } from "./OpenPanel";
import { ExtendLimitPanel } from "./ExtendLimit";
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
  unlock: "Principal unlocked",
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
function useAction(refresh: () => Promise<unknown>) {
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
  const [months, setMonths] = useState(DEFAULT_HORIZON_MONTHS);
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
  // A fresh Position's Debt is the whole Advance: the Estimate is when its Accrued Yield covers it.
  const estimate = market && quote && shares > 0n && gemas > 0
    ? unlockEstimateMs({
        clock: { principal, rateBps: market.pool.apyBps, yieldFeeBps, openedAt: Math.floor(now / 1000) },
        speedup: speedupOf(market.pool),
        appliedNet: 0n,
        source: { issued: quote.gemas, returned: 0n, redeemed: 0n, yieldUnits: 0n, unitNum: 10n ** 13n, unitDen: market.price!.microUsd },
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

export function NativePositionCard({ position, market, onRedeem, extend = EXTEND_ADVANCE_ENABLED }: { position: ChainPosition; market: NativeMarket | null; onRedeem: () => void; extend?: boolean }) {
  const info = position.native as NativeInfo;
  const { auth, snapshot, refresh } = useAccount();
  const a = useAction(refresh);
  const now = useNow(5000);
  const signer = auth.signer;
  const returnable = useReturnable(position);
  const [returning, setReturning] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [extending, setExtending] = useState(false);

  const yieldFeeBps = info.yieldFeeBps;
  const speedup = speedupOf(market?.pool);
  // Debt, redeemable and free yield are derived from the clock, as the program computes them (nothing is cranked).
  const cur = nativeNow(info, speedup, Math.floor(now / 1000));
  const src = cur.source;
  const debt = cur.debtGemas;
  const debtSol = src && debt > 0n ? (debt * src.unitNum + src.unitDen - 1n) / src.unitDen : 0n;
  const estimate = src && debt > 0n ? unlockEstimateMs({ clock: clockOf(info), speedup, appliedNet: info.appliedNet, source: src, nowMs: now }) : null;
  const locked = info.status === "locked";
  const canUnlock = locked && debt === 0n;
  const canExtend = extend && locked && !!src && info.openAdvance === info.source?.index && debt > 0n && info.source.horizonMonths < MAX_ADVANCE_MONTHS;
  const redeemable = (snapshot?.holdings ?? []).some((h) => h.native && h.position.equals(position.address) && h.redeemable > 0n);
  const series = src && locked && debt > 0n ? sampledSeries((at) => Number(debtGemasAt(info, speedup, at)), now, estimate ? estimate - now : 10 * 60_000) : null;

  return (
    <PositionTile
      chain="SOL"
      label="SOL Position"
      state={!locked ? "unlocked" : !src ? "idle" : debt === 0n ? "paid" : "repaying"}
      principal={`${fmtSol(info.principalLamports, 3)} SOL`}
      debt={!src ? null : debt > 0n ? `${fmtGemas(Number(debt))} Gemas` : "0"}
      debtAsset={debt > 0n ? `${fmtSol(debtSol, 3)} SOL` : undefined}
      apy={`${netApyPct(info.rateBps, yieldFeeBps).toFixed(1)}%`}
      yieldFeeBps={yieldFeeBps}
      unlockAt={estimate}
      now={now}
      series={series}
      notes={
        <>
          <p className="note">Accrued yield {fmtSol(cur.accrued, 5)} SOL (simulated). Tesoro keeps {yieldFeeBps / 100}% of the yield (the Yield Fee), so this is your {100 - yieldFeeBps / 100}%.</p>
          {locked && !canUnlock && <p className="note">Unlock returns the Principal once Debt is zero. Only this Position&apos;s own yield repays it.</p>}
          {canUnlock && <p className="note">Debt is zero: Unlock to get your SOL back, or take another Advance on the same Principal.</p>}
        </>
      }
    >
      {locked && (
        <>
          {canUnlock && (
            <Button variant="money" size="sm" block disabled={!signer || a.busy !== null} onClick={() => setAdvancing(true)}>Take another Advance</Button>
          )}
          {canExtend && (
            <Button variant="money" size="sm" block disabled={!signer || a.busy !== null} onClick={() => setExtending(true)}>Extend</Button>
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
          {canExtend && <NativeExtendSheet info={info} market={market} open={extending} onClose={() => setExtending(false)} />}
        </>
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
  const [months, setMonths] = useState(DEFAULT_HORIZON_MONTHS);
  const [step, setStep] = useState("Preparing");
  const now = useNow(5000);
  const priceAge = market?.price ? now / 1000 - market.price.updatedTs : Infinity;
  const priceOk = !!market?.price && priceAge <= MAX_PRICE_AGE_SECS - 60;
  const yieldFeeBps = info.yieldFeeBps;
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

// ---- Extend an Advance ------------------------------------------------------------------------------

/** Commit more of a Position's future yield on its open Advance: Gemas now, more Debt, a later Unlock Estimate. */
export function NativeExtendSheet({ info, market, open, onClose, limit }: { info: NativeInfo; market: NativeMarket | null; open: boolean; onClose: () => void; limit?: ExtendLimitData | null | "unknown" }) {
  return (
    <Sheet open={open} onClose={onClose} title="Extend your Advance" className="adv-sheet">
      {open && <NativeExtendForm info={info} market={market} onClose={onClose} limit={limit} />}
    </Sheet>
  );
}

/** The owner's Extend Limit, read on open and again after they change it. `given` (stories) skips the read. */
function useExtendLimit(given: ExtendLimitData | null | "unknown" | undefined) {
  const { auth } = useAccount();
  const owner = auth.signer?.publicKey;
  const [read, setRead] = useState<ExtendLimitData | null | "unknown" | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const key = owner?.toBase58();
  useEffect(() => {
    if (given !== undefined || !owner) return;
    let live = true;
    void fetchExtendLimit(getChain().base, owner)
      .catch((): "unknown" => "unknown")
      .then((l) => live && setRead(l));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, given, tick]);
  return { limit: given !== undefined ? given : read, reload: () => {
      setRead(undefined);
      setTick((t) => t + 1);
    }, loading: given === undefined && read === undefined };
}

function NativeExtendForm({ info, market, onClose, limit: given }: { info: NativeInfo; market: NativeMarket | null; onClose: () => void; limit?: ExtendLimitData | null | "unknown" }) {
  const { auth, refresh } = useAccount();
  const a = useAction(refresh);
  const source = info.source!;
  const [step, setStep] = useState("Preparing");
  const now = useNow(5000);
  const lim = useExtendLimit(given);
  const setLimit = useAction(refresh);
  const view = extendLimitView(lim.limit ?? null, Math.floor(now / 1000), source.horizonMonths);
  const [picked, setMonths] = useState(Math.min(DEFAULT_HORIZON_MONTHS, MAX_ADVANCE_MONTHS - source.horizonMonths));
  const months = Math.max(1, Math.min(picked, view.maxMonths));
  const pool = market?.pool ?? null;
  const yieldFeeBps = info.yieldFeeBps;
  const quote = quoteExtendAdvance(info.principalLamports, info.rateBps, source.math, source.horizonMonths, months, yieldFeeBps);
  const gemas = Number(quote.gemas);
  const addedYield = advanceUnits(info.principalLamports, info.rateBps, source.horizonMonths + months, yieldFeeBps) - advanceUnits(info.principalLamports, info.rateBps, source.horizonMonths, yieldFeeBps);
  const unlock = gemas > 0 ? unlockEstimateMs({ clock: clockOf(info), speedup: speedupOf(pool), appliedNet: info.appliedNet, source: quote.extended, nowMs: now }) : null;
  const title = `${fmtSol(info.principalLamports, 3)} SOL Position`;

  if (a.done) {
    return (
      <div className="adv">
        <AdvanceTakenNote gemas={gemas} from={title} unlock={unlock ? fmtWhen(unlock) : "—"} />
        <Sig label="extend" sig={a.done.sig} />
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
      maxMonths={Math.max(1, view.maxMonths)}
      sliderLabel="Extend by"
      yieldText={`${fmtSol(addedYield)} SOL`}
      yieldFeeBps={yieldFeeBps}
      gemas={gemas}
      unlock={unlock ? `${fmtWhen(unlock)} (${fmtInMinutes(unlock, now)})` : "—"}
      alerts={
        <>
          <p className="note">Adds {fmtGemas(gemas)} Gemas of Debt to this Advance. Your Principal stays locked for {source.horizonMonths + months} months in all.</p>
          <ExtendLimitPanel
            view={view}
            busy={setLimit.busy !== null}
            error={setLimit.error}
            onRetry={lim.reload}
            onSet={(m) => auth.signer && setLimit.run("limit", () => setExtendLimit(auth.signer!, auth.getAccessToken, m)).then(lim.reload)}
          />
          {a.error && <p className="status err" role="alert">{a.error}</p>}
        </>
      }
      buttonLabel={a.busy ? `${step}…` : view.blocked ? blockedLabel(view.blocked) : <GemasLabel action="Extend" gemas={gemas} />}
      dimmed={view.blocked !== null}
      disabled={gemas <= 0 || a.busy !== null || !auth.signer || view.blocked !== null || lim.loading}
      onSubmit={() => auth.signer && a.run("extend", () => extendAdvance(auth.signer!, auth.getAccessToken, info, months, setStep))}
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

  const { offer: instant, plan, freshPlan } = useInstantRedeem();

  const redeemNow = async () => {
    if (!auth.signer) return;
    setBusy(true);
    setError(null);
    try {
      const signer = auth.signer;
      let latest = plan;
      const run = await runInstant(
        plan.map((p) => p.line),
        async () => {
          latest = await freshPlan(signer.publicKey);
          return latest.map((p) => p.line);
        },
        async (line) => {
          const h = (latest.find((p) => p.line.key === line.key) ?? plan.find((p) => p.line.key === line.key))!.holding;
          if (h.native) sigs.current.push(await instantRedeemNative(signer, h.position, h.source, line.gemas, h.redeemable));
          else {
            if (!ethCtx) throw new Error("Your ETH wallet is not ready yet. Try again in a moment.");
            await instantRedeemEthSource(ethCtx, h.eth!, h.source, line.gemas);
          }
        },
      );
      if (run.kind !== "sent") {
        const part = run.sent.length > 0 ? "Part of it went through. " : "";
        setError(
          run.kind === "none"
            ? `${part}Yield landed while you were confirming, so none of the rest can be redeemed now. Redeem them at full value instead.`
            : `${part}Yield landed while you were confirming. Redeem now would sell ${fmtGemas(Number(run.gemas))} Gemas instead. Press Redeem now again to confirm the refreshed amounts.`,
        );
        await refresh();
        return;
      }
      const lines = run.sent.map((line) => ({ line, holding: (latest.find((p) => p.line.key === line.key) ?? plan.find((p) => p.line.key === line.key))!.holding }));
      setDone({ gemas: lines.reduce((s, p) => s + Number(p.line.gemas), 0), later: lines.some((p) => !p.holding.native), instant: true, receipts: sigs.current.map((sig) => ({ label: "Redeemed now", sig })) });
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
