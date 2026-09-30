/**
 * Ethereum Positions (Hoodi) server side: the pieces that need a key or the LayerZero SDK.
 *
 *  - `fund-evm`: a capped Hoodi ETH top-up from the deployer (gas + the LayerZero fee).
 *  - `init-position`, `apply-locked`, `apply-yield`, `send-unlock`, `send-pay-yield`: the permissionless
 *    bridge steps (docs/cross-chain.md), paid by the deployer so the Account only needs a little SOL. A keeper
 *    may run them first; each step skips when there is nothing left to do.
 *  - `advance`: `take_advance` at the oracle price, oracle-signed, for the Account to co-sign.
 *
 * Server only: keys are read from disk here and never leave this module. See app/docs/demo-funding.md.
 */
import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createPublicClient, createWalletClient, http, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hoodi } from "viem/chains";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { createSignerFromKeypair, publicKey as umiKey, signerIdentity } from "@metaplex-foundation/umi";
import { fromWeb3JsKeypair, toWeb3JsPublicKey } from "@metaplex-foundation/umi-web3js-adapters";
import { EndpointProgram, UlnProgram } from "@layerzerolabs/lz-solana-sdk-v2/umi";
import { TESORO_CORE_ID, sourcePda } from "@/lib/chain/native";
import {
  BRIDGE_AUTHORITY,
  BRIDGE_ID,
  HOODI_EID,
  HOODI_RPC,
  bridgePeerPda,
  bridgePositionPda,
  bridgeStore,
  claimPda,
  configPda,
  coreAccountPda,
  corePositionPda,
  disc,
  ethPositionId,
  evmLinkPda,
  holdingPda,
  isKnownVault,
  parseBridgePosition,
  sourceAuthPda,
} from "@/lib/chain/eth";
import { WindowLimiter } from "./rate-limit";
import { DemoHttpError, authenticateMessage, chain, deployerKey, oracleKey, sendAndConfirm } from "./demo-advance";

const DAY = 24 * 60 * 60 * 1000;
const SOL = 1_000_000_000;
const FUND_BELOW = parseEther("0.004");
const FUND_AMOUNT = parseEther("0.006");
/** The deployer keeps at least this much Hoodi ETH (it pays for contract admin and the demo Positions). */
const DEPLOYER_MIN_ETH = parseEther("0.05");

/** Hoodi ETH is scarce: cap per EVM address, per Account and in total. */
const limits = {
  ethPerEvm: new WindowLimiter(Number(parseEther("0.02")), DAY),
  ethPerAccount: new WindowLimiter(Number(parseEther("0.02")), DAY),
  ethGlobal: new WindowLimiter(Number(parseEther("0.3")), DAY),
  relayPerAccount: new WindowLimiter(60, DAY),
  relayGlobal: new WindowLimiter(600, DAY),
  advancePerAccount: new WindowLimiter(10, DAY),
};

export type EthStep = "fund-evm" | "init-position" | "apply-locked" | "apply-yield" | "send-unlock" | "send-pay-yield" | "advance";
const STEPS: EthStep[] = ["fund-evm", "init-position", "apply-locked", "apply-yield", "send-unlock", "send-pay-yield", "advance"];
export const ethMessage = (step: string, address: string, ts: number) => `tesoro-eth|${step}|${address}|${ts}`;

// ---- keys and clients ----------------------------------------------------------------------------

let evmKey: Hex | null = null;
function evmDeployerKey(): Hex {
  if (evmKey) return evmKey;
  const file = process.env.TESORO_EVM_DEPLOYER_ENV ?? path.join(os.homedir(), ".config/tesoro/evm-deployer.env");
  try {
    const m = /^EVM_DEPLOYER_PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(fs.readFileSync(file, "utf8"));
    if (m) return (evmKey = m[1] as Hex);
  } catch {
    // fall through
  }
  throw new DemoHttpError(503, "not-configured", "Hoodi funding is not configured on this server.");
}

