/**
 * Ethereum (Hoodi) and HyperEVM Positions, server side: the pieces that need a key or the LayerZero SDK.
 *
 *  - `fund-evm`, `fund-hype`: capped Hoodi ETH / HyperEVM HYPE top-ups from the relayer (gas + the LayerZero fee).
 *  - `faucet-lst`: the relayer claims the SimLST faucet (simETH / simHYPE) for a Player's EVM address, so they sign nothing.
 *  - `init-position`, `apply-locked`, `apply-yield`, `send-unlock`, `send-pay-yield`, `send-pay-instant`: the permissionless
 *    bridge steps (docs/cross-chain.md), paid by the relayer so the Account only needs a little SOL. A keeper
 *    may run them first; each step skips when there is nothing left to do.
 *  - `report-yield` (test mode): the relayer's EVM key asks the vault for a Yield Report (ADR 0010), throttled per Position.
 *  - `advance`: `take_advance` at the oracle price, oracle-signed, for the Account to co-sign.
 *
 * Server only: keys are read from disk here and never leave this module.
 */
import "server-only";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createPublicClient, createWalletClient, http, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hoodi } from "viem/chains";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { createSignerFromKeypair, publicKey as umiKey, signerIdentity } from "@metaplex-foundation/umi";
import { fromWeb3JsKeypair, toWeb3JsPublicKey } from "@metaplex-foundation/umi-web3js-adapters";
import { EndpointProgram, UlnProgram } from "@layerzerolabs/lz-solana-sdk-v2/umi";
import { CLUSTER } from "@/lib/cluster-settings";
import { basketPda, bookPda, spillPda } from "@/lib/chain/basket";
import { coreIx } from "@/lib/chain/core-ix";
import { MAX_PRICE_AGE_SECS, PRICE_QUOTE_MARGIN_SECS, TESORO_CORE_ID, onchainPricePda, parsePythPrice, protectionsPda, pythFeedAddress, sourcePda, treasuryPda } from "@/lib/chain/native";
import {
  BRIDGE_AUTHORITY,
  BRIDGE_ID,
  HOODI_RPC,
  HYPEREVM_RPC,
  NETS,
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
  initPositionIdAllowed,
  instantClaimPda,
  evmClient,
  isKnownVault,
  lstAbi,
  netOfVault,
  vaultByAddress,
  parseBridgePosition,
  sourceAuthPda,
  vaultAbi,
  vaultTreasuryPda,
  withHeadroom,
  fetchVaultPosition,
  type EvmNet,
} from "@/lib/chain/eth";
import type { SignedFields } from "@/lib/chain/signed-request";
import { requireDevnet, requireHoodi, requireHyperEvm, requireTestMode } from "./cluster";
import { HYPE_DEFAULT_MAX_PER_HOUR, createHypeTopup } from "./hype-topup";
import { WindowLimiter, takeAll } from "./rate-limit";
import { relayerSend } from "./relayer-send";
import { createYieldReporter } from "./yield-report";
import { createSimFaucet } from "./sim-faucet";
import { evmPrivateKey } from "./keys";
import { BASE_RPC, DemoHttpError, RELAYER_MIN_LAMPORTS, chain, nonces, oracleKey, perUser, relayerKey, sendAndConfirm } from "./demo-advance";
import { verifySignedRequest } from "./request-auth";
import { isTransient, retryRead, retryingReads } from "./retry";
import { BRAND } from "../lib/brand";

const DAY = 24 * 60 * 60 * 1000;
const FUND_BELOW = parseEther("0.004");
const FUND_AMOUNT = parseEther("0.006");
/** The relayer keeps at least this much Hoodi ETH. */
const RELAYER_MIN_ETH = parseEther("0.01");

/** Hoodi ETH is scarce: cap per EVM address, per Account, per signed-in user and in total. */
const limits = {
  ethPerEvm: new WindowLimiter(Number(parseEther("0.02")), DAY),
  ethPerAccount: new WindowLimiter(Number(parseEther("0.02")), DAY),
  ethPerUser: new WindowLimiter(Number(parseEther("0.02")), DAY),
  ethGlobal: new WindowLimiter(Number(parseEther("0.3")), DAY),
  relayPerAccount: new WindowLimiter(60, DAY),
  relayPerUser: new WindowLimiter(60, DAY),
  relayGlobal: new WindowLimiter(600, DAY),
  advancePerAccount: new WindowLimiter(10, DAY),
  advancePerUser: new WindowLimiter(10, DAY),
};

