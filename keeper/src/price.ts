import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { keypairSigner } from "../../app/src/games/block-puzzle/chain.ts";
import { PRICE_FEED, setPriceIx } from "../../app/src/lib/chain/native.ts";
import { act, log, type Ctx } from "./act.ts";

/** Refresh when the on-chain feed is older than this. `take_native_advance` rejects prices older than 24 h. */
const REFRESH_AFTER_SECS = Number(process.env.KEEPER_PRICE_REFRESH_SECS ?? 50 * 60);
/** Pyth Hermes SOL/USD price feed id. */
const PYTH_SOL_USD = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const FALLBACK_USD = 150;

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url.split("/")[2]} ${res.status}`);
  return res.json();
}

/** Public SOL/USD from Pyth Hermes, then CoinGecko, then Coinbase. Throws when both fail. */
export async function fetchSolUsd(): Promise<{ usd: number; source: string }> {
  const errors: string[] = [];
  try {
    const j = await getJson(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${PYTH_SOL_USD}&parsed=true`);
    const p = j.parsed?.[0]?.price;
    const usd = Number(p.price) * 10 ** Number(p.expo);
    if (usd > 1 && usd < 10_000) return { usd, source: "Pyth Hermes" };
    errors.push(`pyth out of range ${usd}`);
  } catch (e) {
    errors.push(`pyth: ${(e as Error).message}`);
  }
  try {
    const j = await getJson("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    const usd = Number(j.solana.usd);
    if (usd > 1 && usd < 10_000) return { usd, source: "CoinGecko" };
    errors.push(`coingecko out of range ${usd}`);
  } catch (e) {
    errors.push(`coingecko: ${(e as Error).message}`);
  }
  try {
    const j = await getJson("https://api.coinbase.com/v2/prices/SOL-USD/spot");
    const usd = Number(j.data.amount);
    if (usd > 1 && usd < 10_000) return { usd, source: "Coinbase" };
    errors.push(`coinbase out of range ${usd}`);
  } catch (e) {
    errors.push(`coinbase: ${(e as Error).message}`);
  }
  throw new Error(errors.join("; "));
}

let oracle: Keypair | null = null;
function oracleKey(): Keypair | null {
  if (oracle) return oracle;
  const path = process.env.KEEPER_ORACLE ?? join(homedir(), ".config/tesoro/oracle.json");
  if (!existsSync(path)) return null;
  oracle = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
  return oracle;
}

/**
 * Job 4: devnet price feed. The oracle key (`KEEPER_ORACLE`, `~/.config/tesoro/oracle.json`)
 * publishes SOL/USD with `set_price` at least hourly, since Advances are priced from the on-chain
 * feed and it must stay under 24 h old. Price: Pyth Hermes, else CoinGecko, else Coinbase, else the last value
 * (on chain, else $150). This is a DEVNET price feed, a stand-in until Pyth is read on chain.
 */
export async function priceJob(ctx: Ctx): Promise<number> {
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
    log("price", "-", "SKIP set_price: oracle keypair not found (KEEPER_ORACLE / ~/.config/tesoro/oracle.json)");
    return 0;
  }
  let usd: number;
  let source: string;
  try {
    ({ usd, source } = await fetchSolUsd());
  } catch (e) {
    usd = last?.usd ?? FALLBACK_USD;
    source = last ? "last value" : "default";
    log("price", "-", `WARN no public price (${(e as Error).message.slice(0, 160)}), using ${source} $${usd}`);
  }
  const micro = BigInt(Math.round(usd * 1e6));
  const r = await act(ctx, "price", "-", `set_price devnet price feed SOL $${usd.toFixed(2)} (${source})`, () =>
    ctx.bp.sendBase(keypairSigner(key), [setPriceIx(key.publicKey, micro)]),
  );
  return +r.ok;
}