const hoodiPublic = () => createPublicClient({ chain: hoodi, transport: http(HOODI_RPC) });

// ---- Hoodi ETH top-up ----------------------------------------------------------------------------

async function fundEvm(address: string, evm: string) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(evm)) throw new DemoHttpError(400, "bad-request", "Malformed EVM address.");
  const client = hoodiPublic();
  const balance = await client.getBalance({ address: evm as Address });
  if (balance >= FUND_BELOW) return { funded: false, balance: balance.toString() };
  const cost = Number(FUND_AMOUNT);
  const keys = [evm.toLowerCase(), address];
  if (!limits.ethPerEvm.take(keys[0], cost) || !limits.ethPerAccount.take(keys[1], cost) || !limits.ethGlobal.take("all", cost)) {
    limits.ethPerEvm.refund(keys[0], cost);
    limits.ethPerAccount.refund(keys[1], cost);
    limits.ethGlobal.refund("all", cost);
    throw new DemoHttpError(429, "rate-limited", "Hoodi ETH limit reached for this Account. Try again tomorrow.");
  }
  const refund = () => {
    limits.ethPerEvm.refund(keys[0], cost);
    limits.ethPerAccount.refund(keys[1], cost);
    limits.ethGlobal.refund("all", cost);
  };
  const account = privateKeyToAccount(evmDeployerKey());
  try {
    if ((await client.getBalance({ address: account.address })) < DEPLOYER_MIN_ETH + FUND_AMOUNT) {
      refund();
      throw new DemoHttpError(503, "faucet-empty", "The Hoodi ETH faucet is empty.");
    }
    const wallet = createWalletClient({ account, chain: hoodi, transport: http(HOODI_RPC) });
    const hash = await wallet.sendTransaction({ to: evm as Address, value: FUND_AMOUNT });
    await client.waitForTransactionReceipt({ hash, timeout: 90_000 });
    return { funded: true, hash, balance: (balance + FUND_AMOUNT).toString() };
  } catch (e) {
    if (e instanceof DemoHttpError) throw e;
    refund();
    throw new DemoHttpError(502, "chain", "Hoodi top-up failed. Try again.");
  }
}

// ---- Solana relay --------------------------------------------------------------------------------

const u32le = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64le = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const vecU8 = (b: Uint8Array) => Buffer.concat([u32le(b.length), Buffer.from(b)]);
const key = (pubkey: PublicKey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });

function parseRef(body: { vault?: string; id?: string }) {
  if (!body.vault || !isKnownVault(body.vault)) throw new DemoHttpError(400, "bad-request", "Unknown vault.");
  let id: bigint;
  try {
    id = BigInt(body.id ?? "");
  } catch {
    throw new DemoHttpError(400, "bad-request", "Malformed Position id.");
  }
  if (id <= 0n || id >= 1n << 63n) throw new DemoHttpError(400, "bad-request", "Malformed Position id.");
  return { vault: body.vault, id, pid: ethPositionId(body.vault, id) };
}

/** Sends as the deployer after a simulation, so a step that cannot succeed costs nothing. */
async function relaySend(ixs: TransactionInstruction[], cu = 400_000): Promise<string> {
  const { conn } = chain();
  const deployer = deployerKey();
  if ((await conn.getBalance(deployer.publicKey)) < 1 * SOL) throw new DemoHttpError(503, "faucet-empty", "The relay wallet is empty.");
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }), ...ixs);
  tx.feePayer = deployer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const sim = await conn.simulateTransaction(tx, [deployer]);
  if (sim.value.err) {
    const logs = sim.value.logs ?? [];
    const msg = /Error Message: ([^\n]+)/.exec(logs.join("\n"))?.[1] ?? JSON.stringify(sim.value.err);
    throw new DemoHttpError(409, "step-failed", msg.replace(/\.$/, ""));
  }
  return sendAndConfirm(new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }), ...ixs), [deployer]);
}

