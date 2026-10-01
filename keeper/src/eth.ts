import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PublicKey } from "@solana/web3.js";
import { log, type Budget, type Ctx } from "./act.ts";
import { assertHoodi } from "./cluster.ts";
import { fetchBridgePositions } from "./bridge.ts";
import { EID_HOODI, bridgePositionPda } from "./lz.ts";
import type { Settings } from "./env.ts";
import { fetchWithBackoff } from "./runtime.ts";
import { evmKeyFromEnv } from "./keys.ts";

const status = (o: object) => Object.keys(o)[0];
const GWEI = 1_000_000_000n;

const hoodi = (rpc: string) =>
  defineChain({
    id: 560048,
    name: "Hoodi",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });

const vaultAbi = parseAbi([
  "function quoteYieldAccrued() view returns (uint256)",
  "function reportYield(uint64 id) payable",
  "function getPosition(uint64 id) view returns ((address owner,uint256 principalShares,uint256 principalUnderlying,uint256 openRate,uint256 heldShares,uint256 paidUnderlying,uint256 frozenAccrued,uint64 openTime,uint64 outSeq,uint64 inSeq,uint8 horizonMonths,bool unlocked))",
]);

/** `KEY=value` lines; the value never leaves this function except into the signer. */
function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/**
 * Per Position: when its last `reportYield` was sent (a number, receipt settled) or the send still waiting for its
 * receipt. Persisted, so a restart neither re-reports inside the window nor re-sends a transaction already out.
 */
export type Report = number | { sentAt: number; hash: Hex; estGwei: number };
export type State = Record<string, Report>;
const stateFile = join(process.env.KEEPER_STATE_DIR ?? join(homedir(), ".cache/tesoro-keeper"), "eth-yield.json");
const loadState = (): State => {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return {};
  }
};
const saveState = (s: State) => {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(s));
};

/** A sent `reportYield` that has no receipt and is unknown to the node after this is taken as dropped and sent again. */
const DROPPED_AFTER_MS = 15 * 60_000;

const eth = (wei: bigint) => (Number(wei) / 1e18).toFixed(6);

/** The viem calls the per-Position step uses (a public client and a wallet client in production, fakes in tests). */
export interface EthIo {
  pub: {
    readContract(args: any): Promise<any>;
    getTransactionReceipt(args: { hash: Hex }): Promise<{ status: "success" | "reverted"; gasUsed: bigint; effectiveGasPrice: bigint }>;
    getTransaction(args: { hash: Hex }): Promise<unknown>;
    getBalance(args: { address: Address }): Promise<bigint>;
    simulateContract(args: any): Promise<{ request: any }>;
    estimateContractGas(args: any): Promise<bigint>;
    getGasPrice(): Promise<bigint>;
  };
  wallet: { writeContract(request: any): Promise<Hex> };
  account: { address: Address };
}

export interface EthTarget {
  slot: string;
  vault: Address;
  id: bigint;
  /** Highest message seq the bridge has delivered for this Position. */
  inSeq: bigint;
  subject: string;
}

type Step = "sent" | "wait" | "skip" | "stop";

const errName = (e: unknown) => String((e as Error)?.name ?? "");

/**
 * Settles a `reportYield` sent on an earlier pass, never waiting for it: a receipt records the actual spend (the
 * estimate was counted at send) and starts the window; no receipt keeps it pending; no receipt and no transaction
 * after `DROPPED_AFTER_MS` clears it so the next pass sends again. An RPC error leaves it pending.
 */
async function settleSent(io: EthIo, budget: Budget, state: State, t: EthTarget, sent: Exclude<Report, number>, nowMs: number): Promise<Step> {
  try {
    const r = await io.pub.getTransactionReceipt({ hash: sent.hash });
    const gasGwei = Number((r.gasUsed * r.effectiveGasPrice) / GWEI);
    state[t.slot] = sent.sentAt;
    if (r.status === "success") {
      budget.record(sent.estGwei < gasGwei ? gasGwei - sent.estGwei : 0);
      log("eth", t.subject, `DONE reportYield confirmed tx=${sent.hash}`);
    } else {
      log("eth", t.subject, `FAIL reportYield reverted tx=${sent.hash}; next try after the window`);
    }
    return "skip";
  } catch (e) {
    if (!errName(e).includes("ReceiptNotFound")) {
      log("eth", t.subject, `wait: receipt of ${sent.hash} unreadable (${String((e as Error).message ?? e).split("\n")[0].slice(0, 120)})`);
      return "wait";
    }
  }
  if (nowMs - sent.sentAt >= DROPPED_AFTER_MS) {
    const known = await io.pub.getTransaction({ hash: sent.hash }).then(
      () => true,
      (e) => !errName(e).includes("TransactionNotFound"),
    );
    if (!known) {
      delete state[t.slot];
      log("eth", t.subject, `WARN reportYield ${sent.hash} dropped (no receipt after ${Math.round((nowMs - sent.sentAt) / 60_000)} min); sending again next pass`);
      return "skip";
    }
  }
  log("eth", t.subject, `wait: reportYield ${sent.hash} sent ${Math.round((nowMs - sent.sentAt) / 1000)}s ago, no receipt yet`);
  return "wait";
}

