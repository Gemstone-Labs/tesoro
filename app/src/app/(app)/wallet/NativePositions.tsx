"use client";

import { useEffect, useRef, useState } from "react";
import { Button, CheckIcon, GemaAmount, Sheet } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { DEFAULT_HORIZON_MONTHS, EXTEND_ADVANCE_ENABLED } from "@/lib/advance";
import { CLUSTER } from "@/lib/cluster-settings";
import { fmtGemas, fmtInMinutes, fmtUsd, fmtWhen, gemasToUsd } from "@/lib/format";
import { gameQuery } from "@/lib/game-params";
import { GAME_NAMES } from "@/lib/mock";
import { ratesOf } from "@/lib/chain/fees";
import { gemasInAsset } from "@/lib/chain/ledger";
import {
  LAMPORTS,
  MAX_PRICE_AGE_SECS,
  PRICE_QUOTE_MARGIN_SECS,
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
  stakeGrowthOf,
  unlockEstimateMs,
  type NativeInfo,
  type NativeMarket,
} from "@/lib/chain/native";
import { advanceUnits, netApyPct } from "@/lib/chain/yield";
import { cancelInstantRedeem, requestInstantRedeem } from "@/lib/chain/instant-order";
import { extendAdvance, friendlyError, setExtendLimit, getTestSimSol, openPositionWithAdvance, openStakePositionWithAdvance, redeemNative, takeNextAdvance, unlockNative } from "@/lib/chain/native-flow";
import { quoteDepositSol } from "@/lib/chain/stake-pool";
import { tokenSymbol } from "@/lib/chain/stake-pool";
import { tokensForUnits, unitsForTokens } from "@/lib/chain/stake";
import { MAX_ADVANCE_MONTHS, blockedLabel, extendLimitView, fetchExtendLimit, type ExtendLimitData } from "@/lib/chain/extend-limit";
import { getChain } from "@/lib/chain/client";
import type { Chain } from "@/lib/mock";
import type { ChainHolding, ChainPosition } from "@/lib/chain/read";
import { NOTHING_REDEEMABLE_YET, ethRedeemables, ethYieldWaiting, redeemEthHoldings, useEthCtx } from "./EthPositions";
import { useInstantRedeem } from "./instant";
import { RedeemExchange, ReturnOwnSheet, useReturnable, type RedeemDone, type RedeemPayout } from "./MoneySheets";
import { GemasLabel } from "./AdvanceQuote";
import { AdvanceFormView, AdvanceTakenNote } from "./AdvanceSheet";
import { OpenFormView, useOpenIntent } from "./OpenPanel";
import { ExtendLimitPanel } from "./ExtendLimit";
import { PositionTile, sampledSeries } from "./PositionTile";
import { BRAND } from "@/lib/brand";