export type EthStep = "fund-evm" | "fund-hype" | "faucet-lst" | "init-position" | "apply-locked" | "apply-yield" | "report-yield" | "send-unlock" | "send-pay-yield" | "send-pay-instant" | "advance";
const STEPS: EthStep[] = ["fund-evm", "fund-hype", "faucet-lst", "init-position", "apply-locked", "apply-yield", "report-yield", "send-unlock", "send-pay-yield", "send-pay-instant", "advance"];

// ---- keys and clients ----------------------------------------------------------------------------

let evmKey: Hex | null = null;
/** Hoodi faucet key of the web routes: low balance, owns no contract (the deployer key stays off this server). */
function evmRelayerKey(): Hex {
  if (evmKey) return evmKey;
  try {
    return (evmKey = evmPrivateKey("TESORO_RELAYER_EVM_PRIVATE_KEY", "TESORO_RELAYER_EVM_ENV", ".config/tesoro/relayer-evm.env", "RELAYER_EVM_PRIVATE_KEY"));
  } catch (e) {
    console.error(`[keys] TESORO_RELAYER_EVM_PRIVATE_KEY: ${(e as Error).message}`);
    throw new DemoHttpError(503, "not-configured", "Hoodi funding is not configured on this server.");
  }
}

/** The relay's Solana connection (reads and sends): its reads retry on rate limits and timeouts. */
const proxies = new WeakMap<object, ReturnType<typeof chain>["conn"]>();
function relayConn() {
  const conn = chain().conn;
  let proxy = proxies.get(conn);
  if (!proxy) proxies.set(conn, (proxy = retryingReads(conn)));
  return proxy;
}

const hoodiPublic = () => createPublicClient({ chain: hoodi, transport: http(HOODI_RPC) });

// ---- Hoodi ETH top-up ----------------------------------------------------------------------------

async function fundEvm(address: string, evm: string, sub: string | null) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(evm)) throw new DemoHttpError(400, "bad-request", "That wallet address doesn’t look right.");
  await requireHoodi(HOODI_RPC);
  const client = hoodiPublic();
  const balance = await client.getBalance({ address: evm as Address });
  if (balance >= FUND_BELOW) return { funded: false, balance: balance.toString() };
  const cost = Number(FUND_AMOUNT);
  const refund = takeAll([[limits.ethPerEvm, evm.toLowerCase()], [limits.ethPerAccount, address], ...perUser(limits.ethPerUser, sub), [limits.ethGlobal, "all"]], cost);
  if (!refund) throw new DemoHttpError(429, "rate-limited", "Hoodi ETH limit reached for this Account. Try again tomorrow.");
  const account = privateKeyToAccount(evmRelayerKey());
  try {
    if ((await client.getBalance({ address: account.address })) < RELAYER_MIN_ETH + FUND_AMOUNT) {
      refund();
      throw new DemoHttpError(503, "faucet-empty", "The Hoodi ETH faucet is empty.");
    }
    const wallet = createWalletClient({ account, chain: hoodi, transport: http(HOODI_RPC) });
    const hash = await relayerSend("hoodi", () => wallet.sendTransaction({ to: evm as Address, value: FUND_AMOUNT }));
    await client.waitForTransactionReceipt({ hash, timeout: 90_000 });
    return { funded: true, hash, balance: (balance + FUND_AMOUNT).toString() };
  } catch (e) {
    if (e instanceof DemoHttpError) throw e;
    refund();
    throw new DemoHttpError(502, "chain", "Hoodi top-up failed. Try again.");
  }
}

// ---- HyperEVM HYPE top-up ------------------------------------------------------------------------

const hyperPublic = () => createPublicClient({ chain: NETS.hyperevm.chain, transport: http(HYPEREVM_RPC) });
const maxHypePerHour = Number(process.env.TESORO_HYPE_TOPUP_MAX_PER_HOUR) || HYPE_DEFAULT_MAX_PER_HOUR;
const fundHype = createHypeTopup({
  requireChain: () => requireHyperEvm(HYPEREVM_RPC),
  balanceOf: (address) => hyperPublic().getBalance({ address: address as Address }),
  relayerBalance: () => hyperPublic().getBalance({ address: privateKeyToAccount(evmRelayerKey()).address }),
  send: async (to, value) => {
    const client = hyperPublic();
    const wallet = createWalletClient({ account: privateKeyToAccount(evmRelayerKey()), chain: NETS.hyperevm.chain, transport: http(HYPEREVM_RPC) });
    const hash = await relayerSend("hyperevm", () => wallet.sendTransaction({ to: to as Address, value }));
    await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
    return hash;
  },
  maxPerHour: maxHypePerHour,
});