/**
 * One Ethereum Position: settle an earlier send, or send `reportYield` when it is due. The send is recorded (state
 * file and the hourly ETH budget, at its estimated cost) as soon as the transaction is out; its receipt is read on a
 * later pass, so a slow receipt can never cause a second send. `save` persists `state`.
 */
export async function reportStep(io: EthIo, s: Pick<Settings, "ethYieldMins" | "ethHourlyCapEth" | "dryRun">, budget: Budget, state: State, save: (s: State) => void, t: EthTarget, nowMs = Date.now()): Promise<Step> {
  const windowMs = s.ethYieldMins * 60_000;
  const prev = state[t.slot];
  if (prev !== undefined && typeof prev !== "number") {
    const r = await settleSent(io, budget, state, t, prev, nowMs);
    if (state[t.slot] !== prev) save(state);
    return r;
  }
  const last = prev;
  if (last && nowMs - last < windowMs) {
    log("eth", t.subject, `wait: reported ${Math.round((nowMs - last) / 1000)}s ago, next in ${Math.ceil((windowMs - (nowMs - last)) / 1000)}s`);
    return "wait";
  }
  const v = await io.pub.readContract({ address: t.vault, abi: vaultAbi, functionName: "getPosition", args: [t.id] });
  if (v.unlocked) {
    log("eth", t.subject, "SKIP: vault Position is unlocked");
    return "skip";
  }
  if (BigInt(v.outSeq) > t.inSeq && (!last || nowMs - last < Math.max(3 * windowMs, 30 * 60_000))) {
    log("eth", t.subject, `wait: message seq ${v.outSeq} still in flight to Solana (delivered up to ${t.inSeq})`);
    return "wait";
  }

  const quote: bigint = await io.pub.readContract({ address: t.vault, abi: vaultAbi, functionName: "quoteYieldAccrued" });
  const value = (quote * 120n) / 100n;
  const capGwei = BigInt(Math.round(s.ethHourlyCapEth * 1e9));
  const spentGwei = BigInt(budget.spentLastHour());
  if (spentGwei + quote / GWEI + 1n > capGwei) {
    log("eth", t.subject, `SKIP reportYield: hourly ETH cap reached (${eth(spentGwei * GWEI)} of ${s.ethHourlyCapEth} ETH)`);
    return "stop";
  }
  const balance = await io.pub.getBalance({ address: io.account.address });
  if (balance < value * 2n) {
    log("eth", t.subject, `SKIP reportYield: deployer balance ${eth(balance)} ETH is too low for fee ${eth(value)} ETH`);
    return "stop";
  }
  const call = { account: io.account, address: t.vault, abi: vaultAbi, functionName: "reportYield", args: [t.id], value };
  const sim = await io.pub.simulateContract(call);
  if (s.dryRun) {
    log("eth", t.subject, `DRY-RUN would reportYield (fee quote ${eth(quote)} ETH, sending ${eth(value)} ETH, excess refunded)`);
    return "skip";
  }
  const [gas, gasPrice] = await Promise.all([io.pub.estimateContractGas(call), io.pub.getGasPrice()]);
  const estGwei = Number(quote / GWEI + (gas * gasPrice) / GWEI);
  const hash = await io.wallet.writeContract({ ...sim.request, gas });
  state[t.slot] = { sentAt: Date.now(), hash, estGwei };
  save(state);
  budget.record(estGwei);
  log("eth", t.subject, `SENT reportYield (LayerZero fee ${eth(quote)} ETH, est. ${eth(BigInt(estGwei) * GWEI)} ETH in all) tx=${hash}; receipt read next pass`);
  return "sent";
}

let hoodiChecked = "";

/** At startup: refuses an EVM RPC that answers with another chain id; an unreachable one is rechecked by the job. */
export async function checkHoodiAtStart(rpc: string, warn: (m: string) => void): Promise<void> {
  let id: number;
  try {
    id = await createPublicClient({ transport: http(rpc, { fetchFn: fetchWithBackoff as typeof fetch, retryCount: 1 }) }).getChainId();
  } catch (e) {
    warn(`WARN Hoodi RPC unreachable at start (${String((e as Error).message ?? e).split("\n")[0].slice(0, 120)}); the eth job checks it before sending`);
    return;
  }
  await assertHoodi({ getChainId: async () => id });
  hoodiChecked = rpc;
}

