import "./polyfill";
import { PublicKey, Transaction } from "@solana/web3.js";
import { maxUint256, parseEventLogs, type Address, type Hex } from "viem";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import type { EvmSigner } from "@/lib/auth/types";
import { parseTreasury } from "./fees";
import { treasuryPda } from "./native";
import { prevAdvanceOf, sourceAccounts } from "./redeem";
import type { ChainHolding } from "./read";
import { getChain } from "./client";
import { sendSponsoredOrOwn } from "./sponsored-or-own";
import { DemoError, type GetToken } from "./demo-client";
import {
  ETH_VAULTS,
  advanceFloorOf,
  corePositionPda,
  ethPositionId,
  parseCorePosition,
  quoteEthAdvance,
  coreAccountPda,
  fetchEthState,
  fetchVaultPosition,
  projectedEthDebt,
  vaultByAddress,
  NETS,
  coreUnlockIx,
  evmClient,
  fetchEthMarket,
  fetchLinkState,
  linkEvmIx,
  linkMessage,
  lstAbi,
  netOfVault,
  redeemToEvmIx,
  setEvmAddressIx,
  vaultAbi,
  withHeadroom,
  type EthMarket,
  type EthVault,
  type EvmNet,
} from "./eth";
import { ensureReady } from "./match-flow";
import { newNonce, signedMessage, type SignedFields } from "./signed-request";
import { plainError } from "@/lib/errors";
import { NATIVE_OPEN_GAS, nativeOpenValue, quoteNativeStake, zapAbi, rateSourceAbi, kinetiqZapAbi } from "./eth-native";
import { debtGemas } from "./ledger";
import { addOp, loadOps, patchOp } from "./eth-track";
import { REPORT_POLL_MS, REPORT_WAIT_MS, planReport, reportApplied, type ReportAction } from "./eth-report";
import { assertCanAffordOpen, playerPaysGas, quoteOpenCost, type OpenCostQuote } from "./eth-fee";