async function initPosition(vault: string, pid: Buffer) {
  const { conn } = chain();
  if (await conn.getAccountInfo(bridgePositionPda(pid))) return { skipped: true };
  const deployer = deployerKey();
  const ix = new TransactionInstruction({
    programId: BRIDGE_ID,
    keys: [
      key(deployer.publicKey, true, true),
      key(bridgePeerPda(vault)),
      key(bridgeStore()),
      key(bridgePositionPda(pid), false, true),
      key(SystemProgram.programId),
    ],
    data: Buffer.concat([disc("init_position"), u32le(HOODI_EID), pid]),
  });
  return { skipped: false, signature: await relaySend([ix]) };
}

async function applyLocked(vault: string, pid: Buffer) {
  const { conn } = chain();
  if (await conn.getAccountInfo(corePositionPda(pid))) return { skipped: true };
  const bp = await conn.getAccountInfo(bridgePositionPda(pid));
  const view = bp ? parseBridgePosition(bp.data) : null;
  if (!view || view.lastInSeq === 0n) throw new DemoHttpError(409, "not-delivered", "The message has not arrived on Solana yet.");
  const link = evmLinkPda(view.ownerEvm);
  const linkInfo = await conn.getAccountInfo(link);
  if (!linkInfo) throw new DemoHttpError(409, "not-linked", "The Position owner's EVM address is not linked to an Account.");
  const account = new PublicKey(linkInfo.data.subarray(8 + 20, 8 + 52));
  const deployer = deployerKey();
  const ix = new TransactionInstruction({
    programId: BRIDGE_ID,
    keys: [
      key(deployer.publicKey, true, true),
      key(bridgeStore()),
      key(bridgePeerPda(vault)),
      key(bridgePositionPda(pid), false, true),
      key(BRIDGE_AUTHORITY),
      key(link),
      key(account),
      key(sourceAuthPda()),
      key(corePositionPda(pid), false, true),
      key(TESORO_CORE_ID),
      key(SystemProgram.programId),
    ],
    data: Buffer.concat([disc("apply_locked"), u32le(HOODI_EID), pid]),
  });
  return { skipped: false, signature: await relaySend([ix]) };
}

async function applyYield(pid: Buffer) {
  const { conn } = chain();
  const cp = corePositionPda(pid);
  const [bp, core] = await conn.getMultipleAccountsInfo([bridgePositionPda(pid), cp]);
  if (!bp || !core) throw new DemoHttpError(409, "not-opened", "The Position is not open on Solana yet.");
  const view = parseBridgePosition(bp.data);
  if (view.lastYieldSeq === 0n || view.lastYieldSeq <= view.appliedYieldSeq) return { skipped: true };
  const openAdvance = core.data[8 + 1 + 32 + 32 + 1 + 32 + 1 + 8 + 2 + 1 + 4] === 1 ? core.data.readUInt32LE(8 + 1 + 32 + 32 + 1 + 32 + 1 + 8 + 2 + 1 + 4 + 1) : null;
  const ix = new TransactionInstruction({
    programId: BRIDGE_ID,
    keys: [
      key(bridgeStore()),
      key(bridgePositionPda(pid), false, true),
      key(BRIDGE_AUTHORITY),
      key(sourceAuthPda()),
      key(cp, false, true),
      // Optional account: the program id stands for `None`.
      openAdvance === null ? key(BRIDGE_ID) : key(sourcePda(cp, openAdvance), false, true),
      key(TESORO_CORE_ID),
    ],
    data: Buffer.concat([disc("apply_yield"), u32le(HOODI_EID), pid]),
  });
  return { skipped: false, signature: await relaySend([ix]) };
}

// ---- LayerZero sends (send_unlock, send_pay_yield) -------------------------------------------------

