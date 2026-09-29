import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PublicKey } from "@solana/web3.js";
import { log, type Ctx } from "./act.ts";
import { fetchBridgePositions } from "./bridge.ts";
import { EID_HOODI, bridgePositionPda } from "./lz.ts";
import { rateLimit } from "./runtime.ts";

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

/** fetch that retries 429s with exponential backoff, like the Solana connection. */
async function fetchWithBackoff(input: any, init?: any): Promise<Response> {
  for (let i = 0; ; i++) {
    const res = await fetch(input, init);
    if (res.status !== 429 || i >= 5) return res;
    rateLimit.hits++;
    await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
  }
}

/** When each Position last had a `reportYield` sent, so a restart does not re-report inside the window. */
const stateFile = join(process.env.KEEPER_STATE_DIR ?? join(homedir(), ".cache/tesoro-keeper"), "eth-yield.json");
const loadState = (): Record<string, number> => {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return {};
  }
};
const saveState = (s: Record<string, number>) => {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(s));
};

const eth = (wei: bigint) => (Number(wei) / 1e18).toFixed(6);

/**
 * Job 6: ETH yield. A Position sourced from Ethereum (Hoodi) with Debt (tesoro_core `open_advance` set) needs the
 * vault's yield reported to Solana so its Debt falls: `PositionVaultOApp.reportYield(id)` is permissionless and payable
 * with the LayerZero fee, paid here from the EVM deployer key (~/.config/tesoro/evm-deployer.env, never printed) as
 * quote + 20% (the excess is refunded to the caller). Once it is delivered (about 2 min) the Solana side is applied by the
 * bridge job's `apply_yield`. Default cadence: one Position per 10 minutes = one simulated month.
 *
 * Skipped: a Position reported inside the window (state file), one whose last message is still in flight (the vault's
 * `outSeq` is ahead of the bridge's `last_in_seq`), an unlocked one, and everything when the hourly ETH cap is used.
 * Returns the number of reports sent.
 */
export async function ethYieldJob(ctx: Ctx): Promise<number> {
  const s = ctx.settings;
  const windowMs = s.ethYieldMins * 60_000;
  const all: any[] = await ctx.core.account.positionState.all();
  const owing = all.filter((p) => {
    const i = p.account.inner;
    return status(i.sourceChain) === "ethereum" && status(i.status) === "locked" && i.openAdvance !== null && i.openAdvance !== undefined;
  });
  if (!owing.length) {
    log("eth", "-", `no Ethereum Position with Debt (${all.filter((p) => status(p.account.inner.sourceChain) !== "solana").length} non-Solana Position(s) in total)`);
    return 0;
  }
  if (!existsSync(s.evmEnvPath)) {
    log("eth", "-", `SKIP ${owing.length} Position(s) with Debt: no EVM key at ${s.evmEnvPath}`);
    return 0;
  }
  const key = readEnvFile(s.evmEnvPath).EVM_DEPLOYER_PRIVATE_KEY;
  if (!key) {
    log("eth", "-", "SKIP: EVM_DEPLOYER_PRIVATE_KEY missing in the env file");
    return 0;
  }
  const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex);
  const chain = hoodi(s.hoodiRpc);
  const transport = http(s.hoodiRpc, { fetchFn: fetchWithBackoff as typeof fetch, retryCount: 2 });
  const pub = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account, chain, transport });

  const bridge = new Map((await fetchBridgePositions(ctx)).map((p) => [p.key.toBase58(), p]));
  const state = loadState();
  const now = Date.now();
  let sent = 0;
  let waiting = 0;

  for (const { publicKey, account: pos } of owing) {
    const positionId = Uint8Array.from(pos.positionId);
    const vault = getAddress(`0x${Buffer.from(positionId.subarray(0, 20)).toString("hex")}`) as Address;
    const id = Buffer.from(positionId).readBigUInt64BE(20);
    const slot = `${vault}#${id}`;
    const subject = `eth vault=${vault.slice(0, 8)}..${vault.slice(-4)}#${id} position=${(publicKey as PublicKey).toBase58().slice(0, 4)}`;
    try {
      const last = state[slot];
      if (last && now - last < windowMs) {
        waiting++;
        log("eth", subject, `wait: reported ${Math.round((now - last) / 1000)}s ago, next in ${Math.ceil((windowMs - (now - last)) / 1000)}s`);
        continue;
      }
      const v = await pub.readContract({ address: vault, abi: vaultAbi, functionName: "getPosition", args: [id] });
      if (v.unlocked) {
        log("eth", subject, "SKIP: vault Position is unlocked");
        continue;
      }
      const inSeq = bridge.get(bridgePositionPda(EID_HOODI, positionId).toBase58())?.lastInSeq ?? 0n;
      if (BigInt(v.outSeq) > inSeq && (!last || now - last < Math.max(3 * windowMs, 30 * 60_000))) {
        waiting++;
        log("eth", subject, `wait: message seq ${v.outSeq} still in flight to Solana (delivered up to ${inSeq})`);
        continue;
      }

      const quote = await pub.readContract({ address: vault, abi: vaultAbi, functionName: "quoteYieldAccrued" });
      const value = (quote * 120n) / 100n;
      const capGwei = BigInt(Math.round(s.ethHourlyCapEth * 1e9));
      const spentGwei = BigInt(ctx.eth.spentLastHour());
      if (spentGwei + quote / GWEI + 1n > capGwei) {
        log("eth", subject, `SKIP reportYield: hourly ETH cap reached (${eth(spentGwei * GWEI)} of ${s.ethHourlyCapEth} ETH)`);
        break;
      }
      const balance = await pub.getBalance({ address: account.address });
      if (balance < value * 2n) {
        log("eth", subject, `SKIP reportYield: deployer balance ${eth(balance)} ETH is too low for fee ${eth(value)} ETH`);
        break;
      }
      const sim = await pub.simulateContract({ account, address: vault, abi: vaultAbi, functionName: "reportYield", args: [id], value });
      if (s.dryRun) {
        log("eth", subject, `DRY-RUN would reportYield (fee quote ${eth(quote)} ETH, sending ${eth(value)} ETH, excess refunded)`);
        continue;
      }
      const hash = await wallet.writeContract(sim.request);
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== "success") throw new Error(`reverted ${hash}`);
      ctx.eth.record(Number(quote / GWEI + (receipt.gasUsed * receipt.effectiveGasPrice) / GWEI));
      state[slot] = Date.now();
      saveState(state);
      sent++;
      log("eth", subject, `DONE reportYield (LayerZero fee ${eth(quote)} ETH) tx=${hash}`);
    } catch (e) {
      log("eth", subject, `FAIL reportYield: ${String((e as Error).message ?? e).split("\n")[0].slice(0, 300)}`);
    }
  }
  log("eth", "-", `${owing.length} Ethereum Position(s) with Debt, ${waiting} waiting, ${sent} report(s) sent, ${(ctx.eth.spentLastHour() / 1e9).toFixed(6)} ETH spent this hour`);
  return sent;
}
