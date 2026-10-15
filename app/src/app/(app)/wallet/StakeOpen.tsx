"use client";

import { useEffect, useState } from "react";
import { CheckIcon, GemaAmount } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { DEFAULT_HORIZON_MONTHS } from "@/lib/advance";
import { fmtInMinutes, fmtUsd, fmtWhen, gemasToUsd } from "@/lib/format";
import { getChain } from "@/lib/chain/client";
import { ratesOf } from "@/lib/chain/fees";
import { LAMPORTS, MAX_PRICE_AGE_SECS, quoteNativeAdvance, unlockEstimateMs, RATE_SCALE } from "@/lib/chain/native";
import { friendlyError } from "@/lib/chain/native-flow";
import { fetchStakeMarket, openStakePosition, type StakeMarket } from "@/lib/chain/stake-flow";
import { quoteDepositSol, stakePoolRate, tokenSymbol } from "@/lib/chain/stake-pool";
import { GemasLabel } from "./AdvanceQuote";
import { OpenFormView } from "./OpenPanel";

const fmtSol = (lamports: bigint | number, digits = 4) => (Number(lamports) / LAMPORTS).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

type With = "sol" | "token";

/** The SOL tab of OPEN A POSITION on a cluster with a real staking token: lock plain SOL (staked on the way in) or the token itself. */
export function StakeOpenForm({ onDone }: { onDone?: () => void }) {
  const { auth, refresh } = useAccount();
  const [market, setMarket] = useState<StakeMarket | null | undefined>(undefined);
  const [readError, setReadError] = useState(false);
  const [pick, setPick] = useState<With>("sol");
  const [text, setText] = useState("");
  const [months, setMonths] = useState(DEFAULT_HORIZON_MONTHS);
  const [step, setStep] = useState("Preparing");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sig, setSig] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const wallet = auth.signer?.publicKey;

  useEffect(() => {
    if (!wallet) return;
    let live = true;
    const read = () =>
      fetchStakeMarket(getChain().base, wallet).then(
        (m) => live && (setMarket(m), setReadError(false)),
        () => live && setReadError(true),
      );
    void read();
    const id = setInterval(() => { setNow(Date.now()); void read(); }, 30_000);
    return () => { live = false; clearInterval(id); };
  }, [wallet]);

  const symbol = market ? tokenSymbol(market.source.mint) : "staked SOL";
  const rate = market ? stakePoolRate(market.pool.totalLamports, market.pool.poolTokenSupply) ?? 0n : 0n;
  const amount = Number(text);
  const units = Number.isFinite(amount) && amount > 0 ? BigInt(Math.round(amount * LAMPORTS)) : 0n;
  const sol = pick === "sol";
  const deposit = market && sol ? quoteDepositSol(units, market.pool) : null;
  const tokens = !market ? 0n : sol ? deposit!.openTokens : units;
  const principal = (tokens * rate) / RATE_SCALE;
  const { yieldFeeBps } = ratesOf(market?.treasury);
  const priceAge = market?.price ? now / 1000 - market.price.updatedTs : Infinity;
  const priceOk = !!market?.price && priceAge <= MAX_PRICE_AGE_SECS - 60;
  const quote = market && priceOk && market.apyBps > 0 ? quoteNativeAdvance(principal, market.apyBps, months, market.price!.microUsd, yieldFeeBps) : null;
  const gemas = quote ? Number(quote.gemas) : 0;
  const estimate =
    market && quote && tokens > 0n && gemas > 0
      ? unlockEstimateMs({
          source: { issued: quote.gemas, returned: 0n, redeemed: 0n, yieldUnits: 0n, unitNum: 10n ** 13n, unitDen: market.price!.microUsd },
          vaultShares: tokens,
          redeemedUnits: 0n,
          principalLamports: principal,
          pool: { baseRate: rate, baseTs: Math.floor(now / 1000), apyBps: market.apyBps, speedup: 1 },
          clock: { rateBps: market.apyBps, lastAccrualTs: Math.floor(now / 1000) },
          nowMs: now,
          yieldFeeBps,
        })
      : null;
  // Leave a little SOL for rent and fees when staking.
  const spendable = market ? (market.sol > 10_000_000n ? market.sol - 10_000_000n : 0n) : 0n;
  const tooMuch = !!market && (sol ? units > spendable : units > market.tokens);
  const problem = deposit?.problem ?? null;
  const valid = !!market && tokens > 0n && !tooMuch && !problem && gemas > 0;

  if (sig) {
    return (
      <div className="stack">
        <div className="status ok" role="status"><CheckIcon /> Position opened · <GemaAmount value={gemas} size="md" /> issued</div>
        <a className="meta mono" href={`https://explorer.solana.com/tx/${sig}`} target="_blank" rel="noreferrer">receipt {sig.slice(0, 8)}…</a>
      </div>
    );
  }

  const submit = async () => {
    if (!auth.signer || !market) return;
    setBusy(true);
    setError(null);
    try {
      const done = await openStakePosition(auth.signer, market, sol ? { lamports: units } : { tokens: units }, months, setStep);
      setSig(done.signature);
      await refresh();
      onDone?.();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <OpenFormView
      chain="SOL"
      apy={market && market.apyBps > 0 ? `${market.apyBps / 100}% APY` : undefined}
      inert={!market}
      head={
        <div className="hstack" role="radiogroup" aria-label="Open with">
          {(["sol", "token"] as const).map((w) => (
            <button key={w} type="button" role="radio" aria-checked={pick === w} className={`btn${pick === w ? "" : " neutral"}`} onClick={() => { setPick(w); setText(""); }}>
              {w === "sol" ? "SOL" : symbol}
            </button>
          ))}
        </div>
      }
      amountText={text}
      onAmount={setText}
      amountInvalid={tooMuch}
      balance={market ? <>You have <b className="tnum">{sol ? fmtSol(market.sol, 3) : fmtSol(market.tokens, 3)}</b> {sol ? "SOL" : symbol}</> : market === null ? "No staking token is set yet." : readError ? "Could not read the market. Retrying…" : "Loading…"}
      max={market ? Number(sol ? spendable : market.tokens) / LAMPORTS : undefined}
      months={months}
      onMonths={setMonths}
      gemas={gemas}
      yieldText={`${quote ? fmtSol(quote.projectedUnits) : "0"} SOL`}
      yieldFeeBps={yieldFeeBps}
      estimate={estimate ? `${fmtWhen(estimate)} (${fmtInMinutes(estimate, now)})` : "—"}
      details={[
        ["Worth at issuance", fmtUsd(gemasToUsd(gemas))],
        ...(sol && deposit && deposit.tokens > 0n ? ([["You receive (staked)", `${fmtSol(deposit.tokens, 4)} ${symbol}`]] as [string, string][]) : []),
        ["Principal", `${fmtSol(principal)} SOL`],
        ["Projected yield (after the Yield Fee)", `${quote ? fmtSol(quote.projectedUnits) : "—"} SOL`],
      ]}
      alerts={
        <>
          {market && !priceOk && <p className="status err" role="alert">The SOL price is updating. Try again in a few minutes.</p>}
          {tooMuch && <p className="status err" role="alert">That is more {sol ? "SOL" : symbol} than you have.</p>}
          {problem && <p className="status err" role="alert">{problem}</p>}
          {error && <p className="status err" role="alert">{error}</p>}
        </>
      }
      buttonLabel={busy ? `${step}…` : <GemasLabel action="Open a Position" gemas={gemas} />}
      disabled={!valid || !priceOk || busy || !auth.signer}
      onSubmit={() => void submit()}
    />
  );
}