let umiCache: { umi: ReturnType<typeof createUmi>; endpoint: EndpointProgram.Endpoint } | null = null;
function lz() {
  if (!umiCache) {
    const deployer = deployerKey();
    const umi = createUmi(process.env.TESORO_BASE_RPC ?? "https://rpc.magicblock.app/devnet");
    umi.use(signerIdentity(createSignerFromKeypair(umi, fromWeb3JsKeypair(deployer as Keypair))));
    umiCache = { umi, endpoint: new EndpointProgram.Endpoint(EndpointProgram.ENDPOINT_PROGRAM_ID) };
  }
  return umiCache;
}

async function sendAccounts(vault: string) {
  const { umi, endpoint } = lz();
  const oapp = umiKey(bridgeStore().toBase58());
  const lib = await endpoint.getSendLibrary(umi.rpc, oapp, HOODI_EID);
  if (!lib.programId) throw new DemoHttpError(503, "not-configured", "The LayerZero send library is not initialized.");
  const receiver = Uint8Array.from(Buffer.from(vault.replace(/^0x/, "").padStart(64, "0"), "hex"));
  const path = { dstEid: HOODI_EID, sender: oapp, receiver };
  const msgLibProgram = new UlnProgram.Uln(lib.programId);
  const quoteMetas = await endpoint.getQuoteIXAccountMetaForCPI(umi.rpc, umi.identity.publicKey, { path, msgLibProgram });
  const sendMetas = await endpoint.getSendIXAccountMetaForCPI(umi.rpc, umi.identity.publicKey, { path, msgLibProgram });
  const conv = (l: { pubkey: Parameters<typeof toWeb3JsPublicKey>[0]; isSigner: boolean; isWritable: boolean }[]) =>
    l.map((m) => key(toWeb3JsPublicKey(m.pubkey), m.isSigner, m.isWritable));
  return { quote: conv(quoteMetas!), send: conv(sendMetas!) };
}

async function quoteFee(vault: string, type: number, quoteMetas: ReturnType<typeof key>[]): Promise<bigint> {
  const { conn } = chain();
  const deployer = deployerKey();
  const { endpointSettings } = endpointPdas();
  const ix = new TransactionInstruction({
    programId: BRIDGE_ID,
    keys: [key(bridgeStore()), key(bridgePeerPda(vault)), key(endpointSettings), ...quoteMetas],
    data: Buffer.concat([disc("quote_send"), u32le(HOODI_EID), Buffer.from(vault.replace(/^0x/, "").padStart(64, "0"), "hex"), Buffer.from([type]), vecU8(new Uint8Array(0)), Buffer.from([0])]),
  });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix);
  tx.feePayer = deployer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const sim = await conn.simulateTransaction(tx, [deployer]);
  if (sim.value.err || !sim.value.returnData) throw new DemoHttpError(502, "chain", "Could not quote the LayerZero fee.");
  return Buffer.from(sim.value.returnData.data[0], "base64").readBigUInt64LE(0);
}

function endpointPdas() {
  const { endpoint } = lz();
  return { endpointSettings: toWeb3JsPublicKey(endpoint.pda.setting()[0]) };
}

const sendParams = (pid: Buffer, fee: bigint) => Buffer.concat([u32le(HOODI_EID), pid, vecU8(new Uint8Array(0)), u64le(fee), u64le(0n)]);

async function sendUnlock(vault: string, pid: Buffer) {
  const { conn } = chain();
  const cp = corePositionPda(pid);
  const [bp, core] = await conn.getMultipleAccountsInfo([bridgePositionPda(pid), cp]);
  if (!bp || !core) throw new DemoHttpError(409, "not-opened", "The Position is not open on Solana yet.");
  if (parseBridgePosition(bp.data).unlockSent) return { skipped: true };
  if (core.data[8 + 1 + 32 + 32 + 1 + 32 + 1 + 8 + 2] !== 1) throw new DemoHttpError(409, "not-unlocked", "Unlock the Position on Solana first.");
  const acc = await sendAccounts(vault);
  const fee = await quoteFee(vault, 3, acc.quote);
  const deployer = deployerKey();
  const { endpointSettings } = endpointPdas();
  const ix = new TransactionInstruction({
    programId: BRIDGE_ID,
    keys: [
      key(deployer.publicKey, true, true),
      key(bridgePeerPda(vault)),
      key(bridgeStore()),
      key(bridgePositionPda(pid), false, true),
      key(cp),
      key(endpointSettings),
      key(SystemProgram.programId),
      ...acc.send,
    ],
    data: Buffer.concat([disc("send_unlock"), sendParams(pid, fee)]),
  });
  return { skipped: false, signature: await relaySend([ix], 600_000), fee: fee.toString() };
}