/** What the ETH and HYPE flows need: the Account's Solana signer, its EVM wallet, and the Privy token for server routes. */
export interface EthCtx {
  signer: ChainSigner;
  evm: EvmSigner;
  getToken: GetToken;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/**
 * Calls the server relay (`/api/eth-bridge`): Hoodi top-up, permissionless bridge steps, the oracle-priced Advance.
 * The Solana wallet signs the whole request with a single-use nonce (src/lib/chain/signed-request.ts).
 */
export async function ethCall<T = Record<string, unknown>>(step: string, ctx: Pick<EthCtx, "signer" | "getToken">, body: SignedFields = {}): Promise<T> {
  const address = ctx.signer.publicKey.toBase58();
  const ts = Date.now();
  const nonce = newNonce();
  const signature = await ctx.signer.signMessage(new TextEncoder().encode(signedMessage("tesoro-eth", step, address, ts, nonce, body)));
  const token = await ctx.getToken().catch(() => null);
  const res = await fetch("/api/eth-bridge", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ step, address, ts, nonce, signature: b64(signature), ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new DemoError(json.error ?? `Request failed (${res.status})`, json.code ?? "error", res.status);
  return json as T;
}

/** The price an Advance on an ETH or HYPE Position is issued at (public route). */
export async function fetchEthPrice(asset: EvmNet["native"] = "ETH"): Promise<{ priceMicroUsd: bigint; live: boolean }> {
  const res = await fetch(`/api/eth-bridge?asset=${asset}`);
  if (!res.ok) throw new Error("price unavailable");
  const j = (await res.json()) as { priceMicroUsd: string; live: boolean };
  return { priceMicroUsd: BigInt(j.priceMicroUsd), live: j.live };
}

/** The message a wallet rejected, else the first line. */
export function ethError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const err = e as { shortMessage?: string; code?: number; name?: string };
  if (err?.name === "UserRejectedRequestError" || err?.code === 4001) return "Wallet request was rejected.";
  if (/exceeds defined limit|rate limited|took too long to respond|unknown RPC error/i.test(`${err?.shortMessage ?? ""} ${text}`)) return "The network is busy right now. Wait a few seconds and try again.";
  if (err?.shortMessage) return err.shortMessage.split("\n")[0].slice(0, 200);
  return plainError(e);
}

async function waitEvm(hash: Hex, net: EvmNet) {
  const receipt = await evmClient(net).waitForTransactionReceipt({ hash, timeout: 120_000, pollingInterval: 1000 });
  if (receipt.status !== "success") throw new Error(`The ${net.label} transaction reverted.`);
  return receipt;
}

// ---- Account link -------------------------------------------------------------------------------

/**
 * First ETH action: makes sure the Account exists, points it at the wallet's EVM address and links the
 * address with an EIP-191 signature the bridge recovers on chain (docs/cross-chain.md). Idempotent.
 * Returns the Solana signature, or null when the address was already linked.
 */
export async function ensureEvmLinked(ctx: EthCtx): Promise<string | null> {
  await ensureReady(ctx.signer, ctx.getToken);
  const base = getChain().base;
  const state = await fetchLinkState(base, ctx.signer.publicKey, ctx.evm.address);
  if (state.linked && state.addressSet) return null;
  await ctx.evm.prepare();
  const signature = await ctx.evm.client.signMessage({
    account: ctx.evm.account,
    message: linkMessage(coreAccountPda(ctx.signer.publicKey)),
  });
  // Each step alone, so the relayer can pay: a Player with only ETH or HYPE needs no SOL to link.
  const me = ctx.signer.publicKey;
  if (!state.addressSet) await sendSponsoredOrOwn(ctx.signer, ctx.getToken, async () => [setEvmAddressIx(me, ctx.evm.address)]);
  return sendSponsoredOrOwn(ctx.signer, ctx.getToken, async (payer) => [linkEvmIx(me, ctx.evm.address, signature, payer)]);
}

// ---- Gas ------------------------------------------------------------------------------------------

/** Below this the server tops a Hoodi wallet up (gas for approve + openPosition, plus the LayerZero fee). */
export const MIN_HOODI_WEI = 4_000_000_000_000_000n;
/** HyperEVM: gas is cheap (0.1 gwei); the LayerZero message is about 0.0075 HYPE (plus 20% headroom, refunded). */
export const MIN_HYPE_WEI = 20_000_000_000_000_000n;

/** Gas price and LayerZero fee for opening, as the Player sees them before signing. */
export async function estimateOpenCost(net: EvmNet, market: Pick<EthMarket, "quoteOpen" | "allowance">, amountWei: bigint, native = false): Promise<OpenCostQuote> {
  const gasPriceWei = await evmClient(net).getGasPrice();
  return quoteOpenCost({ lzQuoteWei: market.quoteOpen, gasPriceWei, needsApprove: !native && market.allowance < amountWei, gasUnits: native ? NATIVE_OPEN_GAS : undefined });
}

/** What staking the plain coin yields right now: the vault's rate and, for Kinetiq, its minimum stake. */
export async function fetchNativeTerms(vault: EthVault): Promise<{ rate: bigint; minStakeWei: bigint }> {
  const c = evmClient(NETS[vault.net]);
  const source = await c.readContract({ address: vault.address, abi: rateSourceAbi, functionName: "rateSource" });
  const rate = await c.readContract({ address: source, abi: rateSourceAbi, functionName: "underlyingPerShare" });
  const minStakeWei = vault.zap && vault.net === "hyperevm" ? await c.readContract({ address: vault.zap, abi: kinetiqZapAbi, functionName: "minStake" }).catch(() => 0n) : 0n;
  return { rate, minStakeWei };
}

/** Asks the server for the net's native token (capped, from the relayer: the key never reaches the client). Resolves once it is sent. */
export const sendGasRequest = (ctx: EthCtx, net: EvmNet) => ethCall(net.key === "hoodi" ? "fund-evm" : "fund-hype", ctx, { evm: ctx.evm.address });

const gasInFlight = new Map<string, Promise<void>>();

/** Capped server-side top-up of the net's native token, then waits for the balance to show. A second call while one is running shares it. */
export function requestGas(ctx: EthCtx, net: EvmNet): Promise<void> {
  if (playerPaysGas()) return Promise.reject(new Error(`Add ${net.native} to your wallet to pay for gas and the cross-chain fee.`));
  const id = `${net.key}:${ctx.evm.address.toLowerCase()}`;
  const running = gasInFlight.get(id);
  if (running) return running;
  const min = net.key === "hoodi" ? MIN_HOODI_WEI : MIN_HYPE_WEI;
  const client = evmClient(net);
  const run = (async () => {
    await sendGasRequest(ctx, net);
    for (let i = 0; i < 40; i++) {
      if ((await client.getBalance({ address: ctx.evm.address })) >= min) return;
      await sleep(1000);
    }
    throw new Error(`${net.native} has not arrived yet. Try again in a moment.`);
  })().finally(() => gasInFlight.delete(id));
  gasInFlight.set(id, run);
  return run;
}

/** Tops the wallet up when it is under the net's minimum. */
export async function ensureGas(ctx: EthCtx, net: EvmNet, minWei = net.key === "hoodi" ? MIN_HOODI_WEI : MIN_HYPE_WEI): Promise<void> {
  if (playerPaysGas()) return; // mainnet: the Player pays; the quote check in openEthPosition says what is missing
  if ((await evmClient(net).getBalance({ address: ctx.evm.address })) >= minWei) return;
  await requestGas(ctx, net);
}

// ---- simETH / simHYPE and the Position -----------------------------------------------------------------------

/** SIMULATED faucet: simETH / simHYPE is a test token (10 per hour per address). The relayer claims it for the wallet: no signature, no gas. */
export async function getTestSimEth(ctx: EthCtx, vault: EthVault = ETH_VAULTS[0]): Promise<Hex> {
  const r = await ethCall<{ hash: Hex }>("faucet-lst", ctx, { vault: vault.address, evm: ctx.evm.address });
  return r.hash;
}

export type OpenStep = "link" | "gas" | "approve" | "confirm" | "inbox" | "open" | "opening";

export interface OpenedEth {
  vault: Address;
  id: bigint;
  hash: Hex;
  linkSig: string | null;
}

/**
 * Link (first time), gas, approve, create the inbox record for the next Position id, then
 * `openPosition(amount, Horizon)` paying the LayerZero fee (quote + 20%, the excess is refunded).
 * The inbox record does not depend on the approval, so the server prepares it while the wallet approves.
 * Resolves once the EVM transaction is confirmed; the caller tracks delivery from there.
 */
export async function openEthPosition(
  ctx: EthCtx,
  vault: EthVault,
  amountWei: bigint,
  months: number,
  onStep: (s: OpenStep) => void = () => {},
  /** Open with the plain coin: `amountWei` is the coin to stake, staked and locked by the vault's zap in one transaction. */
  native = false,
): Promise<OpenedEth> {
  const net = NETS[vault.net];
  if (native && !vault.zap) throw new Error(`Opening with ${net.native} is not available yet.`);
  onStep("link");
  const linkSig = await ensureEvmLinked(ctx);
  onStep("gas");
  await ensureGas(ctx, net);
  const market: EthMarket = await fetchEthMarket(vault, ctx.evm.address, undefined, getChain().base);
  if (native) {
    if (market.ethBalance < nativeOpenValue(amountWei, withHeadroom(market.quoteOpen))) throw new Error(`That is more ${net.native} than you have after fees.`);
  } else if (market.simEth < amountWei) throw new Error(`That is more ${vault.symbol} than you have.`);
  // Mainnet: the Player pays gas and the LayerZero fee (the form shows them before Open); stop here if the wallet is short.
  // Opening with the coin: the stake itself also comes out of the balance.
  if (playerPaysGas()) assertCanAffordOpen(native ? market.ethBalance - amountWei : market.ethBalance, await estimateOpenCost(net, market, amountWei, native), net.native);
  await ctx.evm.prepare(net.chain);
  const wallet = ctx.evm.clientFor(net.chain);
  // The inbox record has to exist before the message arrives: create it for the id this transaction should get.
  const predicted = market.nextPositionId + 1n;
  const inbox = ethCall("init-position", ctx, { vault: vault.address, id: predicted.toString() });
  inbox.catch(() => {});
  if (!native && market.allowance < amountWei) {
    onStep("approve");
    const approveHash = await wallet.writeContract({
      account: ctx.evm.account,
      chain: undefined,
      address: vault.lst,
      abi: lstAbi,
      functionName: "approve",
      args: [vault.address, maxUint256],
    });
    onStep("confirm");
    await waitEvm(approveHash, net);
  }
  onStep("inbox");
  await inbox;
  onStep("open");
  let hash: Hex;
  if (native) {
    // One transaction: stake the coin, lock the token, pay the LayerZero fee. A revert anywhere leaves the coin in the wallet.
    const terms = await fetchNativeTerms(vault);
    const q = quoteNativeStake({ stakeWei: amountWei, rate: terms.rate, minStakeWei: terms.minStakeWei });
    hash = await wallet.writeContract({
      account: ctx.evm.account,
      chain: undefined,
      address: vault.zap!,
      abi: zapAbi,
      functionName: "openWithNative",
      args: [amountWei, q.minLst, months],
      value: nativeOpenValue(amountWei, withHeadroom(market.quoteOpen)),
    });
  } else {
    hash = await wallet.writeContract({
      account: ctx.evm.account,
      chain: undefined,
      address: vault.address,
      abi: vaultAbi,
      functionName: "openPosition",
      args: [amountWei, months],
      value: withHeadroom(market.quoteOpen),
    });
  }
  onStep("opening");
  const receipt = await waitEvm(hash, net);
  const logs = parseEventLogs({ abi: vaultAbi, eventName: "PositionLocked", logs: receipt.logs });
  const id = logs.find((l) => l.address.toLowerCase() === vault.address.toLowerCase())?.args.positionId;
  if (id === undefined) throw new Error("Lock started, but its id was not in the receipt.");
  // Someone else opened one in between: the message for the real id still needs its inbox record (delivery retries).
  if (id !== predicted) await ethCall("init-position", ctx, { vault: vault.address, id: id.toString() });
  return { vault: vault.address, id, hash, linkSig };
}

/**
 * Anyone may call it; the caller pays the LayerZero fee. Resolves once confirmed on the vault's chain.
 * Mainnet path of `freshenYield` (the Player's own EVM wallet pays; test mode has the relayer send it instead). Reverts
 * After a slashing it repeats the highest yield already reported; the Treasury figures still go out.
 */
export async function reportEthYield(ctx: EthCtx, vault: EthVault, id: bigint): Promise<Hex> {
  const net = NETS[vault.net];
  await ensureGas(ctx, net);
  const market = await fetchEthMarket(vault, ctx.evm.address);
  await ctx.evm.prepare(net.chain);
  const hash = await ctx.evm.clientFor(net.chain).writeContract({
    account: ctx.evm.account,
    chain: undefined,
    address: vault.address,
    abi: vaultAbi,
    functionName: "reportYield",
    args: [id],
    value: withHeadroom(market.quoteYield),
  });
  await waitEvm(hash, net);
  return hash;
}

/**
 * The first step of Redeem, Instant Redeem and Unlock on an ETH or HYPE Position (ADR 0010): when the vault's live yield is
 * ahead of what Solana has and the action would gain from it, asks for a Yield Report and waits until it is applied on
 * Solana. Test mode: the relayer sends the request. Mainnet: the Player's own EVM wallet does. A report already asked for
 * or arrived is not asked for twice. Resolves true once a report was applied, false when none was needed. Leaving is safe: the report still lands and is applied. Gives up after
 * `REPORT_WAIT_MS` with a retryable message.
 */
export async function freshenYield(
  ctx: EthCtx,
  args: { vault: string; id: bigint; action: ReportAction; waitingGemas?: bigint; treasuryBehind?: boolean; onStatus?: (note: string | null) => void },
): Promise<boolean> {
  const { vault, id, action, onStatus } = args;
  const base = getChain().base;
  const holder = ctx.signer.publicKey;
  const address = holder.toBase58();
  const net = netOfVault(vault);
  const read = () => fetchEthState(base, vault, id, holder);
  const [state, vp] = await Promise.all([read(), fetchVaultPosition(vault, id)]);
  if (!vp || vp.unlocked) return false;
  const math = state.source?.math ?? null;
  const recentOp = loadOps(address).find((o) => o.kind === "yield" && o.vault.toLowerCase() === vault.toLowerCase() && o.id === id.toString() && o.baseline !== undefined);
  const plan = planReport({
    action,
    bridge: state.bridge,
    liveAccrued: vp.accrued,
    onChainDebt: math ? debtGemas(math) : 0n,
    projectedDebt: projectedEthDebt(math, vp.accrued),
    waitingGemas: args.waitingGemas ?? 0n,
    treasuryBehind: args.treasuryBehind,
    recent: recentOp ? { baseline: BigInt(recentOp.baseline!), at: recentOp.createdAt } : null,
    now: Date.now(),
  });
  if (plan.kind === "none") return false;
  onStatus?.(`Getting the latest yield from ${net.label}… usually a minute or two`);
  let baseline: bigint;
  let opKey: string | null = recentOp?.key ?? null;
  if (plan.kind === "wait") baseline = plan.baseline;
  else if (plan.kind === "apply") baseline = state.bridge!.appliedYieldSeq;
  else {
    baseline = state.bridge!.lastYieldSeq;
    let hash: string | undefined;
    if (playerPaysGas()) {
      const vaultInfo = vaultByAddress(vault);
      if (!vaultInfo) throw new Error("This Lock is on a contract the app no longer lists.");
      hash = await reportEthYield(ctx, vaultInfo, id);
    } else {
      try {
        hash = (await ethCall<{ hash: Hex }>("report-yield", ctx, { vault, id: id.toString() })).hash;
      } catch (e) {
        // Another tab or device asked a moment ago: wait for that one.
        if (!(e instanceof DemoError && e.code === "report-pending")) throw e;
      }
    }
    if (hash) opKey = addOp(address, { kind: "yield", vault, id: id.toString(), hash, baseline: baseline.toString() }).key;
  }
  const deadline = Date.now() + REPORT_WAIT_MS;
  let lastApply = 0;
  while (Date.now() < deadline) {
    await sleep(REPORT_POLL_MS);
    const s = await read().catch(() => null);
    if (!s?.bridge) continue;
    if (reportApplied(s.bridge, baseline)) {
      if (opKey) patchOp(address, opKey, { done: true });
      onStatus?.(null);
      return true;
    }
    // The keeper normally applies an arrived report; if it has not within a moment, the relay does.
    if (s.bridge.lastYieldSeq > s.bridge.appliedYieldSeq && Date.now() - lastApply > 15_000) {
      lastApply = Date.now();
      await ethCall("apply-yield", ctx, { vault, id: id.toString() }).catch(() => undefined);
    }
  }
  onStatus?.(null);
  throw new Error(`The latest yield from ${net.label} has not arrived yet. It is still on its way and will be applied by itself; try again in a minute.`);
}

// ---- Solana side ------------------------------------------------------------------------------------

/**
 * The Advance for an ETH or HYPE Position: the server signs `take_advance` at the oracle price with `min_gemas` set to its own quote, and the
 * Account co-signs only after it quotes the same Gemas from the Position, the Treasury's Yield Fee and the price the server used.
 */
export async function takeEthAdvance(ctx: Pick<EthCtx, "signer" | "getToken">, vault: string, id: bigint, months: number): Promise<string> {
  const r = await ethCall<{ transaction: string; priceMicroUsd: string }>("advance", ctx, { vault, id: id.toString(), months });
  const tx = Transaction.from(Uint8Array.from(atob(r.transaction), (c) => c.charCodeAt(0)));
  const base = getChain().base;
  const position = corePositionPda(ethPositionId(vault, id));
  const [pos, treasury] = await Promise.all([base.getAccountInfo(position), base.getAccountInfo(treasuryPda())]);
  const rates = treasury ? parseTreasury(treasury.data) : null;
  if (!pos || !rates) throw new Error("Your Lock or the fees could not be read. Try again in a moment.");
  const core = parseCorePosition(position, pos.data);
  const mine = quoteEthAdvance(core.principalWei, core.rateBps, months, BigInt(r.priceMicroUsd)).gemas;
  if (advanceFloorOf(tx.instructions[0].data) !== mine || mine <= 0n) throw new Error("The Advance did not match your quote, so it was not signed. Try again.");
  return getChain().sendSigned(await ctx.signer.signTransaction(tx));
}

/** `redeem_to_evm`: redeems Gemas of one line of an ETH or HYPE Source and records the payout owed on its EVM chain. Then `send_pay_yield` delivers it. */
export async function redeemToEvm(signer: ChainSigner, h: Pick<ChainHolding, "line" | "accounts" | "source" | "position">, gemas: bigint, vault: string) {
  const { accounts, create } = await sourceAccounts(getChain().base, h.source, h.accounts, signer.publicKey);
  return getChain().sendBase(signer, [...create, redeemToEvmIx(signer.publicKey, h.position, h.source, gemas, netOfVault(vault), { line: h.line, accounts })]);
}

/** Debt must be zero on chain. Then `send_unlock` releases the Principal on the vault's chain. The Position's open Advance is closed here. */
export async function unlockEth(signer: ChainSigner, position: PublicKey, openAdvance: number | null = null) {
  const { prev, create } = await prevAdvanceOf(getChain().base, position, openAdvance, signer.publicKey);
  return getChain().sendBase(signer, [...create, coreUnlockIx(signer.publicKey, position, prev)]);
}
