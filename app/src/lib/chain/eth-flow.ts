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
  coreUnlockIx,
  fetchEthMarket,
  fetchLinkState,
  hoodiClient,
  linkEvmIx,
  linkMessage,
  lstAbi,
  redeemToEvmIx,
  setEvmAddressIx,
  vaultAbi,
  withHeadroom,
  type EthMarket,
  type EthVault,
} from "./eth";
import { ensureReady } from "./match-flow";

/** What the ETH flows need: the Account's Solana signer, its EVM wallet, and the Privy token for server routes. */
export interface EthCtx {
  signer: ChainSigner;
  evm: EvmSigner;
  getToken: GetToken;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** `tesoro-eth|<step>|<address>|<ts>`, signed by the Solana wallet (ed25519) like the SOL top-up. */
const ethMessage = (step: string, address: string, ts: number) => `tesoro-eth|${step}|${address}|${ts}`;

/** Calls the server relay (`/api/eth-bridge`): Hoodi top-up, permissionless bridge steps, the oracle-priced Advance. */
export async function ethCall<T = Record<string, unknown>>(step: string, ctx: Pick<EthCtx, "signer" | "getToken">, body: Record<string, unknown> = {}): Promise<T> {
  const address = ctx.signer.publicKey.toBase58();
  const ts = Date.now();
  const signature = await ctx.signer.signMessage(new TextEncoder().encode(ethMessage(step, address, ts)));
  const token = await ctx.getToken().catch(() => null);
  const res = await fetch("/api/eth-bridge", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ step, address, ts, signature: b64(signature), ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new DemoError(json.error ?? `Request failed (${res.status})`, json.code ?? "error", res.status);
  return json as T;
}

/** The price an Advance on an ETH Position is issued at (public route). */
export async function fetchEthPrice(): Promise<{ priceMicroUsd: bigint; live: boolean }> {
  const res = await fetch("/api/eth-bridge");
  if (!res.ok) throw new Error("price unavailable");
  const j = (await res.json()) as { priceMicroUsd: string; live: boolean };
  return { priceMicroUsd: BigInt(j.priceMicroUsd), live: j.live };
}

/** The message a wallet rejected, else the first line. */
export function ethError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const err = e as { shortMessage?: string; code?: number; name?: string };
  if (err?.name === "UserRejectedRequestError" || err?.code === 4001) return "Wallet request was rejected.";
  if (err?.shortMessage) return err.shortMessage.split("\n")[0].slice(0, 200);
  const m = /Error Message: ([^\n]+)/.exec(text);
  if (m) return m[1].replace(/\.$/, "");
  return text.split("\n")[0].replace(/^base tx failed \S+: /, "").slice(0, 200);
}

async function waitEvm(hash: Hex) {
  const receipt = await hoodiClient().waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error("The Hoodi transaction reverted.");
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

// ---- Hoodi gas ------------------------------------------------------------------------------------

/** Below this the server tops the wallet up (gas for approve + openPosition, plus the LayerZero fee). */
export const MIN_HOODI_WEI = 4_000_000_000_000_000n;

/** Capped server-side top-up of Hoodi ETH from the deployer. The key never reaches the client. */
export async function ensureGas(ctx: EthCtx, minWei = MIN_HOODI_WEI): Promise<void> {
  const client = hoodiClient();
  if ((await client.getBalance({ address: ctx.evm.address })) >= minWei) return;
  await ethCall("fund-evm", ctx, { evm: ctx.evm.address });
  for (let i = 0; i < 40; i++) {
    if ((await client.getBalance({ address: ctx.evm.address })) >= minWei) return;
    await sleep(1500);
  }
  throw new Error("Hoodi ETH has not arrived yet. Try again in a moment.");
}

// ---- simETH and the Position -----------------------------------------------------------------------

/** SIMULATED faucet: simETH is a test token (10 per hour per address). Needs a little Hoodi ETH for gas. */
export async function getTestSimEth(ctx: EthCtx, vault: EthVault = ETH_VAULTS[0]): Promise<Hex> {
  await ensureGas(ctx);
  await ctx.evm.prepare();
  const hash = await ctx.evm.client.writeContract({
    account: ctx.evm.account,
    chain: undefined,
    address: vault.lst,
    abi: lstAbi,
    functionName: "faucet",
    args: [ctx.evm.address],
  });
  await waitEvm(hash);
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
 * Resolves once the Hoodi transaction is confirmed; the caller tracks delivery from there.
 */
export async function openEthPosition(
  ctx: EthCtx,
  vault: EthVault,
  amountWei: bigint,
  months: number,
  onStep: (s: OpenStep) => void = () => {},
): Promise<OpenedEth> {
  onStep("link");
  const linkSig = await ensureEvmLinked(ctx);
  onStep("gas");
  await ensureGas(ctx);
  let market: EthMarket = await fetchEthMarket(vault, ctx.evm.address);
  if (market.simEth < amountWei) throw new Error("That is more simETH than you have.");
  await ctx.evm.prepare();
  if (market.allowance < amountWei) {
    onStep("approve");
    const approveHash = await ctx.evm.client.writeContract({
      account: ctx.evm.account,
      chain: undefined,
      address: vault.lst,
      abi: lstAbi,
      functionName: "approve",
      args: [vault.address, maxUint256],
    });
    await waitEvm(approveHash);
    market = await fetchEthMarket(vault, ctx.evm.address);
  }
  // The inbox record has to exist before the message arrives: create it for the id this transaction should get.
  onStep("inbox");
  const predicted = market.nextPositionId + 1n;
  await ethCall("init-position", ctx, { vault: vault.address, id: predicted.toString() });
  onStep("open");
  const hash = await ctx.evm.client.writeContract({
    account: ctx.evm.account,
    chain: undefined,
    address: vault.address,
    abi: vaultAbi,
    functionName: "openPosition",
    args: [amountWei, months],
    value: withHeadroom(market.quoteOpen),
  });
  const receipt = await waitEvm(hash);
  const logs = parseEventLogs({ abi: vaultAbi, eventName: "PositionLocked", logs: receipt.logs });
  const id = logs.find((l) => l.address.toLowerCase() === vault.address.toLowerCase())?.args.positionId;
  if (id === undefined) throw new Error("Position opened, but its id was not in the receipt.");
  // Someone else opened one in between: the message for the real id still needs its inbox record (delivery retries).
  if (id !== predicted) await ethCall("init-position", ctx, { vault: vault.address, id: id.toString() });
  return { vault: vault.address, id, hash, linkSig };
}

/** Anyone may call it; the caller pays the LayerZero fee. Resolves once confirmed on Hoodi. */
export async function reportEthYield(ctx: EthCtx, vault: EthVault, id: bigint): Promise<Hex> {
  await ensureGas(ctx);
  const market = await fetchEthMarket(vault, ctx.evm.address);
  await ctx.evm.prepare();
  const hash = await ctx.evm.client.writeContract({
    account: ctx.evm.account,
    chain: undefined,
    address: vault.address,
    abi: vaultAbi,
    functionName: "reportYield",
    args: [id],
    value: withHeadroom(market.quoteYield),
  });
  await waitEvm(hash);
  return hash;
}

// ---- Solana side ------------------------------------------------------------------------------------

/** The Advance for an ETH Position: the server signs `take_advance` at the oracle price, the Account co-signs. */
export async function takeEthAdvance(ctx: Pick<EthCtx, "signer" | "getToken">, vault: string, id: bigint, months: number): Promise<string> {
  const r = await ethCall<{ transaction: string }>("advance", ctx, { vault, id: id.toString(), months });
  const tx = Transaction.from(Uint8Array.from(atob(r.transaction), (c) => c.charCodeAt(0)));
  return getChain().sendSigned(await ctx.signer.signTransaction(tx));
}

/** `redeem_to_evm`: redeems Gemas of an ETH Source and records the payout owed on Hoodi. Then `send_pay_yield` delivers it. */
export const redeemToEvm = (signer: ChainSigner, position: PublicKey, source: PublicKey, gemas: bigint) =>
  getChain().sendBase(signer, [redeemToEvmIx(signer.publicKey, position, source, gemas)]);

/** Debt must be zero on chain. Then `send_unlock` releases the Principal on Hoodi. */
export const unlockEth = (signer: ChainSigner, position: PublicKey) => getChain().sendBase(signer, [coreUnlockIx(signer.publicKey, position)]);