async function sendPayYield(vault: string, pid: Buffer, holderAuthority: PublicKey) {
  const { conn } = chain();
  const cp = corePositionPda(pid);
  const holder = coreAccountPda(holderAuthority);
  const core = await conn.getAccountInfo(cp);
  if (!core) throw new DemoHttpError(409, "not-opened", "The Position is not open on Solana yet.");
  const advances = core.data.readUInt32LE(8 + 1 + 32 + 32 + 1 + 32 + 1 + 8 + 2 + 1);
  if (advances === 0) throw new DemoHttpError(409, "no-claim", "Nothing to pay out for this Position.");
  const source = sourcePda(cp, advances - 1);
  const claimKey = claimPda(holder, source);
  const [claim, account] = await conn.getMultipleAccountsInfo([claimKey, holder]);
  if (!claim || !account) throw new DemoHttpError(409, "no-claim", "Nothing to pay out for this Position.");
  if (claim.data.readBigUInt64LE(112) <= claim.data.readBigUInt64LE(120)) return { skipped: true };
  const evm = `0x${Buffer.from(account.data.subarray(41, 61)).toString("hex")}`;
  const acc = await sendAccounts(vault);
  const fee = await quoteFee(vault, 4, acc.quote);
  const deployer = deployerKey();
  const { endpointSettings } = endpointPdas();
  const ix = new TransactionInstruction({
    programId: BRIDGE_ID,
    keys: [
      key(deployer.publicKey, true, true),
      key(bridgePeerPda(vault)),
      key(bridgeStore()),
      key(bridgePositionPda(pid), false, true),
      key(cp),
      key(holder),
      key(evmLinkPda(evm)),
      key(claimKey, false, true),
      key(endpointSettings),
      key(SystemProgram.programId),
      ...acc.send,
    ],
    data: Buffer.concat([disc("send_pay_yield"), sendParams(pid, fee)]),
  });
  return { skipped: false, signature: await relaySend([ix], 600_000), fee: fee.toString() };
}

// ---- Advance (oracle price) ------------------------------------------------------------------------

/** Devnet price feed for the Advance: Coinbase ETH-USD spot, refreshed at most every 60 s; falls back to the $3,000 of docs/cross-chain.md. */
let priceCache: { microUsd: bigint; at: number; live: boolean } | null = null;
export async function ethPrice(): Promise<{ microUsd: bigint; live: boolean }> {
  if (priceCache && Date.now() - priceCache.at < 60_000) return priceCache;
  let microUsd = 3_000_000_000n;
  let live = false;
  try {
    const res = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", { signal: AbortSignal.timeout(4000) });
    const amount = Number(((await res.json()) as { data?: { amount?: string } }).data?.amount);
    if (Number.isFinite(amount) && amount > 100 && amount < 100_000) {
      microUsd = BigInt(Math.round(amount * 1e6));
      live = true;
    }
  } catch {
    // keep the fallback
  }
  priceCache = { microUsd, at: Date.now(), live };
  return priceCache;
}