const fmtSol = (lamports: bigint | number, digits = 4) => (Number(lamports) / LAMPORTS).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}${CLUSTER.yieldModel === "real" ? "" : "?cluster=devnet"}`;

function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}


const DONE: Record<string, string> = {
  faucet: "Got test SOL",
  open: "Lock started",
  advance: "Advance taken",
  unlock: "Coins unlocked",
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
export function NativeFaucet({ market, loading, asButton = false }: { market: NativeMarket | null; loading: boolean; asButton?: boolean }) {
  const { auth, refresh } = useAccount();
  const a = useAction(refresh);
  const [step, setStep] = useState("Getting test SOL");
  const signer = auth.signer;
  if (market?.stake) {
    return (
      <span>
        You have <b className="tnum">{fmtSol(market.stake.tokenBalance, 3)}</b> {market.stake.token.symbol}
      </span>
    );
  }
  const get = () => signer && a.run("faucet", () => getTestSimSol(signer, auth.getAccessToken, setStep));
  if (asButton) {
    return (
      <div className="wl-faucet">
        <Button block disabled={!signer || a.busy !== null} onClick={get}>
          {a.busy === "faucet" ? `${step}…` : "Get test SOL"}
        </Button>
        {a.done && <Sig label="faucet" sig={a.done.sig} />}
        {a.error && <p className="status err" role="alert">{a.error}</p>}
      </div>
    );
  }
  const empty = !!market && market.simSol === 0n;
  return (
    <>
      <span>
        {loading ? "Loading your Account…" : <>You have <b className="tnum">{market ? fmtSol(market.simSol, 3) : "—"}</b> test SOL</>}
        {!empty && (
          <>
            {" · "}
            <button type="button" className="wl-link" disabled={!signer || a.busy !== null} onClick={get}>
              {a.busy === "faucet" ? `${step}…` : "Get test SOL"}
            </button>
          </>
        )}
      </span>
      {a.done && <Sig label="faucet" sig={a.done.sig} />}
      {a.error && <p className="status err" role="alert">{a.error}</p>}
    </>
  );
}

/** The SOL tab of OPEN A POSITION: lock simSOL (test mode) or SOL / the staking token (mainnet) and take the Advance. `market` null = not read yet. */
export function NativeOpenForm({ market, loading, onDone }: { market: NativeMarket | null; loading: boolean; onDone?: () => void }) {
  if (CLUSTER.yieldModel === "real") return <StakeOpenForm market={market} loading={loading} onDone={onDone} />;
  return <SimOpenForm market={market} loading={loading} onDone={onDone} />;
}

/** Mainnet: open with plain SOL (staked on the way in) or with the staking token, then take the Advance. */
function StakeOpenForm({ market, loading, onDone }: { market: NativeMarket | null; loading: boolean; onDone?: () => void }) {
  const { auth, refresh, snapshot } = useAccount();
  const a = useAction(refresh);
  const stake = market?.stake ?? null;
  const [from, setFrom] = useState<"sol" | "token">("sol");
  const [text, setText] = useState("");
  const [months, setMonths] = useState(DEFAULT_HORIZON_MONTHS);
  const [step, setStep] = useState("Preparing");
  const now = useNow(5000);
  const symbol = stake?.token.symbol ?? "staked SOL";

  const amount = Number(text);
  const units = Number.isFinite(amount) && amount > 0 ? BigInt(Math.round(amount * LAMPORTS)) : 0n;
  const solBalance = BigInt(snapshot?.lamports ?? 0);
  const balance = from === "sol" ? solBalance : (stake?.tokenBalance ?? 0n);
  // Plain SOL is staked first: the Position opens for the tokens it quotes, less 0.5%.
  const deposit = stake && from === "sol" ? quoteDepositSol(units, stake.pool) : null;
  const shares = from === "token" ? units : (deposit?.openTokens ?? 0n);
  const principal = stake ? (from === "token" ? unitsForTokens(units, stake.rate) : (deposit?.principalLamports ?? 0n)) : 0n;
  const priceAge = market?.price ? now / 1000 - market.price.updatedTs : Infinity;
  const priceOk = !!market?.price && priceAge <= MAX_PRICE_AGE_SECS - PRICE_QUOTE_MARGIN_SECS;
  const { yieldFeeBps } = ratesOf(market?.treasury);
  const apyBps = stake?.sizingBps ?? 0;
  const quote = market && stake && priceOk && apyBps > 0 ? quoteNativeAdvance(principal, apyBps, months, market.price!.microUsd, yieldFeeBps) : null;
  const gemas = quote ? Number(quote.gemas) : 0;
  const estimate =
    stake && quote && shares > 0n && gemas > 0
      ? unlockEstimateMs({
          clock: { principal, rateBps: apyBps, yieldFeeBps, openedAt: Math.floor(now / 1000), stakeRateOpen: stake.rate },
          speedup: 1,
          appliedNet: 0n,
          source: { issued: quote.gemas, returned: 0n, redeemed: 0n, yieldUnits: 0n, unitNum: 10n ** 13n, unitDen: market!.price!.microUsd },
          nowMs: now,
          stake: stakeGrowthOf(market, Math.floor(now / 1000)),
        })
      : null;
  const tooMuch = units > balance;
  const leaveFees = from === "sol" && units + 20_000_000n > solBalance && !tooMuch;
  const valid = !!stake && stake.open && shares > 0n && !tooMuch && !leaveFees && gemas > 0 && !deposit?.problem;

  if (a.done) {
    return (
      <div className="stack">
        <div className="status ok" role="status">
          <CheckIcon /> Lock started · <GemaAmount value={gemas} size="md" /> issued
        </div>
        <Sig label="open" sig={a.done.sig} />
        <Button block onClick={() => { a.clear(); setText(""); onDone?.(); }}>Done</Button>
      </div>
    );
  }

  return (
    <OpenFormView
      chain="SOL"
      apy={apyBps > 0 ? `${(apyBps / 100).toFixed(1)}% APY` : undefined}
      inert={!market}
      amountText={text}
      onAmount={setText}
      amountInvalid={tooMuch}
      balance={
        <>
          <span role="group" aria-label="What you lock">
            <button type="button" className="wl-link" aria-pressed={from === "sol"} onClick={() => { setFrom("sol"); setText(""); }}>SOL</button>
            {" · "}
            <button type="button" className="wl-link" aria-pressed={from === "token"} onClick={() => { setFrom("token"); setText(""); }}>{symbol}</button>
          </span>
          <span>
            {loading ? "Loading your Account…" : <>You have <b className="tnum">{fmtSol(balance, 3)}</b> {from === "sol" ? "SOL" : symbol}</>}
          </span>
        </>
      }
      max={from === "token" ? Number(balance) / LAMPORTS : Math.max(0, Number(balance - 20_000_000n) / LAMPORTS)}
      months={months}
      onMonths={setMonths}
      gemas={gemas}
      yieldText={`${quote ? fmtSol(quote.projectedUnits) : "0"} SOL`}
      yieldFeeBps={yieldFeeBps}
      estimate={estimate ? `${fmtWhen(estimate)} (${fmtInMinutes(estimate, now)})` : "—"}
      details={[
        ["Worth at issuance", fmtUsd(gemasToUsd(gemas))],
        ["Locked amount", `${fmtSol(principal)} SOL`],
        ["Projected yield (after the Yield Fee)", `${quote ? fmtSol(quote.projectedUnits) : "—"} SOL`],
        ["Yield rate", stake ? `${(Number(stake.rate) / 1e12).toFixed(6)} SOL per ${symbol}` : "—"],
        ["Price feed", market?.price ? `SOL $${(Number(market.price.microUsd) / 1e6).toFixed(2)} · ${Math.max(0, Math.round(priceAge / 60))} min ago` : "not published yet"],
      ]}
      alerts={
        <>
          {market && !priceOk && <p className="status err" role="alert">The SOL price is updating. Try again in a few minutes.</p>}
          {stake && !stake.open && <p className="status err" role="alert">Locking is not available yet.</p>}
          {stake?.open && apyBps === 0 && <p className="status err" role="alert">The staking pool shows no recent growth to size an Advance on. Try again later.</p>}
          {deposit?.problem && <p className="status err" role="alert">{deposit.problem}</p>}
          {tooMuch && <p className="status err" role="alert">That is more {from === "sol" ? "SOL" : symbol} than you have.</p>}
          {leaveFees && <p className="status err" role="alert">Leave a little SOL for network fees.</p>}
          {a.error && <p className="status err" role="alert">{a.error}</p>}
        </>
      }
      note={<span className="note">Real yield · your Lock earns {symbol}&apos;s yield rate{from === "sol" ? ". SOL is staked for you first; the whole step reverts if it mints less than quoted." : "."}</span>}
      buttonLabel={a.busy ? `${step}…` : <GemasLabel action="Get Gemas" gemas={gemas} />}
      disabled={!valid || !priceOk || a.busy !== null || !auth.signer}
      onSubmit={() =>
        auth.signer &&
        stake &&
        a.run("open", async () => (await openStakePositionWithAdvance(auth.signer!, auth.getAccessToken, from === "token" ? { from: "token", shares } : { from: "sol", lamports: units }, months, stake.token, setStep)).signature)
      }
    />
  );
}

function SimOpenForm({ market, loading, onDone }: { market: NativeMarket | null; loading: boolean; onDone?: () => void }) {
  const { auth, refresh } = useAccount();
  const a = useAction(refresh);
  const balance = market ? Number(market.simSol) / LAMPORTS : 0;
  const [typed, setText] = useState<string | null>(null);
  const [months, setMonths] = useState(DEFAULT_HORIZON_MONTHS);
  const [step, setStep] = useState("Preparing");
  const now = useNow(5000);
  const intent = useOpenIntent();
  const { gemas: held } = useAccount();

  const rate = market ? rateAt(market.pool) : 0n;
  const priceAge = market?.price ? now / 1000 - market.price.updatedTs : Infinity;
  const priceOk = !!market?.price && priceAge <= MAX_PRICE_AGE_SECS - PRICE_QUOTE_MARGIN_SECS;
  const { yieldFeeBps } = ratesOf(market?.treasury);

  // Until the Player types: the deposit that covers the game they came for, else half of what they hold.
  let seed = "";
  if (market && balance > 0) {
    const floor3 = (n: number) => Math.floor(n * 1000) / 1000;
    const short = intent?.need ? intent.need - held.available : 0;
    if (short > 0 && priceOk) {
      const perSol = quoteNativeAdvance(sharesValue(BigInt(LAMPORTS), rate), market.pool.apyBps, months, market.price!.microUsd, yieldFeeBps).gemas;
      const sol = perSol > 0n ? Math.ceil((short / Number(perSol)) * 1.02 * 1000) / 1000 : balance;
      seed = String(sol <= balance ? sol : floor3(balance));
    } else if (!intent) {
      seed = String(floor3(balance * 0.5));
    }
  }
  const text = typed ?? seed;
  const amount = Number(text);
  const shares = market && Number.isFinite(amount) && amount > 0 ? BigInt(Math.round(amount * LAMPORTS)) : 0n;
  const principal = market ? sharesValue(shares, rate) : 0n;
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
  const horizonAt = estimate ?? now + months * SIM_MONTH_MIN * 60_000;

  if (a.done) {
    const back = intent
      ? { href: intent.need ? `/play/queue?${gameQuery(intent.game)}entry=${intent.need}` : `/play/${intent.game}`, label: `Play ${GAME_NAMES[intent.game]}` }
      : null;
    return (
      <div className="stack">
        <div className="status ok" role="status">
          <CheckIcon /> Lock started · <GemaAmount value={gemas} size="md" /> issued
        </div>
        <Sig label="open" sig={a.done.sig} />
        {back && (
          <Button variant="money" size="lg" block href={back.href}>
            <GemasLabel action={back.label} gemas={intent?.need ?? 0} />
          </Button>
        )}
        <Button block onClick={() => { a.clear(); setText(null); onDone?.(); }}>{back ? "Not now" : "Done"}</Button>
      </div>
    );
  }

  return (
    <OpenFormView
      chain="SOL"
      apy={market && market.pool.apyBps > 0 ? `${market.pool.apyBps / 100}% APY` : undefined}
      inert={!market}
      amountText={text}
      onAmount={setText}
      amountInvalid={tooMuch}
      head={market && !loading && balance === 0 ? <NativeFaucet market={market} loading={loading} asButton /> : undefined}
      balance={<NativeFaucet market={market} loading={loading} />}
      max={market ? balance : undefined}
      months={months}
      onMonths={setMonths}
      gemas={gemas}
      yieldText={`${quote ? fmtSol(quote.projectedUnits) : "0"} SOL`}
      yieldFeeBps={yieldFeeBps}
      estimate={`${fmtWhen(horizonAt)} (${fmtInMinutes(horizonAt, now)})`}
      details={[
        ["Worth at issuance", fmtUsd(gemasToUsd(gemas))],
        ["Locked amount", `${fmtSol(principal)} SOL`],
        ["Projected yield (after the Yield Fee)", `${quote ? fmtSol(quote.projectedUnits) : "—"} SOL`],
        [
          "Price feed",
          market?.price ? `SOL $${(Number(market.price.microUsd) / 1e6).toFixed(2)} · ${Math.max(0, Math.round(priceAge / 60))} min ago` : "not published yet",
        ],
      ]}
      alerts={
        <>
          {market && !priceOk && <p className="status err" role="alert">The SOL price is updating. Try again in a few minutes.</p>}
          {tooMuch && <p className="status err" role="alert">That is more test SOL than you have.</p>}
          {a.error && <p className="status err" role="alert">{a.error}</p>}
        </>
      }
      note={<span className="sim">Simulated yield · 1 month = {SIM_MONTH_MIN} min</span>}
      buttonLabel={
        a.busy ? `${step}…` : tooMuch ? "Not enough test SOL" : shares === 0n ? "Enter an amount" : market && !priceOk ? "Waiting for the SOL price" : <GemasLabel action="Get Gemas" gemas={gemas} />
      }
      disabled={!valid || !priceOk || a.busy !== null || !auth.signer}
      onSubmit={() => auth.signer && a.run("open", async () => (await openPositionWithAdvance(auth.signer!, auth.getAccessToken, shares, months, setStep)).signature)}
    />
  );
}


// ---- Position card ------------------------------------------------------------------------------

export function NativePositionCard({
  position,
  market,
  onRedeem,
  extend = EXTEND_ADVANCE_ENABLED,
  label = "SOL Lock",
  compact,
}: {
  position: ChainPosition;
  market: NativeMarket | null;
  onRedeem: () => void;
  extend?: boolean;
  label?: string;
  compact?: boolean;
}) {
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
  const stake = stakeGrowthOf(market);
  const symbol = market?.stake?.token.symbol ?? tokenSymbol(info.mint);
  // Debt, redeemable and free yield are derived from the clock, as the program computes them (nothing is cranked).
  const cur = nativeNow(info, speedup, Math.floor(now / 1000), stake);
  const src = cur.source;
  const debt = cur.debtGemas;
  const debtSol = src && debt > 0n ? (debt * src.unitNum + src.unitDen - 1n) / src.unitDen : 0n;
  const estimate = src && debt > 0n ? unlockEstimateMs({ clock: clockOf(info), speedup, appliedNet: info.appliedNet, source: src, nowMs: now, stake }) : null;
  const locked = info.status === "locked";
  const canUnlock = locked && debt === 0n;
  const canExtend = extend && locked && !!src && info.openAdvance === info.source?.index && debt > 0n && info.source.horizonMonths < MAX_ADVANCE_MONTHS;
  const redeemable = (snapshot?.holdings ?? []).some((h) => h.native && h.position.equals(position.address) && h.redeemable > 0n);
  const series = src && locked && debt > 0n ? sampledSeries((at) => Number(debtGemasAt(info, speedup, at, stake)), now, estimate ? estimate - now : 10 * 60_000) : null;

  return (
    <PositionTile
      chain="SOL"
      label={label}
      compact={compact}
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
          <p className="note">Earned {fmtSol(cur.accrued, 5)} SOL{info.stakeRateOpen > 0n ? ` (${symbol} yield rate)` : " (simulated)"}. {BRAND.name} keeps {yieldFeeBps / 100}% of the yield (the Yield Fee), so this is your {100 - yieldFeeBps / 100}%.</p>
          {locked && !canUnlock && <p className="note">Unlock returns your SOL once it is paid back. Only this Lock&apos;s own yield pays it back.</p>}
          {canUnlock && <p className="note">Paid back: Unlock to get your SOL back, or take another Advance on the same SOL.</p>}
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
            <Button size="sm" disabled={!signer || a.busy !== null || !canUnlock} onClick={() => signer && a.run("unlock", () => unlockNative(signer, auth.getAccessToken, info))}>
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
  const priceOk = !!market?.price && priceAge <= MAX_PRICE_AGE_SECS - PRICE_QUOTE_MARGIN_SECS;
  const yieldFeeBps = info.yieldFeeBps;
  const real = info.stakeRateOpen > 0n;
  // On mainnet the Advance is sized on the pool's recent growth under the admin's ceiling, not on the rate the Position opened with.
  const rateBps = real ? (market?.stake?.sizingBps ?? 0) : info.rateBps;
  const quote = priceOk && rateBps > 0 ? quoteNativeAdvance(info.principalLamports, rateBps, months, market!.price!.microUsd, yieldFeeBps) : null;
  const gemas = quote ? Number(quote.gemas) : 0;
  // Simulated: the Advance is the Horizon's projected yield net of the Yield Fee, so yield repays it in exactly the Horizon. Real: an estimate from the pool's recent growth.
  const growth = stakeGrowthOf(market);
  const unlock =
    gemas <= 0
      ? null
      : real
        ? unlockEstimateMs({
            clock: clockOf(info),
            speedup: 1,
            appliedNet: nativeNow(info, 1, Math.floor(now / 1000), growth).accrued,
            source: { issued: quote!.gemas, returned: 0n, redeemed: 0n, yieldUnits: 0n, unitNum: 10n ** 13n, unitDen: market!.price!.microUsd },
            nowMs: now,
            stake: growth,
          })
        : now + months * SIM_MONTH_MIN * 60_000;
  const title = `${fmtSol(info.principalLamports, 3)} SOL Lock`;

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
      apy={`${(rateBps / 100).toFixed(1)}% APY`}
      months={months}
      onMonths={setMonths}
      yieldText={`${quote ? fmtSol(quote.projectedUnits) : "0"} SOL`}
      yieldFeeBps={yieldFeeBps}
      gemas={gemas}
      unlock={unlock ? `${fmtWhen(unlock)} (${fmtInMinutes(unlock, now)})` : "—"}
      alerts={
        <>
          {market && !priceOk && <p className="status err" role="alert">The SOL price is updating. Try again in a few minutes.</p>}
          {real && priceOk && rateBps === 0 && <p className="status err" role="alert">The staking pool shows no recent growth to size an Advance on. Try again later.</p>}
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
  const rateBps = info.stakeRateOpen > 0n ? (market?.stake?.sizingBps ?? 0) : info.rateBps;
  const quote = quoteExtendAdvance(info.principalLamports, rateBps, source.math, source.horizonMonths, months, yieldFeeBps);
  const gemas = Number(quote.gemas);
  const addedYield = advanceUnits(info.principalLamports, rateBps, source.horizonMonths + months, yieldFeeBps) - advanceUnits(info.principalLamports, rateBps, source.horizonMonths, yieldFeeBps);
  const unlock = gemas > 0 ? unlockEstimateMs({ clock: clockOf(info), speedup: speedupOf(pool), appliedNet: info.appliedNet, source: quote.extended, nowMs: now, stake: stakeGrowthOf(market) }) : null;
  const title = `${fmtSol(info.principalLamports, 3)} SOL Lock`;

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
      apy={`${(rateBps / 100).toFixed(1)}% APY`}
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
          <p className="note">Adds {fmtGemas(gemas)} Gemas to pay back to this Advance. Your SOL stays locked for {source.horizonMonths + months} months in all.</p>
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

/** Redeem every chain's redeemable Gemas, or only `asset`'s (a chain's own Redeem on the Wallet). */
export function NativeRedeemSheet({ open, onClose, asset }: { open: boolean; onClose: () => void; asset?: Chain }) {
  return (
    <Sheet open={open} onClose={onClose} title={asset ? `Redeem ${asset}` : "Redeem"}>
      {open && <RedeemForm onClose={onClose} asset={asset} />}
    </Sheet>
  );
}

function RedeemForm({ onClose, asset }: { onClose: () => void; asset?: Chain }) {
  const { auth, snapshot: full, refresh } = useAccount();
  const snapshot = full && asset ? { ...full, holdings: full.holdings.filter((h) => h.asset === asset) } : full;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<RedeemDone | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const sigs = useRef<string[]>([]);
  const rows = nativeRedeemables(snapshot?.holdings ?? []);
  const ethRows = ethRedeemables(snapshot?.holdings ?? []);
  const ethWaiting = ethYieldWaiting(snapshot?.holdings ?? []);
  const ethCtx = useEthCtx();
  const pool = snapshot?.market?.pool ?? null;
  const from = (h: ChainHolding) => (h.isOwn ? `Your ${h.asset} Lock` : `Won · ${h.sourceOwner.slice(0, 4)}…${h.sourceOwner.slice(-4)}`);
  const payouts: RedeemPayout[] = [
    ...rows.map((h) => ({
      key: h.key,
      asset: "SOL" as const,
      from: from(h),
      gemas: Number(h.redeemable),
      amount: h.stakeMint && snapshot?.market?.stake
        ? Number(tokensForUnits((h.redeemable * h.unitNum) / h.unitDen, snapshot.market.stake.rate)) / LAMPORTS
        : pool && !h.stakeMint
          ? Number(redeemPayoutShares(h, h.redeemable, rateAt(pool))) / LAMPORTS
          : null,
      token: h.stakeMint ? (snapshot?.market?.stake?.token.symbol ?? tokenSymbol(h.stakeMint)) : "test SOL",
      later: false,
    })),
    ...ethRows.map((h) => ({
      key: h.key,
      asset: h.asset,
      from: from(h),
      gemas: Number(h.redeemable),
      amount: gemasInAsset(h.redeemable, h),
      token: h.asset,
      later: true,
    })),
  ];

  const { offer: instant, orders, freshPlan, reloadOrders } = useInstantRedeem(asset);

  /** Offers every won line that is waiting on yield: one order each, bought by Tesoro when it can. */
  const redeemNow = async () => {
    if (!auth.signer) return;
    setBusy(true);
    setError(null);
    try {
      const signer = auth.signer;
      const fresh = await freshPlan(signer.publicKey);
      if (fresh.length === 0) {
        await refresh();
        throw new Error("Yield landed while you were confirming, so none of these Gemas are waiting any more. Redeem them at full value instead.");
      }
      for (const p of fresh) sigs.current.push(await requestInstantRedeem(signer, auth.getAccessToken, p.holding, p.gemas));
      setDone({ gemas: fresh.reduce((sum, p) => sum + Number(p.gemas), 0), later: fresh.some((p) => !p.holding.native), instant: true, receipts: sigs.current.map((sig) => ({ label: "Offered for sale", sig })) });
      await Promise.all([refresh(), reloadOrders()]);
    } catch (e) {
      setError(friendlyError(e));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  /** Takes an order's unsold Gemas back (after its deadline anyone may; here the seller does). */
  const cancelOrder = async (key: string) => {
    const order = orders.find((o) => o.address.toBase58() === key);
    if (!order || !auth.signer) return;
    setBusy(true);
    setError(null);
    try {
      const sig = await cancelInstantRedeem(auth.signer, auth.getAccessToken, order);
      setDone({ gemas: Number(order.line.amount), later: false, cancelled: true, receipts: [{ label: "Taken back", sig }] });
      await Promise.all([refresh(), reloadOrders()]);
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
      for (const h of rows) sigs.current.push(await redeemNative(auth.signer, auth.getAccessToken, h, h.redeemable));
      let ethGemas = 0;
      let ethCount = 0;
      if (ethRows.length > 0 || ethWaiting.length > 0) {
        if (!ethCtx) throw new Error("Your ETH wallet is not ready yet. Try again in a moment.");
        const r = await redeemEthHoldings(ethCtx, snapshot?.holdings ?? [], setNote);
        ethGemas = Number(r.gemas);
        ethCount = r.count;
      }
      if (rows.length === 0 && ethCount === 0) {
        await refresh();
        throw new Error(NOTHING_REDEEMABLE_YET);
      }
      setDone({ gemas: rows.reduce((s, h) => s + Number(h.redeemable), 0) + ethGemas || gemas, later: ethCount > 0, receipts: sigs.current.map((sig) => ({ label: "Redeemed", sig })) });
      await refresh();
    } catch (e) {
      setError(friendlyError(e));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return <RedeemExchange payouts={payouts} instant={instant} busy={busy} busyNote={note} yieldCheck={ethWaiting.length > 0 ? [...new Set(ethWaiting.map((h) => h.asset))].join(" and ") : null} error={error} done={done} canSign={Boolean(auth.signer)} onRedeem={() => void redeem()} onInstant={() => void redeemNow()} onCancelOrder={(k) => void cancelOrder(k)} onClose={onClose} />;
}
