import "./polyfill";
import { PublicKey, Transaction } from "@solana/web3.js";
import { maxUint256, parseEventLogs, type Address, type Hex } from "viem";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import type { EvmSigner } from "@/lib/auth/types";
import { getChain } from "./client";
import { DemoError, type GetToken } from "./demo-client";
import {
  ETH_VAULTS,
  coreAccountPda,
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
  const m = /Error Message: ([^\n]+)/.exec(text);
  if (m) return m[1].replace(/\.$/, "");
  return text.split("\n")[0].replace(/^base tx failed \S+: /, "").slice(0, 200);
}

async function waitEvm(hash: Hex, net: EvmNet) {
  const receipt = await evmClient(net).waitForTransactionReceipt({ hash, timeout: 120_000 });
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
  const ixs = [];
  if (!state.addressSet) ixs.push(setEvmAddressIx(ctx.signer.publicKey, ctx.evm.address));
  ixs.push(linkEvmIx(ctx.signer.publicKey, ctx.evm.address, signature));
  return getChain().sendBase(ctx.signer, ixs);
}

// ---- Gas ------------------------------------------------------------------------------------------

/** Below this the server tops a Hoodi wallet up (gas for approve + openPosition, plus the LayerZero fee). */
export const MIN_HOODI_WEI = 4_000_000_000_000_000n;
/** HyperEVM: gas is cheap (0.1 gwei); the LayerZero message is about 0.0075 HYPE (plus 20% headroom, refunded). */
export const MIN_HYPE_WEI = 20_000_000_000_000_000n;

/** Capped server-side top-up of the net's native token from the relayer (the key never reaches the client). */
export async function requestGas(ctx: EthCtx, net: EvmNet): Promise<void> {
  const min = net.key === "hoodi" ? MIN_HOODI_WEI : MIN_HYPE_WEI;
  const client = evmClient(net);
  await ethCall(net.key === "hoodi" ? "fund-evm" : "fund-hype", ctx, { evm: ctx.evm.address });
  for (let i = 0; i < 40; i++) {
    if ((await client.getBalance({ address: ctx.evm.address })) >= min) return;
    await sleep(1500);
  }
  throw new Error(`${net.native} has not arrived yet. Try again in a moment.`);
}

/** Tops the wallet up when it is under the net's minimum. */
export async function ensureGas(ctx: EthCtx, net: EvmNet, minWei = net.key === "hoodi" ? MIN_HOODI_WEI : MIN_HYPE_WEI): Promise<void> {
  if ((await evmClient(net).getBalance({ address: ctx.evm.address })) >= minWei) return;
  await requestGas(ctx, net);
}

// ---- simETH / simHYPE and the Position -----------------------------------------------------------------------

/** SIMULATED faucet: simETH / simHYPE is a test token (10 per hour per address). Needs a little native token for gas. */
export async function getTestSimEth(ctx: EthCtx, vault: EthVault = ETH_VAULTS[0]): Promise<Hex> {
  const net = NETS[vault.net];
  await ensureGas(ctx, net);
  await ctx.evm.prepare(net.chain);
  const hash = await ctx.evm.clientFor(net.chain).writeContract({
    account: ctx.evm.account,
    chain: undefined,
    address: vault.lst,
    abi: lstAbi,
    functionName: "faucet",
    args: [ctx.evm.address],
  });
  await waitEvm(hash, net);
  return hash;
}

export type OpenStep = "link" | "gas" | "approve" | "inbox" | "open";

export interface OpenedEth {
  vault: Address;
  id: bigint;
  hash: Hex;
  linkSig: string | null;
}

/**
 * Link (first time), gas, approve, create the inbox record for the next Position id, then
 * `openPosition(amount, Horizon)` paying the LayerZero fee (quote + 20%, the excess is refunded).
 * Resolves once the EVM transaction is confirmed; the caller tracks delivery from there.
 */
export async function openEthPosition(
  ctx: EthCtx,
  vault: EthVault,
  amountWei: bigint,
  months: number,
  onStep: (s: OpenStep) => void = () => {},
): Promise<OpenedEth> {
  const net = NETS[vault.net];
  onStep("link");
  const linkSig = await ensureEvmLinked(ctx);
  onStep("gas");
  await ensureGas(ctx, net);
  let market: EthMarket = await fetchEthMarket(vault, ctx.evm.address);
  if (market.simEth < amountWei) throw new Error(`That is more ${vault.symbol} than you have.`);
  await ctx.evm.prepare(net.chain);
  const wallet = ctx.evm.clientFor(net.chain);
  if (market.allowance < amountWei) {
    onStep("approve");
    const approveHash = await wallet.writeContract({
      account: ctx.evm.account,
      chain: undefined,
      address: vault.lst,
      abi: lstAbi,
      functionName: "approve",
      args: [vault.address, maxUint256],
    });
    await waitEvm(approveHash, net);
    market = await fetchEthMarket(vault, ctx.evm.address);
  }
  // The inbox record has to exist before the message arrives: create it for the id this transaction should get.
  onStep("inbox");
  const predicted = market.nextPositionId + 1n;
  await ethCall("init-position", ctx, { vault: vault.address, id: predicted.toString() });
  onStep("open");
  const hash = await wallet.writeContract({
    account: ctx.evm.account,
    chain: undefined,
    address: vault.address,
    abi: vaultAbi,
    functionName: "openPosition",
    args: [amountWei, months],
    value: withHeadroom(market.quoteOpen),
  });
  const receipt = await waitEvm(hash, net);
  const logs = parseEventLogs({ abi: vaultAbi, eventName: "PositionLocked", logs: receipt.logs });
  const id = logs.find((l) => l.address.toLowerCase() === vault.address.toLowerCase())?.args.positionId;
  if (id === undefined) throw new Error("Position opened, but its id was not in the receipt.");
  // Someone else opened one in between: the message for the real id still needs its inbox record (delivery retries).
  if (id !== predicted) await ethCall("init-position", ctx, { vault: vault.address, id: id.toString() });
  return { vault: vault.address, id, hash, linkSig };
}

/** Anyone may call it; the caller pays the LayerZero fee. Resolves once confirmed on the vault's chain. */
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

// ---- Solana side ------------------------------------------------------------------------------------

/** The Advance for an ETH or HYPE Position: the server signs `take_advance` at the oracle price, the Account co-signs. */
export async function takeEthAdvance(ctx: Pick<EthCtx, "signer" | "getToken">, vault: string, id: bigint, months: number): Promise<string> {
  const r = await ethCall<{ transaction: string }>("advance", ctx, { vault, id: id.toString(), months });
  const tx = Transaction.from(Uint8Array.from(atob(r.transaction), (c) => c.charCodeAt(0)));
  return getChain().sendSigned(await ctx.signer.signTransaction(tx));
}

/** `redeem_to_evm`: redeems Gemas of an ETH or HYPE Source and records the payout owed on its EVM chain. Then `send_pay_yield` delivers it. */
export const redeemToEvm = (signer: ChainSigner, position: PublicKey, source: PublicKey, gemas: bigint, vault: string) =>
  getChain().sendBase(signer, [redeemToEvmIx(signer.publicKey, position, source, gemas, netOfVault(vault))]);

/** Debt must be zero on chain. Then `send_unlock` releases the Principal on the vault's chain. */
export const unlockEth = (signer: ChainSigner, position: PublicKey) => getChain().sendBase(signer, [coreUnlockIx(signer.publicKey, position)]);