// ---- simETH / simHYPE faucet ---------------------------------------------------------------------

const publicOf = (net: string) => evmClient(net === "hyperevm" ? NETS.hyperevm : NETS.hoodi);
const claimSimToken = createSimFaucet({
  requireChain: (net) => (net === "hyperevm" ? requireHyperEvm(HYPEREVM_RPC) : requireHoodi(HOODI_RPC)),
  availableAt: async (token, to, net) => {
    const lst = { address: token as Address, abi: lstAbi } as const;
    const client = publicOf(net);
    const [last, cooldown] = await Promise.all([
      client.readContract({ ...lst, functionName: "lastFaucet", args: [to as Address] }),
      client.readContract({ ...lst, functionName: "faucetCooldown" }),
    ]);
    return last === 0n ? 0 : Number(last + cooldown);
  },
  send: async (token, to, net) => {
    const chain = net === "hyperevm" ? NETS.hyperevm.chain : hoodi;
    const wallet = createWalletClient({ account: privateKeyToAccount(evmRelayerKey()), chain, transport: http(net === "hyperevm" ? HYPEREVM_RPC : HOODI_RPC) });
    const hash = await relayerSend(net, () => wallet.writeContract({ address: token as Address, abi: lstAbi, functionName: "faucet", args: [to as Address] }));
    const receipt = await publicOf(net).waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== "success") throw new Error("faucet reverted");
    return hash;
  },
});

function faucetLst(address: string, fields: SignedFields, sub: string | null) {
  const vault = vaultByAddress(typeof fields.vault === "string" ? fields.vault : "");
  if (!vault) throw new DemoHttpError(400, "bad-request", "Unknown vault.");
  return claimSimToken(address, typeof fields.evm === "string" ? fields.evm : "", vault.lst, vault.net, sub);
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

function parseRef(fields: SignedFields) {
  const vault = typeof fields.vault === "string" ? fields.vault : "";
  if (!isKnownVault(vault)) throw new DemoHttpError(400, "bad-request", "Unknown vault.");
  if (typeof fields.id !== "string" || !/^[1-9]\d{0,18}$/.test(fields.id)) throw new DemoHttpError(400, "bad-request", "Malformed Lock id.");
  const id = BigInt(fields.id);
  if (id >= 1n << 63n) throw new DemoHttpError(400, "bad-request", "Malformed Lock id.");
  return { vault, id, pid: ethPositionId(vault, id) };
}

/** Sends as the relayer after a simulation, so a step that cannot succeed costs nothing. */
async function relaySend(ixs: TransactionInstruction[], cu = 400_000): Promise<string> {
  const conn = relayConn();
  const relayer = relayerKey();
  if ((await conn.getBalance(relayer.publicKey)) < RELAYER_MIN_LAMPORTS) throw new DemoHttpError(503, "faucet-empty", "Test funds have run out for now. Try again later.");
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }), ...ixs);
  tx.feePayer = relayer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const sim = await conn.simulateTransaction(tx, [relayer]);
  if (sim.value.err) {
    const logs = sim.value.logs ?? [];
    const msg = /Error Message: ([^\n]+)/.exec(logs.join("\n"))?.[1] ?? JSON.stringify(sim.value.err);
    throw new DemoHttpError(409, "step-failed", msg.replace(/\.$/, ""));
  }
  return sendAndConfirm(new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }), ...ixs), [relayer]);
}

/** Inbox record for an id `initPositionIdAllowed` accepts (src/lib/chain/eth.ts). */
async function initPosition(vault: string, id: bigint, pid: Buffer) {
  const conn = relayConn();
  if (await conn.getAccountInfo(bridgePositionPda(pid))) return { skipped: true };
  const last = await retryRead(() => evmClient(netOfVault(vault)).readContract({ address: vault as Address, abi: vaultAbi, functionName: "nextPositionId" }));
  if (!initPositionIdAllowed(id, last)) throw new DemoHttpError(400, "bad-request", "Unknown Lock id.");
  const relayer = relayerKey();
  const ix = new TransactionInstruction({
    programId: BRIDGE_ID,
    keys: [
      key(relayer.publicKey, true, true),
      key(bridgePeerPda(vault)),
      key(bridgeStore()),
      key(bridgePositionPda(pid), false, true),
      key(SystemProgram.programId),
    ],
    data: Buffer.concat([disc("init_position"), u32le(netOfVault(vault).eid), pid]),
  });
  return { skipped: false, signature: await relaySend([ix]) };
}

