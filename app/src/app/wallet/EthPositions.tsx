"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, ChainChip, Chip, ClockIcon, CrossChainProgress } from "@/components/ui";
import { OpenFormView } from "./OpenPanel";
import { PositionTile, linearSeries } from "./PositionTile";
import { useAccount } from "@/lib/account";
import { useAuth } from "@/lib/auth/context";
import { getChain } from "@/lib/chain/client";
import { debtGemas, debtUnits } from "@/lib/chain/ledger";
import {
  ETH_SIM_MONTH_MIN,
  ETH_VAULTS,
  MAX_PRINCIPAL_WEI,
  WEI,
  ethUnlockEstimateMs,
  fetchEthMarket,
  fetchEthState,
  fetchVaultPosition,
  fmtEth,
  hoodiTx,
  lzScanUrl,
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
  ethError,
  fetchEthPrice,
  getTestSimEth,
  openEthPosition,
  redeemToEvm,
  reportEthYield,
  takeEthAdvance,
  ethCall,
  unlockEth,
  type EthCtx,
  type OpenStep,
} from "@/lib/chain/eth-flow";
import {
  OPS_EVENT,
  OP_COPY,
  OP_STEPS,
  addOp,
  fetchScanStatus,
  loadOps,
  opProgress,
  patchOp,
  removeOp,
  type EthOp,
  type ScanStatus,
} from "@/lib/chain/eth-track";
import type { ChainHolding, ChainPosition } from "@/lib/chain/read";
import { fmtGemas, fmtUsd, fmtWhen, gemasToUsd } from "@/lib/format";

const solscan = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const VAULT = ETH_VAULTS[0];

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
  return `in ~${Math.round(s / 60)} min`;
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

function useEthMarket(evm: string | null) {
  const [market, setMarket] = useState<EthMarket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!evm) return;
    try {
      setMarket(await fetchEthMarket(VAULT, evm as `0x${string}`));
      setError(null);
    } catch (e) {
      setError(ethError(e));
    }
  }, [evm]);
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

function Links({ hoodi, scan, solana }: { hoodi?: string; scan?: string; solana?: string }) {
  return (
    <div className="stack">
      {hoodi && <a className="meta mono" href={hoodiTx(hoodi)} target="_blank" rel="noreferrer">Hoodi tx · {shortHex(hoodi)}</a>}
      {scan && <a className="meta mono" href={lzScanUrl(scan)} target="_blank" rel="noreferrer">LayerZero Scan · {shortHex(scan)}</a>}
      {solana && <a className="meta mono" href={solscan(solana)} target="_blank" rel="noreferrer">Solana tx · {solana.slice(0, 10)}…</a>}
    </div>
  );
}

// ---- Get simETH + Open an ETH Position ------------------------------------------------------------------

/** The simETH faucet, shown above the ETH open form: EVM address, gas and simETH balances, Get test simETH. */
export function EthFaucet() {
  const auth = useAuth();
  const ctx = useEthCtx();
  const { market, error: readError, refresh } = useEthMarket(auth.evm?.address ?? null);
  const a = useBusy();
  const [done, setDone] = useState<string | null>(null);
  const now = useNow(15_000);
  const cooling = market && market.faucetAvailableAt * 1000 > now;

  return (
    <div className="wl-faucet">
      <div className="spread">
        <span className="hstack">
          <ChainChip chain="ETH" />
          <span className="meta">Hoodi testnet</span>
        </span>
        <Chip tone="warn">Simulated</Chip>
      </div>
      <dl className="kv">
        <dt>Your EVM address</dt>
        <dd className="mono">{auth.evm ? shortHex(auth.evm.address) : "Creating your wallet…"}</dd>
        <dt>Hoodi ETH (gas)</dt>
        <dd className="tnum">{market ? fmtEth(market.ethBalance, 4) : "—"} ETH</dd>
        <dt>Your simETH</dt>
        <dd className="tnum">{market ? fmtEth(market.simEth, 3) : "—"} simETH</dd>
      </dl>
      <Button
        size="sm"
        block
        disabled={!ctx || a.busy !== null || !!cooling}
        onClick={() =>
          ctx &&
          void a.run("faucet", async () => {
            const hash = await getTestSimEth(ctx);
            setDone(hash);
            await refresh();
          })
        }
      >
        {a.busy === "faucet" ? "Getting simETH…" : cooling ? "Faucet cooling down" : "Get test simETH"}
      </Button>
      {done && <Links hoodi={done} />}
      {(a.error || readError) && <p className="status err" role="alert">{a.error ?? readError}</p>}
    </div>
  );
}

