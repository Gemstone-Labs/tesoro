import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { keypairSigner } from "../../app/src/games/block-puzzle/chain.ts";
import { TESORO_CORE_ID } from "../../app/src/lib/chain/native.ts";
import { parseSolSource, parseStakePool, parseTokenApy, setTokenApyIx, solSourcePda, stakePoolRate, tokenApyPda } from "../../app/src/lib/chain/stake-pool.ts";
import { act, log, type Ctx } from "./act.ts";
import { oracleKey } from "./price.ts";

const DAY = 86_400;
const YEAR = 365 * DAY;
/** The window the published APY covers. */
export const WINDOW_DAYS = 30;
/** Fewer days of history than this and nothing is published (a short window is too noisy to size an Advance on). */
export const MIN_DAYS = Number(process.env.KEEPER_STAKE_APY_MIN_DAYS ?? 7);
/** The APY is republished when the on-chain one is older than this; the program refuses one older than 3 days. */
export const PUBLISH_EVERY_SECS = 22 * 3600;
const MAX_APY_BPS = 10_000n;

/** One daily reading of a stake pool's exchange rate (`total_lamports / pool_token_supply`, scaled 1e9). */
export interface Sample {
  ts: number;
  rate: string;
}

const dayOf = (ts: number) => Math.floor(ts / DAY);

/** Adds the reading, one sample per UTC day (the day's latest wins), and drops samples older than the window plus a day. */
export function addSample(samples: Sample[], ts: number, rate: bigint): Sample[] {
  const kept = samples.filter((s) => s.ts >= ts - (WINDOW_DAYS + 1) * DAY && s.ts <= ts);
  const last = kept[kept.length - 1];
  if (last && dayOf(last.ts) === dayOf(ts)) kept.pop();
  kept.push({ ts, rate: rate.toString() });
  return kept;
}

/**
 * The trailing APY in basis points a year, linear (growth over the span scaled to a year, which is how Advances size
 * their projected yield): from the oldest sample inside the last 30 days to the newest. Null with less than `minDays`
 * of history. A falling rate gives 0; the result is capped at the program's 100%.
 */
export function trailingApyBps(samples: Sample[], nowTs: number, minDays = MIN_DAYS): number | null {
  const window = samples.filter((s) => s.ts >= nowTs - WINDOW_DAYS * DAY && s.ts <= nowTs);
  if (window.length < 2) return null;
  const base = window[0];
  const cur = window[window.length - 1];
  const span = cur.ts - base.ts;
  const from = BigInt(base.rate);
  if (span < minDays * DAY || from <= 0n) return null;
  const grown = BigInt(cur.rate) - from;
  if (grown <= 0n) return 0;
  const bps = (grown * 10_000n * BigInt(YEAR)) / (from * BigInt(span));
  return Number(bps > MAX_APY_BPS ? MAX_APY_BPS : bps);
}

/** Publish when nothing is on chain yet or the on-chain APY is `PUBLISH_EVERY_SECS` old. */
export const publishDue = (onchainUpdatedTs: number | null, nowTs: number) => onchainUpdatedTs === null || nowTs - onchainUpdatedTs >= PUBLISH_EVERY_SECS;

/** One pass: records the reading and says what, if anything, to publish. Pure, so the cadence is testable. */
export function planApy(samples: Sample[], nowTs: number, rate: bigint, onchainUpdatedTs: number | null): { samples: Sample[]; apyBps: number | null; publish: boolean } {
  const next = addSample(samples, nowTs, rate);
  const apyBps = trailingApyBps(next, nowTs);
  return { samples: next, apyBps, publish: apyBps !== null && publishDue(onchainUpdatedTs, nowTs) };
}

const stateFile = (mint: string) => join(process.env.KEEPER_STATE_DIR ?? join(homedir(), ".cache/tesoro-keeper"), `stake-apy-${mint}.json`);
const load = (mint: string): Sample[] => {
  try {
    const s = JSON.parse(readFileSync(stateFile(mint), "utf8"));
    return Array.isArray(s) ? s.filter((x) => Number.isFinite(x?.ts) && typeof x?.rate === "string") : [];
  } catch {
    return [];
  }
};
const save = (mint: string, samples: Sample[]) => {
  const file = stateFile(mint);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(samples));
  renameSync(`${file}.tmp`, file);
};

/**
 * Job: the trailing 30-day APY of the active staking token (mainnet, ADR 0010). Samples the stake pool's exchange rate once
 * a day into the keeper state dir, and once at least `MIN_DAYS` of samples exist publishes the trailing APY daily with the
 * oracle key (`set_token_apy`). Advances and Extends size on min(published, the admin's ceiling) and refuse an APY older than
 * 3 days, so a keeper that stops publishing stops new Advances. Does nothing where no `SolSource` is set (test mode).
 */
export async function stakeApyJob(ctx: Ctx): Promise<number> {
  const srcInfo = await ctx.conn.getAccountInfo(solSourcePda(), "confirmed");
  const source = srcInfo && srcInfo.owner.equals(TESORO_CORE_ID) ? parseSolSource(srcInfo.data) : null;
  if (!source) return 0;
  const [poolInfo, apyInfo] = await ctx.conn.getMultipleAccountsInfo([source.pool, tokenApyPda(source.mint)], "confirmed");
  const view = poolInfo ? parseStakePool(poolInfo.data) : null;
  const rate = view && view.poolMint.equals(source.mint) ? stakePoolRate(view.totalLamports, view.poolTokenSupply) : null;
  if (!rate) {
    log("apy", "-", `WARN stake pool of ${source.mint.toBase58()} not readable; no sample`);
    return 0;
  }
  const onchain = apyInfo && apyInfo.owner.equals(TESORO_CORE_ID) ? parseTokenApy(apyInfo.data) : null;
  const mint = source.mint.toBase58();
  const plan = planApy(load(mint), ctx.now, rate, onchain?.updatedTs ?? null);
  save(mint, plan.samples);
  if (plan.apyBps === null) {
    log("apy", "-", `ok sampling ${mint}: ${plan.samples.length} daily sample(s), publishing from ${MIN_DAYS} days of history`);
    return 0;
  }
  if (!plan.publish) {
    log("apy", "-", `ok trailing APY ${plan.apyBps / 100}% published ${Math.round((ctx.now - onchain!.updatedTs) / 3600)} h ago`);
    return 0;
  }
  const key = oracleKey();
  if (!key) {
    log("apy", "-", "SKIP set_token_apy: oracle keypair not found (KEEPER_ORACLE_SECRET_KEY / KEEPER_ORACLE)");
    return 0;
  }
  const r = await act(ctx, "apy", "-", `set_token_apy ${mint} trailing 30-day APY ${plan.apyBps / 100}% (${plan.samples.length} samples)`, () =>
    ctx.bp.sendBase(keypairSigner(key), [setTokenApyIx(key.publicKey, source.mint, plan.apyBps!)]),
  );
  return +r.ok;
}