async function applyLocked(vault: string, pid: Buffer) {
  const conn = relayConn();
  const net = netOfVault(vault);
  if (await conn.getAccountInfo(corePositionPda(pid))) return { skipped: true };
  const bp = await conn.getAccountInfo(bridgePositionPda(pid));
  const view = bp ? parseBridgePosition(bp.data) : null;
  if (!view || view.lastInSeq === 0n) throw new DemoHttpError(409, "not-delivered", "Still crossing chains. This continues automatically.");
  const link = evmLinkPda(view.ownerEvm);
  const linkInfo = await conn.getAccountInfo(link);
  if (!linkInfo) throw new DemoHttpError(409, "not-linked", `This wallet is not linked to a ${BRAND.name} Account yet.`);
  const account = new PublicKey(linkInfo.data.subarray(8 + 20, 8 + 52));
  const relayer = relayerKey();
  const ix = new TransactionInstruction({
    programId: BRIDGE_ID,
    keys: [
      key(relayer.publicKey, true, true),
      key(bridgeStore()),
      key(bridgePeerPda(vault)),
      key(bridgePositionPda(pid), false, true),
      key(BRIDGE_AUTHORITY),
      key(link),
      key(account),
      key(sourceAuthPda(net)),
      key(corePositionPda(pid), false, true),
      key(TESORO_CORE_ID),
      key(SystemProgram.programId),
    ],
    data: Buffer.concat([disc("apply_locked"), u32le(net.eid), pid]),
  });
  return { skipped: false, signature: await relaySend([ix]) };
}

async function applyYield(vault: string, pid: Buffer) {
  const conn = relayConn();
  const net = netOfVault(vault);
  const cp = corePositionPda(pid);
  const [bp, core] = await conn.getMultipleAccountsInfo([bridgePositionPda(pid), cp]);
  if (!bp || !core) throw new DemoHttpError(409, "not-opened", "The Lock is not open on Solana yet.");
  const view = parseBridgePosition(bp.data);
  if (!view) throw new DemoHttpError(409, "abandoned", "This Lock is on a retired contract and can no longer be updated.");
  if (view.lastYieldSeq === 0n || view.lastYieldSeq <= view.appliedYieldSeq) return { skipped: true };
  const openAdvance = core.data[8 + 1 + 32 + 32 + 1 + 32 + 1 + 8 + 2 + 1 + 4] === 1 ? core.data.readUInt32LE(8 + 1 + 32 + 32 + 1 + 32 + 1 + 8 + 2 + 1 + 4 + 1) : null;
  const ix = new TransactionInstruction({
    programId: BRIDGE_ID,
    keys: [
      key(bridgeStore()),
      key(bridgePositionPda(pid), false, true),
      key(vaultTreasuryPda(net.eid, vault), false, true),
      key(BRIDGE_AUTHORITY),
      key(sourceAuthPda(net)),
      key(cp, false, true),
      // Optional account: the program id stands for `None`.
      openAdvance === null ? key(BRIDGE_ID) : key(sourcePda(cp, openAdvance), false, true),
      key(TESORO_CORE_ID),
    ],
    data: Buffer.concat([disc("apply_yield"), u32le(net.eid), pid]),
  });
  return { skipped: false, signature: await relaySend([ix]) };
}

// ---- Yield Report request (test mode: the relayer's EVM key) -------------------------------------

