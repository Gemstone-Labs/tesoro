"use client";

import type { PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, ChainChip, Chip, ClockIcon, CrossChainProgress } from "@/components/ui";
import { ReturnOwnSheet, useReturnable } from "./MoneySheets";
import { GemasLabel } from "./AdvanceQuote";
import { OpenFormView } from "./OpenPanel";
import { PositionTile, linearSeries } from "./PositionTile";
import { useAccount } from "@/lib/account";
import { DEFAULT_HORIZON_MONTHS } from "@/lib/advance";
import { useAuth } from "@/lib/auth/context";
import { playerPaysGas, type OpenCostQuote } from "@/lib/chain/eth-fee";
import { useTreasuryRates } from "@/lib/chain/useTreasuryRates";
import { netApyPct } from "@/lib/chain/yield";
import { getChain } from "@/lib/chain/client";
import { debtGemas, debtUnits } from "@/lib/chain/ledger";
import {
  ETH_SIM_MONTH_MIN,
  MAX_PRINCIPAL_WEI,
  NETS,
  WEI,
  ethUnlockEstimateMs,
  fetchEthMarket,
  ethSourceIndex,
  fetchEthState,
  fetchPaidTo,
  evmClient,
  fetchVaultPosition,
  fmtEth,
  lzScanUrl,
  netOfVault,
  projectedEthDebt,
  quoteEthAdvance,
  redeemPayoutWei,
  shortHex,
  simRateAt,
  underlyingOf,
  vaultByAddress,
  withHeadroom,
  type EthMarket,
  type EthState,
  type EthVault,
  type VaultPosition,
} from "@/lib/chain/eth";
import {
  ensureEvmLinked,
  ethError,
  fetchEthPrice,
  getTestSimEth,
  openEthPosition,
  instantRedeemToEvm,
  redeemToEvm,
  reportEthYield,
  takeEthAdvance,
  ethCall,
  requestGas,
  estimateOpenCost,
  MIN_HOODI_WEI,
  MIN_HYPE_WEI,
  unlockEth,
  type EthCtx,
  type OpenStep,
} from "@/lib/chain/eth-flow";
import {
  OPS_EVENT,
  addOp,
  fetchScanStatus,
  loadOps,
  opCopy,
  opProgress,
  opSteps,
  opWords,
  patchOp,
  removeOp,
  untrackedOpens,
  type EthOp,
  type ScanStatus,
} from "@/lib/chain/eth-track";
import type { ChainHolding, ChainPosition } from "@/lib/chain/read";
import { fmtGemas, fmtInMinutes, fmtUsd, fmtWhen, gemasToUsd } from "@/lib/format";

const solscan = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}


/** The Account's Solana signer and EVM wallet together, or null until both exist. */
export function useEthCtx(): EthCtx | null {
  const { signer, evm, getAccessToken } = useAuth();
  return useMemo(() => (signer && evm ? { signer, evm, getToken: getAccessToken } : null), [signer, evm, getAccessToken]);
}

/** Runs one wallet action with a busy label and the error message. */
function useBusy() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(label);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(ethError(e));
      return undefined;
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, error, run, clear: () => setError(null) };
}

