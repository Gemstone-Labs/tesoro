import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { keypairSigner } from "../../app/src/games/block-puzzle/chain.ts";
import { PRICE_FEED, setPriceIx } from "../../app/src/lib/chain/native.ts";
import { act, log, type Ctx } from "./act.ts";
import { readKeypair } from "./env.ts";
import { keypairFromEnv } from "./keys.ts";
import { keeperCluster } from "./cluster.ts";
import type { ClusterSettings } from "../../app/src/lib/cluster-settings.ts";

/** Refresh when the on-chain feed is older than this. `take_native_advance` rejects prices older than 24 h. */
const REFRESH_AFTER_SECS = Number(process.env.KEEPER_PRICE_REFRESH_SECS ?? 50 * 60);
/** Pyth Hermes SOL/USD price feed id. */
const PYTH_SOL_USD = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
/** A Pyth update older than this, or with a confidence band wider than this share of the price, is not used. */
const PYTH_MAX_AGE_SECS = 120;
const PYTH_MAX_CONF = 0.02;
/** A lone source may move the published price at most this much; a larger move needs two sources that agree. */
const SINGLE_SOURCE_MAX_MOVE = 0.25;

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url.split("/")[2]} ${res.status}`);
  return res.json();
}

const inRange = (usd: number) => Number.isFinite(usd) && usd > 1 && usd < 10_000;

async function pyth(): Promise<number> {
  const j = await getJson(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${PYTH_SOL_USD}&parsed=true`);
  const p = j.parsed?.[0]?.price;
  const scale = 10 ** Number(p.expo);
  const usd = Number(p.price) * scale;
  const age = Date.now() / 1000 - Number(p.publish_time);
  if (!(age <= PYTH_MAX_AGE_SECS)) throw new Error(`stale (${Math.round(age)} s)`);
  if (!(Number(p.conf) * scale <= usd * PYTH_MAX_CONF)) throw new Error(`confidence ${Number(p.conf) * scale}`);
  return usd;
}

const SOURCES: [string, () => Promise<number>][] = [
  ["Pyth Hermes", pyth],
  ["CoinGecko", async () => Number((await getJson("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd")).solana.usd)],
  ["Coinbase", async () => Number((await getJson("https://api.coinbase.com/v2/prices/SOL-USD/spot")).data.amount)],
];

/**
 * Public SOL/USD: every source is asked, out-of-range answers are dropped. Two or more give their median. A single
 * source is used only while it stays within `SINGLE_SOURCE_MAX_MOVE` of `lastUsd`. Throws when nothing qualifies.
 */
export async function fetchSolUsd(lastUsd: number | null): Promise<{ usd: number; source: string }> {
  const settled = await Promise.allSettled(SOURCES.map(([, f]) => f()));
  const quotes: { usd: number; source: string }[] = [];
  const errors: string[] = [];
  settled.forEach((r, i) => {
    const name = SOURCES[i][0];
    if (r.status === "rejected") errors.push(`${name}: ${(r.reason as Error).message}`);
    else if (!inRange(r.value)) errors.push(`${name} out of range ${r.value}`);
    else quotes.push({ usd: r.value, source: name });
  });
  if (quotes.length >= 2) {
    quotes.sort((a, b) => a.usd - b.usd);
    const usd = quotes.length % 2 ? quotes[(quotes.length - 1) / 2].usd : (quotes[quotes.length / 2 - 1].usd + quotes[quotes.length / 2].usd) / 2;
    return { usd, source: `median of ${quotes.map((q) => q.source).join(", ")}` };
  }
  if (quotes.length === 1) {
    const q = quotes[0];
    if (lastUsd === null || Math.abs(q.usd / lastUsd - 1) <= SINGLE_SOURCE_MAX_MOVE) return q;
    errors.push(`${q.source} alone moves $${lastUsd} to $${q.usd}`);
  }
  throw new Error(errors.join("; "));
}

/** The keeper writes the Advance price in test mode only; on mainnet Advances read the Pyth feeds (ADR 0011) and this job does nothing. */
export const priceJobEnabled = (cluster: ClusterSettings = keeperCluster()) => cluster.priceSource === "keeper";

let oracle: Keypair | null = null;
export function oracleKey(): Keypair | null {
  if (oracle) return oracle;
  const secret = keypairFromEnv("KEEPER_ORACLE_SECRET_KEY");
  if (secret) return (oracle = secret);
  const path = process.env.KEEPER_ORACLE ?? join(homedir(), ".config/tesoro/oracle.json");
  if (!existsSync(path)) return null;
  oracle = readKeypair(path);
  return oracle;
}

/**
 * Job 4: devnet price feed. The oracle key (`KEEPER_ORACLE`, `~/.config/tesoro/oracle.json`)
 * publishes SOL/USD with `set_price` at least hourly, since Advances are priced from the on-chain
 * feed and it must stay under 24 h old. Price: see `fetchSolUsd`. With no usable public price nothing is published:
 * re-stamping the last value would make an old price look fresh to `take_native_advance`'s 24 h check.
 * This is a DEVNET price feed, a stand-in until Pyth is read on chain.
 */
export async function priceJob(ctx: Ctx, cluster: ClusterSettings = keeperCluster()): Promise<number> {
  if (!priceJobEnabled(cluster)) return 0;
  const info = await ctx.conn.getAccountInfo(PRICE_FEED, "confirmed");
  let last: { usd: number; updated: number } | null = null;
  if (info && info.data.length >= 57) {
    const d = Buffer.from(info.data);
    last = { usd: Number(d.readBigUInt64LE(41)) / 1e6, updated: Number(d.readBigInt64LE(49)) };
  }
  const age = last ? ctx.now - last.updated : Infinity;
  if (last && age < REFRESH_AFTER_SECS) {
    log("price", "-", `ok devnet price feed SOL $${last.usd.toFixed(2)}, ${Math.round(age / 60)} min old`);
    return 0;
  }
  const key = oracleKey();
  if (!key) {
    log("price", "-", "SKIP set_price: oracle keypair not found (KEEPER_ORACLE_SECRET_KEY / KEEPER_ORACLE / ~/.config/tesoro/oracle.json)");
    return 0;
  }
  let quote: { usd: number; source: string };
  try {
    quote = await fetchSolUsd(last?.usd ?? null);
  } catch (e) {
    log("price", "-", `WARN SKIP set_price: no usable public price (${(e as Error).message.slice(0, 200)}); feed is ${last ? `${Math.round(age / 60)} min` : "never"} old`);
    return 0;
  }
  const micro = BigInt(Math.round(quote.usd * 1e6));
  const r = await act(ctx, "price", "-", `set_price devnet price feed SOL $${quote.usd.toFixed(2)} (${quote.source})`, () =>
    ctx.bp.sendBase(keypairSigner(key), [setPriceIx(key.publicKey, micro)]),
  );
  return +r.ok;
}