async function advance(address: PublicKey, pid: Buffer, months: number) {
  const { conn } = chain();
  if (!Number.isInteger(months) || months < 1 || months > 12) throw new DemoHttpError(400, "bad-request", "Horizon must be 1 to 12 months.");
  const cp = corePositionPda(pid);
  const info = await conn.getAccountInfo(cp);
  if (!info) throw new DemoHttpError(409, "not-opened", "The Position is not open on Solana yet.");
  const ownerAccount = coreAccountPda(address);
  if (!new PublicKey(info.data.subarray(41, 73)).equals(ownerAccount)) throw new DemoHttpError(403, "not-yours", "That Position is not yours.");
  const base = 8 + 1 + 32 + 32 + 1 + 32 + 1 + 8 + 2 + 1;
  const advances = info.data.readUInt32LE(base);
  if (info.data[base + 4] === 1) throw new DemoHttpError(409, "advance-open", "This Position already has an open Advance.");
  if (!limits.advancePerAccount.take(address.toBase58())) throw new DemoHttpError(429, "rate-limited", "Advance limit reached for this Account. Try again tomorrow.");
  const oracle = oracleKey();
  const source = sourcePda(cp, advances);
  const price = await ethPrice();
  const ix = new TransactionInstruction({
    programId: TESORO_CORE_ID,
    keys: [
      key(oracle.publicKey, true, true),
      key(address, true),
      key(configPda()),
      key(ownerAccount, false, true),
      key(cp, false, true),
      key(source, false, true),
      key(holdingPda(ownerAccount, source), false, true),
      key(SystemProgram.programId),
    ],
    data: Buffer.concat([disc("take_advance"), Buffer.from([months]), u64le(price.microUsd)]),
  });
  const tx = new Transaction().add(ix);
  tx.feePayer = oracle.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.partialSign(oracle);
  return { source: source.toBase58(), priceMicroUsd: price.microUsd.toString(), transaction: tx.serialize({ requireAllSignatures: false }).toString("base64") };
}

// ---- entry points ----------------------------------------------------------------------------------

/** Public: the price the Advance would be issued at. */
export async function handleEthPrice() {
  const p = await ethPrice();
  return { priceMicroUsd: p.microUsd.toString(), live: p.live };
}

export async function handleEthRequest(raw: unknown, authorization: string | null): Promise<unknown> {
  const body = raw as { step?: EthStep; address?: string; ts?: number; signature?: string; vault?: string; id?: string; evm?: string; months?: number };
  if (!body || !STEPS.includes(body.step as EthStep) || !body.address || typeof body.ts !== "number" || !body.signature) {
    throw new DemoHttpError(400, "bad-request", "Malformed request.");
  }
  let address: PublicKey;
  try {
    address = new PublicKey(body.address);
  } catch {
    throw new DemoHttpError(400, "bad-request", "Malformed address.");
  }
  await authenticateMessage(ethMessage(body.step as string, body.address, body.ts), { address: body.address, ts: body.ts, signature: body.signature }, authorization);

  if (body.step === "fund-evm") return fundEvm(body.address, body.evm ?? "");
  const ref = parseRef(body);
  if (body.step === "advance") return advance(address, ref.pid, Number(body.months));
  if (!limits.relayPerAccount.take(body.address) || !limits.relayGlobal.take("all")) {
    limits.relayPerAccount.refund(body.address);
    throw new DemoHttpError(429, "rate-limited", "Relay limit reached for this Account. Try again tomorrow.");
  }
  try {
    switch (body.step) {
      case "init-position":
        return await initPosition(ref.vault, ref.pid);
      case "apply-locked":
        return await applyLocked(ref.vault, ref.pid);
      case "apply-yield":
        return await applyYield(ref.pid).then((r) => (console.info("eth-bridge apply-yield", JSON.stringify(r)), r));
      case "send-unlock":
        return await sendUnlock(ref.vault, ref.pid);
      default:
        return await sendPayYield(ref.vault, ref.pid, address);
    }
  } catch (e) {
    limits.relayPerAccount.refund(body.address);
    limits.relayGlobal.refund("all");
    throw e;
  }
}