const reportYieldFor = createYieldReporter({
  requireChain: (vault) => (netOfVault(vault).key === "hyperevm" ? requireHyperEvm(HYPEREVM_RPC) : requireHoodi(HOODI_RPC)),
  vaultPosition: async (vault, id) => {
    const p = await retryRead(() => fetchVaultPosition(vault, id));
    return p ? { unlocked: p.unlocked } : null;
  },
  lastYieldSeq: async (vault, id) => {
    const info = await relayConn().getAccountInfo(bridgePositionPda(ethPositionId(vault, id)));
    return (info ? parseBridgePosition(info.data) : null)?.lastYieldSeq ?? 0n;
  },
  fee: async (vault) => withHeadroom(await retryRead(() => evmClient(netOfVault(vault)).readContract({ address: vault as Address, abi: vaultAbi, functionName: "quoteYieldAccrued" }))),
  send: async (vault, id, value) => {
    const net = netOfVault(vault);
    const wallet = createWalletClient({ account: privateKeyToAccount(evmRelayerKey()), chain: net.chain, transport: http(net.rpc) });
    const hash = await relayerSend(net.key, () => wallet.writeContract({ address: vault as Address, abi: vaultAbi, functionName: "reportYield", args: [id], value }));
    const receipt = await evmClient(net).waitForTransactionReceipt({ hash, timeout: 90_000 });
    if (receipt.status !== "success") throw new Error("reportYield reverted");
    return hash;
  },
});

// ---- LayerZero sends (send_unlock, send_pay_yield, send_pay_instant) -------------------------------------------------

let umiCache: { umi: ReturnType<typeof createUmi>; endpoint: EndpointProgram.Endpoint } | null = null;
function lz() {
  if (!umiCache) {
    const relayer = relayerKey();
    const umi = createUmi(BASE_RPC);
    umi.use(signerIdentity(createSignerFromKeypair(umi, fromWeb3JsKeypair(relayer as Keypair))));
    umiCache = { umi, endpoint: new EndpointProgram.Endpoint(EndpointProgram.ENDPOINT_PROGRAM_ID) };
  }
  return umiCache;
}

async function sendAccounts(vault: string) {
  const { umi, endpoint } = lz();
  const oapp = umiKey(bridgeStore().toBase58());
  const eid = netOfVault(vault).eid;
  const lib = await endpoint.getSendLibrary(umi.rpc, oapp, eid);
  if (!lib.programId) throw new DemoHttpError(503, "not-configured", "Cross-chain transfers are not available right now.");
  const receiver = Uint8Array.from(Buffer.from(vault.replace(/^0x/, "").padStart(64, "0"), "hex"));
  const path = { dstEid: eid, sender: oapp, receiver };
  const msgLibProgram = new UlnProgram.Uln(lib.programId);
  const quoteMetas = await endpoint.getQuoteIXAccountMetaForCPI(umi.rpc, umi.identity.publicKey, { path, msgLibProgram });
  const sendMetas = await endpoint.getSendIXAccountMetaForCPI(umi.rpc, umi.identity.publicKey, { path, msgLibProgram });
  const conv = (l: { pubkey: Parameters<typeof toWeb3JsPublicKey>[0]; isSigner: boolean; isWritable: boolean }[]) =>
    l.map((m) => key(toWeb3JsPublicKey(m.pubkey), m.isSigner, m.isWritable));
  return { quote: conv(quoteMetas!), send: conv(sendMetas!) };
}

async function quoteFee(vault: string, type: number, quoteMetas: ReturnType<typeof key>[]): Promise<bigint> {
  const conn = relayConn();
  const relayer = relayerKey();
  const { endpointSettings } = endpointPdas();
  const ix = new TransactionInstruction({
    programId: BRIDGE_ID,
    keys: [key(bridgeStore()), key(bridgePeerPda(vault)), key(endpointSettings), ...quoteMetas],
    data: Buffer.concat([disc("quote_send"), u32le(netOfVault(vault).eid), Buffer.from(vault.replace(/^0x/, "").padStart(64, "0"), "hex"), Buffer.from([type]), vecU8(new Uint8Array(0)), Buffer.from([0])]),
  });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix);
  tx.feePayer = relayer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const sim = await conn.simulateTransaction(tx, [relayer]);
  if (sim.value.err || !sim.value.returnData) throw new DemoHttpError(502, "chain", "Couldn’t get the cross-chain fee. Try again.");
  return Buffer.from(sim.value.returnData.data[0], "base64").readBigUInt64LE(0);
}

function endpointPdas() {
  const { endpoint } = lz();
  return { endpointSettings: toWeb3JsPublicKey(endpoint.pda.setting()[0]) };
}

const sendParams = (vault: string, pid: Buffer, fee: bigint) => Buffer.concat([u32le(netOfVault(vault).eid), pid, vecU8(new Uint8Array(0)), u64le(fee), u64le(0n)]);