/**
 * Job 6: ETH yield. A Position sourced from Ethereum (Hoodi) with Debt (tesoro_core `open_advance` set) needs the
 * vault's yield reported to Solana so its Debt falls: `PositionVaultOApp.reportYield(id)` is permissionless and payable
 * with the LayerZero fee, paid here from the EVM deployer key (~/.config/tesoro/evm-deployer.env, never printed) as
 * quote + 20% (the excess is refunded to the caller). Once it is delivered (about 2 min) the Solana side is applied by the
 * bridge job's `apply_yield`. Default cadence: one Position per 10 minutes = one simulated month.
 *
 * Skipped: a Position reported inside the window or whose last send has no receipt yet (state file), one whose last
 * message is still in flight (the vault's `outSeq` is ahead of the bridge's `last_in_seq`), an unlocked one, and
 * everything when the hourly ETH cap is used or the RPC is not Hoodi. Returns the number of reports sent.
 */
export async function ethYieldJob(ctx: Ctx): Promise<number> {
  const s = ctx.settings;
  const all: any[] = await ctx.core.account.positionState.all();
  const owing = all.filter((p) => {
    const i = p.account.inner;
    return status(i.sourceChain) === "ethereum" && status(i.status) === "locked" && i.openAdvance !== null && i.openAdvance !== undefined;
  });
  if (!owing.length) {
    log("eth", "-", `no Ethereum Position with Debt (${all.filter((p) => status(p.account.inner.sourceChain) !== "solana").length} non-Solana Position(s) in total)`);
    return 0;
  }
  let key: string | undefined = evmKeyFromEnv("KEEPER_EVM_PRIVATE_KEY");
  if (!key) {
    if (!existsSync(s.evmEnvPath)) {
      log("eth", "-", `SKIP ${owing.length} Position(s) with Debt: no EVM key (KEEPER_EVM_PRIVATE_KEY or ${s.evmEnvPath})`);
      return 0;
    }
    key = readEnvFile(s.evmEnvPath).EVM_DEPLOYER_PRIVATE_KEY;
    if (!key) {
      log("eth", "-", "SKIP: EVM_DEPLOYER_PRIVATE_KEY missing in the env file");
      return 0;
    }
  }
  const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex);
  const chain = hoodi(s.hoodiRpc);
  const transport = http(s.hoodiRpc, { fetchFn: fetchWithBackoff as typeof fetch, retryCount: 2 });
  const pub = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account, chain, transport });
  if (hoodiChecked !== s.hoodiRpc) {
    await assertHoodi(pub);
    hoodiChecked = s.hoodiRpc;
  }
  const io: EthIo = { pub: pub as unknown as EthIo["pub"], wallet: wallet as unknown as EthIo["wallet"], account };

  const bridge = new Map((await fetchBridgePositions(ctx)).map((p) => [p.key.toBase58(), p]));
  const state = loadState();
  let sent = 0;
  let waiting = 0;

  for (const { publicKey, account: pos } of owing) {
    const positionId = Uint8Array.from(pos.positionId);
    const vault = getAddress(`0x${Buffer.from(positionId.subarray(0, 20)).toString("hex")}`) as Address;
    const id = Buffer.from(positionId).readBigUInt64BE(20);
    const target: EthTarget = {
      slot: `${vault}#${id}`,
      vault,
      id,
      inSeq: bridge.get(bridgePositionPda(EID_HOODI, positionId).toBase58())?.lastInSeq ?? 0n,
      subject: `eth vault=${vault.slice(0, 8)}..${vault.slice(-4)}#${id} position=${(publicKey as PublicKey).toBase58().slice(0, 4)}`,
    };
    try {
      const r = await reportStep(io, s, ctx.eth, state, saveState, target);
      if (r === "sent") sent++;
      if (r === "wait") waiting++;
      if (r === "stop") break;
    } catch (e) {
      log("eth", target.subject, `FAIL reportYield: ${String((e as Error).message ?? e).split("\n")[0].slice(0, 300)}`);
    }
  }
  log("eth", "-", `${owing.length} Ethereum Position(s) with Debt, ${waiting} waiting, ${sent} report(s) sent, ${(ctx.eth.spentLastHour() / 1e9).toFixed(6)} ETH spent this hour`);
  return sent;
}
