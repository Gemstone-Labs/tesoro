import { PublicKey } from "@solana/web3.js";
import { createPublicClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { log, type Ctx } from "./act.ts";
import { AlertManager, alertConfig, conditionsOf, postAlert, readBalances, type AlertConfig, type Watch } from "./alerts.ts";
import { keeperCluster } from "./cluster.ts";
import { NETS } from "./evm-nets.ts";
import type { Health } from "./health.ts";
import { jobs } from "./job-stats.ts";
import { evmKeyFromEnv } from "./keys.ts";
import { fetchWithBackoff } from "./runtime.ts";

/** The keys to watch: SOL for keeper, oracle and relayer; the native token of the keeper and relayer EVM keys on each EVM chain. */
export function watches(ctx: Ctx, cfg: AlertConfig, env: NodeJS.ProcessEnv = process.env): Watch[] {
  const out: Watch[] = [];
  const sol = (who: "keeper" | "oracle" | "relayer", address: string | undefined) =>
    address && out.push({ key: `balance:${who}:solana`, label: `${who} on Solana`, unit: "SOL", min: cfg.minSol[who], address, net: "solana" });
  sol("keeper", ctx.payer.publicKey.toBase58());
  sol("oracle", cfg.addresses.oracleSol);
  sol("relayer", cfg.addresses.relayerSol);
  const keeperKey = evmKeyFromEnv("KEEPER_EVM_PRIVATE_KEY", env);
  const evm = { keeper: cfg.addresses.keeperEvm ?? (keeperKey ? privateKeyToAccount(keeperKey).address : undefined), relayer: cfg.addresses.relayerEvm };
  for (const who of ["keeper", "relayer"] as const) {
    const address = evm[who];
    if (!address) continue;
    for (const net of NETS) out.push({ key: `balance:${who}:${net.chain}`, label: `${who} on ${net.name}`, unit: net.unit, min: (net.unit === "ETH" ? cfg.minEth : cfg.minHype)[who], address, net: net.chain });
  }
  return out;
}

async function balanceOf(ctx: Ctx, w: Watch): Promise<number> {
  if (w.net === "solana") return (await ctx.conn.getBalance(new PublicKey(w.address))) / 1e9;
  const net = NETS.find((n) => n.chain === w.net)!;
  const rpc = net.rpc(ctx.settings);
  const pub = createPublicClient({ chain: net.chainDef(rpc), transport: http(rpc, { fetchFn: fetchWithBackoff as typeof fetch, retryCount: 1 }) });
  return Number(await pub.getBalance({ address: w.address as Address })) / 1e18;
}

/**
 * Emails the founders (through the app's /api/notify/alert) when commits stay pending, a job stops succeeding or a
 * key balance runs low. Off without NOTIFY_URL and NOTIFY_SECRET. Returns the number of conditions active.
 */
export function alertsJob(health: Health, env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch) {
  const cfg = alertConfig(env);
  const base = env.NOTIFY_URL;
  const secret = env.NOTIFY_SECRET;
  const manager = base && secret ? new AlertManager((a) => postAlert(base, secret, a, fetchFn), cfg.reminderMs, keeperCluster().id) : null;
  if (!manager) log("alerts", "-", "off: NOTIFY_URL and NOTIFY_SECRET are not both set");
  return async (ctx: Ctx): Promise<number> => {
    if (!manager) return 0;
    const balances = await readBalances(watches(ctx, cfg, env), (w) => balanceOf(ctx, w));
    const active = conditionsOf({ health: health.status(), jobs: jobs.entries(), balances }, cfg, Date.now());
    for (const c of active) log("alerts", c.key, `ACTIVE ${c.title}`);
    await manager.update(active);
    return active.length;
  };
}