async function sendUnlock(vault: string, pid: Buffer) {
  const conn = relayConn();
  const cp = corePositionPda(pid);
  const [bp, core] = await conn.getMultipleAccountsInfo([bridgePositionPda(pid), cp]);
  if (!bp || !core) throw new DemoHttpError(409, "not-opened", "The Lock is not open on Solana yet.");
  const view = parseBridgePosition(bp.data);
  if (!view) throw new DemoHttpError(409, "abandoned", "This Lock is on a retired contract and can no longer be updated.");
  if (view.unlockSent) return { skipped: true };
  if (core.data[8 + 1 + 32 + 32 + 1 + 32 + 1 + 8 + 2] !== 1) throw new DemoHttpError(409, "not-unlocked", "Unlock the Lock on Solana first.");
  const acc = await sendAccounts(vault);
  const fee = await quoteFee(vault, 3, acc.quote);
  const relayer = relayerKey();
  const { endpointSettings } = endpointPdas();
  const ix = new TransactionInstruction({
    programId: BRIDGE_ID,
    keys: [
      key(relayer.publicKey, true, true),
      key(bridgePeerPda(vault)),
      key(bridgeStore()),
      key(bridgePositionPda(pid), false, true),
      key(cp),
      key(endpointSettings),
      key(SystemProgram.programId),
      ...acc.send,
    ],
    data: Buffer.concat([disc("send_unlock"), sendParams(vault, pid, fee)]),
  });
  return { skipped: false, signature: await relaySend([ix], 600_000), fee: fee.toString() };
}

/**
 * Sends the payout of a recorded Claim (`send_pay_yield`) or Instant Claim (`send_pay_instant`) to the holder's linked EVM address.
 * Both claims share a layout and the same account list; only the claim PDA and the message type differ.
 */
async function sendPay(kind: "yield" | "instant", vault: string, pid: Buffer, holderAuthority: PublicKey, sourceIndex: unknown) {
  const conn = relayConn();
  const cp = corePositionPda(pid);
  const holder = coreAccountPda(holderAuthority);
  const core = await conn.getAccountInfo(cp);
  if (!core) throw new DemoHttpError(409, "not-opened", "The Lock is not open on Solana yet.");
  const advances = core.data.readUInt32LE(8 + 1 + 32 + 32 + 1 + 32 + 1 + 8 + 2 + 1);
  if (advances === 0) throw new DemoHttpError(409, "no-claim", "Nothing to pay out for this Lock.");
  const index = sourceIndex === undefined ? advances - 1 : sourceIndex;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= advances) throw new DemoHttpError(400, "bad-request", "Unknown Gemas source for this Lock.");
  const source = sourcePda(cp, index);
  const claimKey = kind === "yield" ? claimPda(holder, source) : instantClaimPda(holder, source);
  const [claim, account] = await conn.getMultipleAccountsInfo([claimKey, holder]);
  if (!claim || !account) throw new DemoHttpError(409, "no-claim", "Nothing to pay out for this Lock.");
  if (!new PublicKey(claim.data.subarray(8, 40)).equals(holder) || !new PublicKey(claim.data.subarray(40, 72)).equals(source) || !new PublicKey(claim.data.subarray(72, 104)).equals(cp)) throw new DemoHttpError(409, "no-claim", "That Claim does not belong to this Account.");
  if (claim.data.readBigUInt64LE(112) <= claim.data.readBigUInt64LE(120)) return { skipped: true };
  const evm = `0x${Buffer.from(account.data.subarray(41, 61)).toString("hex")}`;
  const acc = await sendAccounts(vault);
  const fee = await quoteFee(vault, kind === "yield" ? 4 : 5, acc.quote);
  const relayer = relayerKey();
  const { endpointSettings } = endpointPdas();
  const ix = new TransactionInstruction({
    programId: BRIDGE_ID,
    keys: [
      key(relayer.publicKey, true, true),
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
    data: Buffer.concat([disc(kind === "yield" ? "send_pay_yield" : "send_pay_instant"), sendParams(vault, pid, fee)]),
  });
  return { skipped: false, signature: await relaySend([ix], 600_000), fee: fee.toString() };
}

// ---- Advance (oracle price) ------------------------------------------------------------------------

/**
 * Devnet price feed for the Advance: Coinbase spot (ETH-USD or HYPE-USD) and CoinGecko asked at the same time, first in-bounds answer wins, refreshed at most every 60 s per asset. ETH falls
 * back to the $3,000 of docs/cross-chain.md for display; the Advance itself is refused while the price is not live.
 */