const OPEN_STEP_TEXT: Record<OpenStep, string> = {
  link: "Linking your EVM address to your Account…",
  gas: "Checking Hoodi gas…",
  approve: "Approving simETH…",
  inbox: "Preparing the Solana inbox for your Position…",
  open: "Opening the Position on Hoodi…",
};

/** The ETH tab of OPEN A POSITION: link, approve and open on Hoodi; the Advance follows once LayerZero delivers. */
export function EthOpenForm({ onOpened }: { onOpened: () => void }) {
  const ctx = useEthCtx();
  const { market } = useEthMarket(ctx?.evm.address ?? null);
  const a = useBusy();
  const [step, setStep] = useState<OpenStep | null>(null);
  const [text, setText] = useState("");
  const [months, setMonths] = useState(1);
  const [price, setPrice] = useState<{ microUsd: bigint; live: boolean } | null>(null);
  const now = useNow(5000);
  useEffect(() => {
    fetchEthPrice().then((p) => setPrice({ microUsd: p.priceMicroUsd, live: p.live })).catch(() => setPrice(null));
  }, []);

  const shares = /^\d*\.?\d{0,18}$/.test(text) && Number(text) > 0 ? BigInt(Math.round(Number(text) * 1e9)) * 10n ** 9n : 0n;
  const rate = market ? simRateAt(market.rate, now / 1000) : WEI;
  const principal = underlyingOf(shares, rate);
  const quote = price && principal > 0n ? quoteEthAdvance(principal, Number(market?.rate.apyBps ?? 500n), months, price.microUsd) : null;
  const gemas = quote ? Number(quote.gemas) : 0;
  const estimate =
    quote && market && gemas > 0
      ? ethUnlockEstimateMs({
          source: { issued: quote.gemas, returned: 0n, redeemed: 0n, yieldUnits: 0n, unitNum: 10n ** 22n, unitDen: price!.microUsd },
          position: { principalShares: shares, openRate: rate, accrued: 0n },
          rate: market.rate,
          nowMs: now,
        })
      : null;
  const tooMuch = !!market && shares > market.simEth;
  const tooBig = principal > MAX_PRINCIPAL_WEI;
  const valid = !!ctx && !!market && shares > 0n && !tooMuch && !tooBig && gemas > 0;
  const fee = market ? withHeadroom(market.quoteOpen) : 0n;

  return (
    <OpenFormView
      unit="ETH"
      inert={!market}
      head={<EthFaucet />}
      amountText={text}
      onAmount={setText}
      amountInvalid={tooMuch || tooBig}
      amountHint={market ? <>You have {fmtEth(market.simEth, 3)} simETH. Principal is locked, never played with.</> : undefined}
      months={months}
      onMonths={setMonths}
      gemas={gemas}
      estimate={estimate ? `${fmtWhen(new Date(estimate).toISOString())} (${inMinutes(estimate, now)})` : "—"}
      details={[
        ["Worth at issuance", fmtUsd(gemasToUsd(gemas))],
        ["Principal", `${fmtEth(principal)} ETH`],
        ["Projected yield", `${quote ? fmtEth(quote.projectedUnits, 5) : "—"} ETH`],
        ["LayerZero fee", `≤ ${fmtEth(fee, 5)} ETH`],
        ["Price feed", price ? `ETH $${(Number(price.microUsd) / 1e6).toFixed(2)}${price.live ? "" : " (fallback)"}` : "unavailable"],
      ]}
      alerts={
        <>
          {tooMuch && <p className="status err" role="alert">That is more simETH than you have.</p>}
          {tooBig && <p className="status err" role="alert">The Solana ledger holds Principal up to about 18 ETH. Lock less.</p>}
          {step && a.busy && <p className="status" role="status"><ClockIcon width={14} height={14} /> {OPEN_STEP_TEXT[step]}</p>}
          {a.error && <p className="status err" role="alert">{a.error}</p>}
        </>
      }
      note={
        <>
          You sign once to link your EVM address, then approve and open on Hoodi. The Advance follows automatically once the message
          reaches Solana, in about 2 to 5 minutes. The Unlock Estimate is an estimate, not a promise.{" "}
          <span className="sim">Simulated yield · 1 month = {ETH_SIM_MONTH_MIN} min</span>
        </>
      }
      buttonLabel={a.busy ? "Working…" : gemas > 0 ? `Open an ETH Position · ${fmtGemas(gemas)} Gemas` : "Open an ETH Position"}
      disabled={!valid || a.busy !== null}
      onSubmit={() =>
        ctx &&
        void a.run("open", async () => {
          const opened = await openEthPosition(ctx, VAULT, shares, months, setStep);
          addOp(ctx.signer.publicKey.toBase58(), { kind: "open", vault: opened.vault, id: opened.id.toString(), months, hash: opened.hash });
          setText("");
          onOpened();
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

/** Every ETH operation in flight (or just finished) for this Account, each driven from chain state. */
export function EthOps() {
  const ctx = useEthCtx();
  const { refresh } = useAccount();
  const address = ctx?.signer.publicKey.toBase58() ?? null;
  const ops = useOps(address);
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

function EthOpCard({ op, ctx, address, onProgress }: { op: EthOp; ctx: EthCtx; address: string; onProgress: () => Promise<void> }) {
  const [stage, setStage] = useState(1);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanStatus | null>(null);
  const busy = useRef(false);
  const lastTry = useRef(0);
  const opRef = useRef(op);
  useEffect(() => {
    opRef.current = op;
  });
  const steps = OP_STEPS[op.kind];
  const copy = OP_COPY[op.kind];
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
        const [state, vp] = await Promise.all([
          fetchEthState(getChain().base, cur.vault, id, holder),
          cur.kind === "redeem" || cur.kind === "unlock" ? fetchVaultPosition(cur.vault, id) : Promise.resolve(null),
        ]);
        let progress = opProgress(cur, state, vp);
        setStage(progress.stage);
        if (!progress.next) setError(null);
        const scanKey = cur.kind === "open" || cur.kind === "yield" ? cur.hash : cur.sendSig;
        if (scanKey) fetchScanStatus(scanKey).then((s) => !stopped && setScan(s));
        if (progress.next && Date.now() - lastTry.current > RETRY_MS) {
          lastTry.current = Date.now();
          setNote(NEXT_NOTE[progress.next]);
          try {
            await perform(progress.next, cur, ctx, state, address);
            setError(null);
          } catch (e) {
            setError(ethError(e));
          }
          setNote(null);
          const after = await fetchEthState(getChain().base, cur.vault, id, holder);
          progress = opProgress(cur, after, vp);
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

  const finished = op.done || stage >= steps.length;
  const scanText = scan ? `LayerZero: ${scan.name.toLowerCase()}` : op.hash || op.sendSig ? "LayerZero: waiting for Scan" : null;

  return (
    <Card large as="section" aria-label={`${copy.label} progress`}>
      <div className="stack">
        <div className="spread">
          <span className="hstack">
            <ChainChip chain="ETH" />
            <strong>{titleOf(op)}</strong>
          </span>
          {finished && (
            <Button size="sm" onClick={() => removeOp(address, op.key)}>Dismiss</Button>
          )}
        </div>
        <CrossChainProgress
          stage={finished ? steps.length : stage}
          steps={steps}
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
          hoodi={op.kind === "open" || op.kind === "yield" ? op.hash : (scan?.destinationTx ?? undefined)}
          scan={op.kind === "open" || op.kind === "yield" ? op.hash : op.sendSig}
          solana={op.kind === "redeem" || op.kind === "unlock" ? op.hash : undefined}
        />
        <span className="sim">Simulated · simETH yield runs 1 month = {ETH_SIM_MONTH_MIN} min. Testnets only.</span>
      </div>
    </Card>
  );
}

const NEXT_NOTE = {
  "apply-locked": "Opening your Position on Solana (apply_locked)…",
  advance: "Taking your Advance at the oracle price…",
  "apply-yield": "Applying the yield on Solana (apply_yield)…",
  "send-pay-yield": "Sending the payout to Hoodi (send_pay_yield)…",
  "send-unlock": "Sending the unlock to Hoodi (send_unlock)…",
} as const;

function titleOf(op: EthOp) {
  return { open: "Opening an ETH Position", yield: "Reporting yield", redeem: "Redeeming ETH-Sourced Gemas", unlock: "Unlocking the Principal" }[op.kind];
}

/** One relayed step. The server skips a step that is already done (a keeper may have run it). */
async function perform(next: NonNullable<ReturnType<typeof opProgress>["next"]>, op: EthOp, ctx: EthCtx, state: EthState, address: string) {
  const ref = { vault: op.vault, id: op.id };
  if (next === "advance") {
    await takeEthAdvance(ctx, op.vault, BigInt(op.id), op.months ?? 1);
    return;
  }
  const r = await ethCall<{ signature?: string }>(next, ctx, ref);
  if (r.signature && (next === "send-pay-yield" || next === "send-unlock")) patchOp(address, op.key, { sendSig: r.signature });
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
  const [state, setState] = useState<EthState | null>(null);
  const [vp, setVp] = useState<VaultPosition | null>(null);
  const [rateMarket, setRateMarket] = useState<EthMarket | null>(market);

  const load = useCallback(async () => {
    if (!ctx) return;
    try {
      const [s, v] = await Promise.all([fetchEthState(getChain().base, ref.vault, ref.id, ctx.signer.publicKey), fetchVaultPosition(ref.vault, ref.id)]);
      setState(s);
      setVp(v);
      if (!market && ctx.evm) setRateMarket(await fetchEthMarket(VAULT, ctx.evm.address));
    } catch {
      // keep the last good read
    }
  }, [ctx, ref.vault, ref.id, market]);
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
  const estimate = rate && vp && src && onChainDebt > 0n ? ethUnlockEstimateMs({ source: src, position: vp, rate, nowMs: now }) : null;
  const holding = (snapshot?.holdings ?? []).find((h) => h.position.equals(position.address) && state?.source && h.source.equals(state.source.key));
  const redeemable = holding?.redeemable ?? 0n;
  const payout = src && redeemable > 0n ? redeemPayoutWei(src, redeemable) : 0n;
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
    state?.source &&
    a.run("redeem", async () => {
      const sig = await redeemToEvm(ctx.signer, position.address, state.source!.key, redeemable);
      const [after, v] = await Promise.all([fetchEthState(getChain().base, ref.vault, ref.id, ctx.signer.publicKey), fetchVaultPosition(ref.vault, ref.id)]);
      const pending = after.claim ? after.claim.unitsTotal - after.claim.unitsSent : 0n;
      addOp(address, { kind: "redeem", vault: ref.vault, id: ref.id.toString(), hash: sig, baseline: ((v?.paidUnderlying ?? 0n) + pending).toString() });
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
      chain="ETH"
      label="ETH Position"
      status={locked ? "active" : "unlocked"}
      rows={{
        principal: `${fmtEth(position.principal * 1e18, 4)} ETH`,
        debt: onChainDebt > 0n ? `${fmtGemas(Number(onChainDebt))} Gemas · ${fmtEth(debtWei, 4)} ETH` : "0",
        apy: `${(position.apy * 100).toFixed(1)}%`,
        unlock: !locked
          ? "Unlocked"
          : !src
            ? "No open Advance"
            : onChainDebt === 0n
              ? "Debt is zero"
              : estimate
                ? `${fmtWhen(new Date(estimate).toISOString()).replace(" UTC", "")} (${inMinutes(estimate, now)})`
                : "Once yield accrues",
      }}
      chartTitle="Debt (Gemas)"
      series={series}
      fmt={(n) => fmtGemas(n)}
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
        </>
      )}
      {redeemable > 0n && <p className="note wl-tile-note">Redeem pays {fmtGemas(Number(redeemable))} ETH-Sourced Gemas → {fmtEth(payout, 5)} simETH (Simulated) to your EVM address on Hoodi.</p>}
      <p className="note wl-tile-note">Accrued on Hoodi {fmtEth(accrued, 5)} ETH. <span className="sim">Simulated yield · 1 month = {ETH_SIM_MONTH_MIN} min</span></p>
      {unreported > 0n && locked && (
        <p className="note wl-tile-note">
          <ClockIcon width={12} height={12} /> ~{fmtGemas(Number(unreported))} Gemas of Debt are already repaid by yield accrued on Hoodi. Report yield to bring it to Solana (a small LayerZero fee).
        </p>
      )}
      {locked && !canUnlock && <p className="note wl-tile-note">Unlock returns the Principal on Hoodi once Debt is zero. Only this Position&apos;s own yield repays it.</p>}
      {a.error && <p className="status err" role="alert">{a.error}</p>}
    </PositionTile>
  );
}

// ---- Redeem rows (Wallet Redeem sheet) --------------------------------------------------------------------------

/** Redeems every ETH-Sourced holding the Account has redeemable: `redeem_to_evm`, then a tracker per Position. */
export async function redeemEthHoldings(ctx: EthCtx, holdings: ChainHolding[]): Promise<number> {
  const rows = ethRedeemables(holdings);
  const base = getChain().base;
  const address = ctx.signer.publicKey.toBase58();
  for (const h of rows) {
    const sig = await redeemToEvm(ctx.signer, h.position, h.source, h.redeemable);
    const [after, v] = await Promise.all([fetchEthState(base, h.eth!.vault, h.eth!.id, ctx.signer.publicKey), fetchVaultPosition(h.eth!.vault, h.eth!.id)]);
    const pending = after.claim ? after.claim.unitsTotal - after.claim.unitsSent : 0n;
    addOp(address, { kind: "redeem", vault: h.eth!.vault, id: h.eth!.id.toString(), hash: sig, baseline: ((v?.paidUnderlying ?? 0n) + pending).toString() });
  }
  return rows.length;
}