function useEthMarket(vault: EthVault, evm: string | null) {
  const [market, setMarket] = useState<EthMarket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!evm) return;
    try {
      setMarket(await fetchEthMarket(vault, evm as `0x${string}`));
      setError(null);
    } catch (e) {
      setError(ethError(e));
    }
  }, [vault, evm]);
  useEffect(() => {
    if (!evm) return;
    const first = setTimeout(() => void refresh(), 0);
    const t = setInterval(() => document.visibilityState === "visible" && void refresh(), 10_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [evm, refresh]);
  return { market: evm ? market : null, error, refresh };
}

function Links({ evm, vault, scan, solana }: { evm?: string; vault: string; scan?: string; solana?: string }) {
  const net = netOfVault(vault);
  return (
    <div className="stack">
      {evm && <a className="meta mono" href={net.tx(evm)} target="_blank" rel="noreferrer">{net.label} tx · {shortHex(evm)}</a>}
      {scan && <a className="meta mono" href={lzScanUrl(scan)} target="_blank" rel="noreferrer">Track the transfer · {shortHex(scan)}</a>}
      {solana && <a className="meta mono" href={solscan(solana)} target="_blank" rel="noreferrer">Solana tx · {solana.slice(0, 10)}…</a>}
    </div>
  );
}

// ---- Get simETH / simHYPE + Open an ETH or HYPE Position ------------------------------------------------------------------

/** The simETH / simHYPE faucet, shown above the open form: EVM address, gas and simulated-token balances, Get test token. */
export function EthFaucet({ vault }: { vault: EthVault }) {
  const auth = useAuth();
  const ctx = useEthCtx();
  const net = NETS[vault.net];
  const { market, error: readError, refresh } = useEthMarket(vault, auth.evm?.address ?? null);
  const a = useBusy();
  const [done, setDone] = useState<string | null>(null);
  const now = useNow(15_000);
  const cooling = market && market.faucetAvailableAt * 1000 > now;
  const lowGas = net.key === "hyperevm" && !!market && market.ethBalance < MIN_HYPE_WEI;

  return (
    <div className="wl-faucet">
      <div className="spread">
        <span className="hstack">
          <ChainChip chain={net.native} />
          <span className="meta">{net.label} testnet</span>
        </span>
        <Chip tone="warn">Simulated</Chip>
      </div>
      <dl className="kv">
        <dt>Your wallet address</dt>
        <dd className="mono">{auth.evm ? shortHex(auth.evm.address) : "Creating your wallet…"}</dd>
        <dt>{net.label} {net.native} (for fees)</dt>
        <dd className="tnum">{market ? fmtEth(market.ethBalance, 4) : "—"} {net.native}</dd>
        <dt>Your {vault.symbol}</dt>
        <dd className="tnum">{market ? fmtEth(market.simEth, 3) : "—"} {vault.symbol}</dd>
      </dl>
      <Button
        size="sm"
        block
        disabled={!ctx || a.busy !== null || !!cooling}
        onClick={() =>
          ctx &&
          void a.run("faucet", async () => {
            const hash = await getTestSimEth(ctx, vault);
            setDone(hash);
            await refresh();
          })
        }
      >
        {a.busy === "faucet" ? `Getting ${vault.symbol}…` : cooling ? "Faucet cooling down" : `Get test ${vault.symbol}`}
      </Button>
      {lowGas && (
        <>
          <p className="meta">Free test HYPE for network fees, once a day per wallet.</p>
          <Button size="sm" block disabled={!ctx || a.busy !== null} onClick={() => ctx && void a.run("gas", async () => { await requestGas(ctx, net); await refresh(); })}>
            {a.busy === "gas" ? "Getting test HYPE…" : "Get test HYPE"}
          </Button>
        </>
      )}
      {done && <Links evm={done} vault={vault.address} />}
      {(a.error || readError) && <p className="status err" role="alert">{a.error ?? readError}</p>}
    </div>
  );
}

const openStepText = (vault: EthVault): Record<OpenStep, string> => ({
  link: "Linking your wallet to your Account…",
  gas: `Checking ${NETS[vault.net].label} fees…`,
  approve: `Approve ${vault.symbol} in your wallet`,
  confirm: "Waiting for the approval to confirm…",
  inbox: "Preparing your Position…",
  open: "Open your Position in your wallet",
  opening: "Opening your Position…",
});

/** The ETH and HYPE tabs of OPEN A POSITION: link, approve and open on the vault's chain; the Advance follows once LayerZero delivers. */
export function EthOpenForm({ vault, onOpened }: { vault: EthVault; onOpened: (opKey: string) => void }) {
  const ctx = useEthCtx();
  const net = NETS[vault.net];
  const unit = net.native;
  const { market } = useEthMarket(vault, ctx?.evm.address ?? null);
  const { refresh: refreshAccount } = useAccount();
  const a = useBusy();
  const toppedUp = useRef<string | null>(null);
  const [step, setStep] = useState<OpenStep | null>(null);
  const [text, setText] = useState("");
  const [months, setMonths] = useState(DEFAULT_HORIZON_MONTHS);
  const [price, setPrice] = useState<{ microUsd: bigint; live: boolean } | null>(null);
  const now = useNow(5000);
  const { yieldFeeBps } = useTreasuryRates();
  // Fees for approve + open arrive while the Player fills in the form, not after they press Open.
  const lowGas = !!market && market.ethBalance < (net.key === "hoodi" ? MIN_HOODI_WEI : MIN_HYPE_WEI);
  useEffect(() => {
    if (playerPaysGas() || !ctx || !lowGas || toppedUp.current === net.key) return;
    toppedUp.current = net.key;
    requestGas(ctx, net).catch(() => {});
  }, [ctx, lowGas, net]);
  useEffect(() => {
    fetchEthPrice(unit).then((p) => setPrice({ microUsd: p.priceMicroUsd, live: p.live })).catch(() => setPrice(null));
  }, [unit]);

  const shares = /^\d*\.?\d{0,18}$/.test(text) && Number(text) > 0 ? BigInt(Math.round(Number(text) * 1e9)) * 10n ** 9n : 0n;
  const rate = market ? simRateAt(market.rate) : WEI;
  const principal = underlyingOf(shares, rate);
  const quote = price && principal > 0n ? quoteEthAdvance(principal, Number(market?.rate.apyBps ?? 500n), months, price.microUsd, yieldFeeBps) : null;
  const gemas = quote ? Number(quote.gemas) : 0;
  const estimate =
    quote && market && gemas > 0
      ? ethUnlockEstimateMs({
          source: { issued: quote.gemas, returned: 0n, redeemed: 0n, yieldUnits: 0n, unitNum: 10n ** 22n, unitDen: price!.microUsd },
          position: { heldShares: shares, principalUnderlying: principal, paidUnderlying: 0n, accrued: 0n },
          rate: market.rate,
          nowMs: now,
          yieldFeeBps,
        })
      : null;
  const tooMuch = !!market && shares > market.simEth;
  const tooBig = principal > MAX_PRINCIPAL_WEI;
  const valid = !!ctx && !!market && shares > 0n && !tooMuch && !tooBig && gemas > 0;
  const fee = market ? withHeadroom(market.quoteOpen) : 0n;
  // Mainnet: gas and the LayerZero fee are the Player's, shown here before anything is signed.
  const payOwn = playerPaysGas();
  const [cost, setCost] = useState<OpenCostQuote | null>(null);
  useEffect(() => {
    if (!payOwn || !market) return;
    let live = true;
    estimateOpenCost(net, market, shares).then((c) => live && setCost(c)).catch(() => live && setCost(null));
    return () => {
      live = false;
    };
  }, [payOwn, market, net, shares]);

  return (
    <OpenFormView
      chain={unit as "ETH" | "HYPE"}
      apy={market ? `${Number(market.rate.apyBps) / 100}% APY` : undefined}
      inert={!market}
      head={<EthFaucet vault={vault} />}
      amountText={text}
      onAmount={setText}
      amountInvalid={tooMuch || tooBig}
      max={market ? Number(market.simEth) / 1e18 : undefined}
      months={months}
      onMonths={setMonths}
      gemas={gemas}
      yieldText={`${quote ? fmtEth(quote.projectedUnits, 5) : "0"} ${unit}`}
      yieldFeeBps={yieldFeeBps}
      arrival="Position opens, Gemas in 2 to 5 min"
      estimate={estimate ? `${fmtWhen(estimate)} (${fmtInMinutes(estimate, now)})` : "—"}
      details={[
        ["Worth at issuance", fmtUsd(gemasToUsd(gemas))],
        ["Principal", `${fmtEth(principal)} ${unit}`],
        ["Projected yield (after the Yield Fee)", `${quote ? fmtEth(quote.projectedUnits, 5) : "—"} ${unit}`],
        ...(payOwn
          ? ([
              ["Network fee (gas, estimate)", cost ? `≈ ${fmtEth(cost.gasWei, 5)} ${unit}` : "—"],
              ["Cross-chain fee (LayerZero, you pay)", `≤ ${fmtEth(cost?.lzFeeWei ?? fee, 5)} ${unit}`],
              ["You pay in fees", cost ? `≈ ${fmtEth(cost.totalWei, 5)} ${unit}` : "—"],
            ] as [string, string][])
          : ([["Cross-chain fee", `≤ ${fmtEth(fee, 5)} ${unit}`]] as [string, string][])),
        ["Price feed", price ? `${unit} $${(Number(price.microUsd) / 1e6).toFixed(2)}${price.live ? "" : " (fallback)"}` : "unavailable"],
      ]}
      alerts={
        <>
          {tooMuch && <p className="status err" role="alert">That is more {vault.symbol} than you have.</p>}
          {tooBig && <p className="status err" role="alert">The Solana ledger holds Principal up to about 18 {unit}. Lock less.</p>}
          {step && a.busy && <p className="status" role="status"><ClockIcon width={14} height={14} /> {openStepText(vault)[step]}</p>}
          {a.error && <p className="status err" role="alert">{a.error}</p>}
        </>
      }
      note={
        <>
          You sign once to link your wallet, then approve and open on {net.label}. Once your Position reaches Tesoro, in about 2 to 5
          minutes, your Advance is taken while this page or your Wallet is open. The Unlock Estimate is an estimate, not a promise.{" "}
          <span className="sim">Simulated yield · 1 month = {ETH_SIM_MONTH_MIN} min</span>
        </>
      }
      buttonLabel={a.busy ? "Working…" : <GemasLabel action={`Open ${unit === "ETH" ? "an" : "a"} ${unit} Position`} gemas={gemas} />}
      disabled={!valid || a.busy !== null}
      onSubmit={() =>
        ctx &&
        void a.run("open", async () => {
          const opened = await openEthPosition(ctx, vault, shares, months, setStep);
          const op = addOp(ctx.signer.publicKey.toBase58(), { kind: "open", vault: opened.vault, id: opened.id.toString(), months, hash: opened.hash });
          setText("");
          onOpened(op.key);
          // The Account read behind the header, entry picker and Backing is fresh from the moment the Position opens.
          await refreshAccount();
        })
      }
    />
  );
}

// ---- Cross-chain trackers ---------------------------------------------------------------------------------

function useOps(address: string | null) {
  const [ops, setOps] = useState<EthOp[]>([]);
  useEffect(() => {
    if (!address) return;
    const read = () => setOps(loadOps(address));
    read();
    window.addEventListener(OPS_EVENT, read);
    return () => window.removeEventListener(OPS_EVENT, read);
  }, [address]);
  return address ? ops : [];
}

/**
 * Every ETH operation in flight (or just finished) for this Account, each driven from chain state. An ETH
 * Position recorded without its Advance is picked up here too, so the Advance continues on any Wallet visit.
 */
export function EthOps() {
  const ctx = useEthCtx();
  const { refresh, snapshot } = useAccount();
  const address = ctx?.signer.publicKey.toBase58() ?? null;
  const ops = useOps(address);
  useEffect(() => {
    if (!ctx || !address || !snapshot) return;
    let stopped = false;
    void (async () => {
      for (const p of untrackedOpens(snapshot.positions, loadOps(address))) {
        const s = await fetchEthState(getChain().base, p.vault, p.id, ctx.signer.publicKey).catch(() => null);
        const months = s?.bridge?.horizonMonths ?? 0;
        // Re-checked after the read: another pass may have started tracking it meanwhile.
        if (stopped || months === 0 || untrackedOpens([{ eth: p, status: "locked", advances: 0 }], loadOps(address)).length === 0) continue;
        addOp(address, { kind: "open", vault: p.vault, id: p.id.toString(), months });
      }
    })();
    return () => {
      stopped = true;
    };
  }, [ctx, address, snapshot]);
  if (!ctx || !address || ops.length === 0) return null;
  return (
    <>
      {ops.map((op) => (
        <EthOpCard key={op.key} op={op} ctx={ctx} address={address} onProgress={refresh} />
      ))}
    </>
  );
}

const POLL_MS = 9000;
const RETRY_MS = 20_000;

/** Drives one operation from chain state (and performs the relayed steps): shared by the Wallet card and the opening page. */
export function useOpTracker(op: EthOp, ctx: EthCtx, address: string, onProgress: () => Promise<unknown>) {
  const [stage, setStage] = useState(1);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanStatus | null>(null);
  const [snap, setSnap] = useState<EthState | null>(null);
  const busy = useRef(false);
  const lastTry = useRef(0);
  const opRef = useRef(op);
  useEffect(() => {
    opRef.current = op;
  });
  const steps = opSteps(op.kind, op.vault);
  const holder = ctx.signer.publicKey;

  useEffect(() => {
    if (op.done) return;
    let stopped = false;
    const tick = async () => {
      if (busy.current || stopped) return;
      busy.current = true;
      try {
        const cur = opRef.current;
        const id = BigInt(cur.id);
        const read = async () => {
          const [state, vp] = await Promise.all([
            fetchEthState(getChain().base, cur.vault, id, holder, cur.kind === "redeem" || cur.kind === "instant" ? cur.sourceIndex : undefined),
            cur.kind === "redeem" || cur.kind === "instant" || cur.kind === "unlock" ? fetchVaultPosition(cur.vault, id) : Promise.resolve(null),
          ]);
          const paidTo =
            (cur.kind === "redeem" || cur.kind === "instant") && state.holderEvm && cur.fromBlock !== undefined
              ? await fetchPaidTo(cur.vault, id, state.holderEvm, BigInt(cur.fromBlock), cur.kind === "instant" ? "InstantPaid" : "YieldPaid").catch(() => null)
              : null;
          return { state, progress: opProgress(cur, state, vp, paidTo) };
        };
        const first = await read();
        const state = first.state;
        let progress = first.progress;
        setSnap(state);
        setStage(progress.stage);
        if (!progress.next) setError(null);
        const scanKey = cur.kind === "open" || cur.kind === "yield" ? cur.hash : cur.sendSig;
        if (scanKey) fetchScanStatus(scanKey).then((s) => !stopped && setScan(s));
        if (progress.next && Date.now() - lastTry.current > RETRY_MS) {
          lastTry.current = Date.now();
          setNote(NEXT_NOTE(netOfVault(cur.vault).label)[progress.next]);
          try {
            await perform(progress.next, cur, ctx, state, address);
            setError(null);
          } catch (e) {
            setError(ethError(e));
          }
          setNote(null);
          const after = await read();
          progress = after.progress;
          setSnap(after.state);
          setStage(progress.stage);
        }
        if (progress.stage >= steps.length) {
          patchOp(address, cur.key, { done: true });
          await onProgress();
        }
      } catch (e) {
        setError(ethError(e));
      } finally {
        busy.current = false;
      }
    };
    void tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
    // The op object is re-read from a ref; its key identifies it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [op.key, op.done]);

  return { stage, note, error, scan, state: snap, finished: !!op.done || stage >= steps.length };
}

function EthOpCard({ op, ctx, address, onProgress }: { op: EthOp; ctx: EthCtx; address: string; onProgress: () => Promise<unknown> }) {
  const { stage, note, error, scan, finished } = useOpTracker(op, ctx, address, onProgress);
  const steps = opSteps(op.kind, op.vault);
  const copy = opCopy(op.kind, op.vault);
  const net = netOfVault(op.vault);
  const outbound = op.kind === "redeem" || op.kind === "instant" || op.kind === "unlock";
  const scanText = scan ? `Transfer: ${scan.name.toLowerCase()}` : op.hash || op.sendSig ? "Transfer: waiting for the first update" : null;

  return (
    <Card large as="section" aria-label={`${copy.label} progress`}>
      <div className="stack">
        <div className="spread">
          <span className="hstack">
            <ChainChip chain={net.native} />
            <strong>{titleOf(op)}</strong>
          </span>
          {finished && (
            <Button size="sm" onClick={() => removeOp(address, op.key)}>Dismiss</Button>
          )}
        </div>
        <CrossChainProgress
          stage={finished ? steps.length : stage}
          steps={steps}
          from={outbound ? "account" : net.native}
          to={outbound ? net.native : "account"}
          label={copy.label}
          finalState={copy.finalState}
          doneText={copy.done}
          pendingText={copy.pending}
          failedText={copy.failed}
        />
        {!finished && note && <p className="status" role="status"><ClockIcon width={14} height={14} /> {note}</p>}
        {!finished && !note && scanText && <p className="meta mono">{scanText}</p>}
        {error && !finished && <p className="status err" role="alert">{error} · retrying</p>}
        <Links
          vault={op.vault}
          evm={op.kind === "open" || op.kind === "yield" ? op.hash : (scan?.destinationTx ?? undefined)}
          scan={op.kind === "open" || op.kind === "yield" ? op.hash : op.sendSig}
          solana={op.kind === "redeem" || op.kind === "instant" || op.kind === "unlock" ? op.hash : undefined}
        />
        <span className="sim">Simulated · {opWords(op.vault).symbol} yield runs 1 month = {ETH_SIM_MONTH_MIN} min. Test mode.</span>
      </div>
    </Card>
  );
}

const NEXT_NOTE = (label: string) =>
  ({
    "apply-locked": "Recording your Position…",
    advance: "Taking your Advance at today’s price…",
    "apply-yield": "Applying the yield to your Debt…",
    "send-pay-yield": `Sending the payout to ${label}…`,
    "send-pay-instant": `Sending the payout to ${label}…`,
    "send-unlock": `Sending the unlock to ${label}…`,
  }) as const;

function titleOf(op: EthOp) {
  const { native } = opWords(op.vault);
  const a = native === "ETH" ? "an" : "a";
  return { open: `Opening ${a} ${native} Position`, yield: "Reporting yield", redeem: `Redeeming ${native}-Sourced Gemas`, instant: `Redeeming ${native}-Sourced Gemas now`, unlock: "Unlocking the Principal" }[op.kind];
}

/** One relayed step. The server skips a step that is already done (a keeper may have run it). */
async function perform(next: NonNullable<ReturnType<typeof opProgress>["next"]>, op: EthOp, ctx: EthCtx, state: EthState, address: string) {
  const ref = { vault: op.vault, id: op.id };
  if (next === "advance") {
    await takeEthAdvance(ctx, op.vault, BigInt(op.id), op.months ?? 1);
    return;
  }
  const pays = next === "send-pay-yield" || next === "send-pay-instant";
  const r = await ethCall<{ signature?: string }>(next, ctx, pays && op.sourceIndex !== undefined ? { ...ref, sourceIndex: op.sourceIndex } : ref);
  if (r.signature && (pays || next === "send-unlock")) patchOp(address, op.key, { sendSig: r.signature });
  void state;
}

// ---- Position card -----------------------------------------------------------------------------------------

export const ethRedeemables = (holdings: ChainHolding[]) => holdings.filter((h) => h.eth && h.redeemable > 0n);

export function EthPositionCard({ position, market }: { position: ChainPosition; market: EthMarket | null }) {
  const ctx = useEthCtx();
  const { snapshot, refresh } = useAccount();
  const a = useBusy();
  const now = useNow(5000);
  const ref = position.eth!;
  const vault = vaultByAddress(ref.vault) as EthVault | null;
  const net = netOfVault(ref.vault);
  const symbol = vault?.symbol ?? (net.native === "HYPE" ? "simHYPE" : "simETH");
  const [state, setState] = useState<EthState | null>(null);
  const [vp, setVp] = useState<VaultPosition | null>(null);
  const [rateMarket, setRateMarket] = useState<EthMarket | null>(market);
  const returnable = useReturnable(position);
  const [returning, setReturning] = useState(false);

  const load = useCallback(async () => {
    if (!ctx) return;
    try {
      const [s, v] = await Promise.all([fetchEthState(getChain().base, ref.vault, ref.id, ctx.signer.publicKey), fetchVaultPosition(ref.vault, ref.id)]);
      setState(s);
      setVp(v);
      if (!market && ctx.evm && vault) setRateMarket(await fetchEthMarket(vault, ctx.evm.address));
    } catch {
      // keep the last good read
    }
  }, [ctx, ref.vault, ref.id, market, vault]);
  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 14_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  const rate = (market ?? rateMarket)?.rate ?? null;
  const src = state?.source?.math ?? null;
  const onChainDebt = src ? debtGemas(src) : 0n;
  const debtWei = src ? debtUnits(src) : 0n;
  const accrued = vp?.accrued ?? 0n;
  const projected = projectedEthDebt(src, accrued);
  const unreported = onChainDebt - projected;
  const locked = (state?.core?.status ?? position.status) === "locked";
  const { yieldFeeBps } = useTreasuryRates();
  const estimate = rate && vp && src && onChainDebt > 0n ? ethUnlockEstimateMs({ source: src, position: vp, rate, nowMs: now, yieldFeeBps }) : null;
  const mine = (snapshot?.holdings ?? []).filter((h) => h.position.equals(position.address));
  const holding = mine.find((h) => h.redeemable > 0n && state?.source && h.source.equals(state.source.key)) ?? mine.find((h) => h.redeemable > 0n);
  const redeemable = holding?.redeemable ?? 0n;
  const payout = src && state?.source && holding?.source.equals(state.source.key) && redeemable > 0n ? redeemPayoutWei(src, redeemable) : 0n;
  // The claim is in the underlying asset; the vault pays it as simulated-token shares at its rate.
  const payoutShares = rate && payout > 0n ? (payout * WEI) / simRateAt(rate) : 0n;
  const canUnlock = locked && !!src && onChainDebt === 0n;
  const pendingOps = useOps(ctx?.signer.publicKey.toBase58() ?? null).filter((o) => !o.done && o.vault === ref.vault && o.id === ref.id.toString());
  const inFlight = pendingOps.length > 0;

  const address = ctx?.signer.publicKey.toBase58() ?? "";
  const report = () =>
    ctx &&
    vault &&
    a.run("report", async () => {
      const baseline = (state?.bridge?.lastYieldSeq ?? 0n).toString();
      const hash = await reportEthYield(ctx, vault, ref.id);
      addOp(address, { kind: "yield", vault: ref.vault, id: ref.id.toString(), hash, baseline });
    });
  const redeem = () =>
    ctx &&
    holding &&
    a.run("redeem", async () => {
      await redeemEthSource(ctx, address, ref, holding.source, redeemable);
      await refresh();
    });
  const unlock = () =>
    ctx &&
    a.run("unlock", async () => {
      const sig = await unlockEth(ctx.signer, position.address);
      addOp(address, { kind: "unlock", vault: ref.vault, id: ref.id.toString(), hash: sig });
      await refresh();
    });

  const series = rate && vp && src && onChainDebt > 0n && estimate ? linearSeries(Number(projected), now, estimate) : null;

  return (
    <PositionTile
      chain={net.native}
      label={`${net.native} Position`}
      state={!locked ? "unlocked" : !src ? "idle" : onChainDebt === 0n ? "paid" : "repaying"}
      principal={`${fmtEth(position.principal * 1e18, 4)} ${net.native}`}
      debt={!src ? null : onChainDebt > 0n ? `${fmtGemas(Number(onChainDebt))} Gemas` : "0"}
      debtAsset={onChainDebt > 0n ? `${fmtEth(debtWei, 4)} ${net.native}` : undefined}
      apy={`${netApyPct(position.apy * 10_000, yieldFeeBps).toFixed(1)}%`}
      yieldFeeBps={yieldFeeBps}
      unlockAt={estimate}
      now={now}
      series={series}
      notes={
        <>
          {redeemable > 0n && <p className="note">Redeem pays {fmtGemas(Number(redeemable))} {net.native}-Sourced Gemas → {payoutShares > 0n ? `${fmtEth(payoutShares, 5)} ${symbol}` : payout > 0n ? `${symbol} worth ${fmtEth(payout, 5)} ${net.native}` : symbol} (simulated) to your wallet on {net.label}.</p>}
          <p className="note">Accrued on {net.label} {fmtEth(accrued, 5)} {net.native} (simulated). Tesoro keeps {yieldFeeBps / 100}% of the yield (the Yield Fee), so this is your {100 - yieldFeeBps / 100}%.</p>
          {unreported > 0n && locked && (
            <p className="note">
              <ClockIcon width={12} height={12} /> ~{fmtGemas(Number(unreported))} Gemas of Debt are already repaid by yield accrued on {net.label}. Report yield to apply it (a small cross-chain fee).
            </p>
          )}
          {locked && !canUnlock && <p className="note">Unlock returns the Principal on {net.label} once Debt is zero. Only this Position&apos;s own yield repays it.</p>}
        </>
      }
    >
      {locked && (
        <>
          <Button size="sm" block disabled={!ctx || a.busy !== null || !src} onClick={report}>
            {a.busy === "report" ? "Reporting…" : "Report yield"}
          </Button>
          <div className="wl-actions-row">
            <Button variant="money" size="sm" disabled={!ctx || a.busy !== null || redeemable === 0n} onClick={redeem}>
              {a.busy === "redeem" ? "Redeeming…" : "Redeem"}
            </Button>
            <Button size="sm" disabled={!ctx || a.busy !== null || !canUnlock || inFlight} onClick={unlock}>
              {a.busy === "unlock" ? "Unlocking…" : "Unlock"}
            </Button>
          </div>
          {returnable > 0n && (
            <Button size="sm" block disabled={!ctx || a.busy !== null} onClick={() => setReturning(true)}>Return Gemas</Button>
          )}
          <ReturnOwnSheet position={position} open={returning} onClose={() => setReturning(false)} onReturned={load} />
        </>
      )}
      {a.error && <p className="status err" role="alert">{a.error}</p>}
    </PositionTile>
  );
}

// ---- Redeem rows (Wallet Redeem sheet) --------------------------------------------------------------------------

/** `redeem_to_evm` for one Source of an ETH or HYPE Position, then a tracker keyed to that Source's Claim and to this redemption's units. */
async function redeemEthSource(ctx: EthCtx, address: string, ref: { vault: string; id: bigint }, source: PublicKey, gemas: bigint) {
  const base = getChain().base;
  const holder = ctx.signer.publicKey;
  const head = await fetchEthState(base, ref.vault, ref.id, holder);
  const sourceIndex = head.core ? ethSourceIndex(head.core.position, source, head.core.advances) : null;
  if (sourceIndex === null) throw new Error("This Gemas holding is not from an Advance of this Position.");
  const [before, fromBlock] = await Promise.all([fetchEthState(base, ref.vault, ref.id, holder, sourceIndex), evmClient(netOfVault(ref.vault)).getBlockNumber()]);
  const sig = await redeemToEvm(ctx.signer, head.core!.position, source, gemas, ref.vault);
  const after = await fetchEthState(base, ref.vault, ref.id, holder, sourceIndex);
  const total = after.claim?.unitsTotal ?? 0n;
  addOp(address, { kind: "redeem", vault: ref.vault, id: ref.id.toString(), hash: sig, sourceIndex, baseline: total.toString(), units: (total - (before.claim?.unitsTotal ?? 0n)).toString(), fromBlock: fromBlock.toString() });
}

/**
 * Instant Redeem of won ETH- or HYPE-Sourced Gemas: `instant_redeem_to_evm` (the Treasury buys them and the bridge records the payout), then a
 * tracker keyed to this Source's Instant Claim; `send_pay_instant` and the vault's payout follow.
 */
export async function instantRedeemEthSource(ctx: EthCtx, ref: { vault: string; id: bigint }, source: PublicKey, gemas: bigint) {
  const base = getChain().base;
  const holder = ctx.signer.publicKey;
  const head = await fetchEthState(base, ref.vault, ref.id, holder);
  const sourceIndex = head.core ? ethSourceIndex(head.core.position, source, head.core.advances) : null;
  if (sourceIndex === null) throw new Error("This Gemas holding is not from an Advance of this Position.");
  const [before, fromBlock] = await Promise.all([fetchEthState(base, ref.vault, ref.id, holder, sourceIndex), evmClient(netOfVault(ref.vault)).getBlockNumber()]);
  await ensureEvmLinked(ctx);
  const sig = await instantRedeemToEvm(ctx.signer, head.core!.position, source, gemas, ref.vault);
  const after = await fetchEthState(base, ref.vault, ref.id, holder, sourceIndex);
  const total = after.instantClaim?.unitsTotal ?? 0n;
  addOp(ctx.signer.publicKey.toBase58(), { kind: "instant", vault: ref.vault, id: ref.id.toString(), hash: sig, sourceIndex, baseline: total.toString(), units: (total - (before.instantClaim?.unitsTotal ?? 0n)).toString(), fromBlock: fromBlock.toString() });
}

/** Redeems every ETH- and HYPE-Sourced holding the Account has redeemable: `redeem_to_evm`, then a tracker per Position. */
export async function redeemEthHoldings(ctx: EthCtx, holdings: ChainHolding[]): Promise<number> {
  const rows = ethRedeemables(holdings);
  if (rows.length === 0) return 0;
  // A holder who won ETH- or HYPE-Sourced Gemas may never have opened an ETH Position: the bridge pays to the linked EVM address.
  await ensureEvmLinked(ctx);
  const address = ctx.signer.publicKey.toBase58();
  for (const h of rows) await redeemEthSource(ctx, address, { vault: h.eth!.vault, id: h.eth!.id }, h.source, h.redeemable);
  return rows.length;
}