type Asset = EvmNet["native"];
const FALLBACK_MICRO_USD: Record<Asset, bigint> = { ETH: 3_000_000_000n, HYPE: 40_000_000n };
const PRICE_BOUNDS: Record<Asset, [number, number]> = { ETH: [100, 100_000], HYPE: [1, 10_000] };
const priceCache = new Map<Asset, { microUsd: bigint; at: number; live: boolean }>();
/**
 * Mainnet: the asset's Pyth push feed on Solana, the account `take_advance_onchain` reads. The quote is live while the feed is
 * young enough that the program will still accept it when the Player signs.
 */
async function pythPrice(asset: Asset): Promise<{ microUsd: bigint; live: boolean }> {
  const hit = priceCache.get(asset);
  if (hit && Date.now() - hit.at < 10_000) return hit;
  let fresh = { microUsd: FALLBACK_MICRO_USD[asset], at: Date.now(), live: false };
  try {
    const view = parsePythPrice(await relayConn().getAccountInfo(pythFeedAddress(asset)), asset);
    if (view && Date.now() / 1000 - view.updatedTs <= MAX_PRICE_AGE_SECS - PRICE_QUOTE_MARGIN_SECS) fresh = { microUsd: view.microUsd, at: Date.now(), live: true };
  } catch {
    // an unreadable feed is not live
  }
  priceCache.set(asset, fresh);
  return fresh;
}

export async function assetPrice(asset: Asset): Promise<{ microUsd: bigint; live: boolean }> {
  if (CLUSTER.priceSource === "onchain") return pythPrice(asset);
  const hit = priceCache.get(asset);
  if (hit && Date.now() - hit.at < 60_000) return hit;
  let microUsd = FALLBACK_MICRO_USD[asset];
  let live = false;
  const coingeckoId = asset === "ETH" ? "ethereum" : "hyperliquid";
  const sources: [string, (body: unknown) => unknown][] = [
    [`https://api.coinbase.com/v2/prices/${asset}-USD/spot`, (body) => (body as { data?: { amount?: string } }).data?.amount],
    [`https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=usd`, (body) => (body as Record<string, { usd?: number }>)[coingeckoId]?.usd],
  ];
  const [lo, hi] = PRICE_BOUNDS[asset];
  const asked = sources.map(async ([url, read]) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const amount = Number(read(await res.json()));
    if (!Number.isFinite(amount) || amount <= lo || amount >= hi) throw new Error("price out of bounds");
    return amount;
  });
  try {
    microUsd = BigInt(Math.round((await Promise.any(asked)) * 1e6));
    live = true;
  } catch {
    // every source failed or answered out of bounds
  }
  // A failed refresh keeps the last live price for up to 10 minutes instead of dropping to the display fallback.
  if (!live && hit?.live && Date.now() - hit.at < 10 * 60_000) {
    const kept = { ...hit, at: Date.now() - 50_000 };
    priceCache.set(asset, kept);
    return kept;
  }
  const fresh = { microUsd, at: Date.now(), live };
  priceCache.set(asset, fresh);
  return fresh;
}

async function advance(address: PublicKey, vault: string, pid: Buffer, months: number, sub: string | null) {
  const conn = relayConn();
  if (!Number.isInteger(months) || months < 1 || months > 12) throw new DemoHttpError(400, "bad-request", "Length must be 1 to 12 months.");
  const cp = corePositionPda(pid);
  const info = await conn.getAccountInfo(cp);
  if (!info) throw new DemoHttpError(409, "not-opened", "The Lock is not open on Solana yet.");
  const ownerAccount = coreAccountPda(address);
  if (!new PublicKey(info.data.subarray(41, 73)).equals(ownerAccount)) throw new DemoHttpError(403, "not-yours", "That Lock is not yours.");
  const base = 8 + 1 + 32 + 32 + 1 + 32 + 1 + 8 + 2 + 1;
  const advances = info.data.readUInt32LE(base);
  if (info.data[base + 4] === 1) throw new DemoHttpError(409, "advance-open", "This Lock already has an open Advance.");
  const asset = netOfVault(vault).native;
  const price = await assetPrice(asset);
  if (!price.live) throw new DemoHttpError(503, "no-price", `The ${asset} price is unavailable right now. Try again in a minute.`);
  if (!takeAll([[limits.advancePerAccount, address.toBase58()], ...perUser(limits.advancePerUser, sub)])) {
    throw new DemoHttpError(429, "rate-limited", "Advance limit reached for this Account. Try again tomorrow.");
  }
  const oracle = oracleKey();
  const source = sourcePda(cp, advances);
  // Mainnet: the program reads the Pyth feed itself (`take_advance_onchain`); the oracle names no price.
  const common = {
    oracle: oracle.publicKey,
    owner_authority: address,
    config: configPda(),
    treasury: treasuryPda(),
    owner_account: ownerAccount,
    protections: protectionsPda(ownerAccount),
    position: cp,
    source,
    book: bookPda(source),
    basket: basketPda(ownerAccount),
    spill: spillPda(ownerAccount),
  };
  const priceKey = onchainPricePda(new PublicKey(info.data.subarray(74, 106)));
  const ix = CLUSTER.priceSource === "onchain"
    ? coreIx("take_advance_onchain", { ...common, onchain_price: priceKey, price_feed: pythFeedAddress(asset) }, { horizon_months: months })
    // The oracle names the price; the asset's OnchainPrice address follows as the first remaining account (it must not exist to be used).
    : coreIx("take_advance", common, { horizon_months: months, price_micro_usd: price.microUsd }, [key(priceKey)]);
  const tx = new Transaction().add(ix);
  tx.feePayer = oracle.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.partialSign(oracle);
  return { source: source.toBase58(), priceMicroUsd: price.microUsd.toString(), transaction: tx.serialize({ requireAllSignatures: false }).toString("base64") };
}

// ---- entry points ----------------------------------------------------------------------------------

/** Public: the price the Advance would be issued at, for `asset` (ETH by default). */
export async function handleEthPrice(asset: string | null = null) {
  const p = await assetPrice(asset === "HYPE" ? "HYPE" : "ETH");
  return { priceMicroUsd: p.microUsd.toString(), live: p.live };
}

/** The chain a Position lives on, as the Player knows it: Ethereum for Hoodi, HyperEVM otherwise. */
export const chainName = (vault: string) => (netOfVault(vault).key === "hoodi" ? "Ethereum" : "HyperEVM");

/** A relay step that failed for a reason the Player cannot act on: names the Position's chain, says whether to retry. */
export function relayFailure(vault: string, e: unknown): DemoHttpError {
  const name = chainName(vault);
  if (isTransient(e)) return new DemoHttpError(503, "busy", `The ${name} network is busy. Try again in a few seconds.`);
  return new DemoHttpError(500, "error", `${name} Lock step failed.`);
}

export async function handleEthRequest(raw: unknown, authorization: string | null): Promise<unknown> {
  await requireDevnet(BASE_RPC);
  const { step, address, fields, sub } = await verifySignedRequest("tesoro-eth", STEPS, raw, authorization, { nonces });
  const wallet = address.toBase58();

  if (step === "fund-evm" || step === "fund-hype" || step === "faucet-lst" || step === "report-yield") requireTestMode();
  if (step === "fund-evm") return fundEvm(wallet, typeof fields.evm === "string" ? fields.evm : "", sub);
  if (step === "fund-hype") return fundHype(wallet, typeof fields.evm === "string" ? fields.evm : "", sub);
  if (step === "faucet-lst") return faucetLst(wallet, fields, sub);
  const ref = parseRef(fields);
  if (step === "advance") return advance(address, ref.vault, ref.pid, Number(fields.months), sub);
  const refund = takeAll([[limits.relayPerAccount, wallet], ...perUser(limits.relayPerUser, sub), [limits.relayGlobal, "all"]]);
  if (!refund) throw new DemoHttpError(429, "rate-limited", "Relay limit reached for this Account. Try again tomorrow.");
  try {
    switch (step) {
      case "init-position":
        return await initPosition(ref.vault, ref.id, ref.pid);
      case "apply-locked":
        return await applyLocked(ref.vault, ref.pid);
      case "apply-yield":
        return await applyYield(ref.vault, ref.pid).then((r) => (console.info("eth-bridge apply-yield", JSON.stringify(r)), r));
      case "report-yield":
        return await reportYieldFor(ref.vault, ref.id);
      case "send-unlock":
        return await sendUnlock(ref.vault, ref.pid);
      case "send-pay-instant":
        return await sendPay("instant", ref.vault, ref.pid, address, fields.sourceIndex);
      default:
        return await sendPay("yield", ref.vault, ref.pid, address, fields.sourceIndex);
    }
  } catch (e) {
    refund();
    throw e instanceof DemoHttpError ? e : relayFailure(ref.vault, e);
  }
}
