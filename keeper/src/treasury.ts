import { PublicKey, type AccountMeta, type TransactionInstruction } from "@solana/web3.js";
import { act, log, type Ctx } from "./act.ts";
import { RETRY_MS, due, nextTry } from "./counters.ts";
import { redeemTreasuryIx, type LineRefArg } from "./core-ix.ts";
import { redeemTreasuryToEvmIx } from "./bridge-ix.ts";
import { shortKey } from "./env.ts";
import { basketOf, decodeStore, keyOf, pda, spillOf, type StoreLine } from "./kit.ts";
import { custodyOf, payingAccounts, ratingAccounts, type Custody } from "./kind-pay.ts";
import { sendIxs, type SendOpts } from "./send.ts";
import { SIM_SOL_MINT, connReader, dedupe, supplySources, type Reader } from "./supply.ts";
import { simulate } from "./tee.ts";

/** A Redeem smaller than this many Gemas is left for a later pass, when more yield has landed. */
const MIN_GEMAS = BigInt(process.env.KEEPER_TREASURY_MIN_GEMAS ?? 100);
/** Redeems sent per pass, so the job stays short and the others get their turn. */
const MAX_PER_PASS = Number(process.env.KEEPER_TREASURY_MAX_PER_PASS ?? 4);
/** Dry runs spent finding how much of a line is repaid. */
const MAX_SEARCH = 14;

/** Lines of the Treasury Account's basket the job may redeem: playable (General or Extension class), not empty. */
export const redeemableLines = (lines: StoreLine[], minGemas = MIN_GEMAS) => lines.filter((l) => l.cls >= 3 && l.amount >= minGemas);

/** The Treasury's lines to try this pass: the largest first, at most `max`. */
export function planTreasuryRedeems(lines: StoreLine[], max = MAX_PER_PASS, minGemas = MIN_GEMAS): StoreLine[] {
  return redeemableLines(lines, minGemas)
    .sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1))
    .slice(0, max);
}

/**
 * The most Gemas of a line (at most `max`, at least `min`) that `works` accepts, assuming that what works for `k` works for
 * any smaller amount (a Redeem pays at most what has been repaid). Null when even `min` does not work. Each call of `works`
 * is a free dry run, so the number of calls is bounded.
 */
export async function largestRedeemable(min: bigint, max: bigint, works: (k: bigint) => Promise<boolean>, tries = MAX_SEARCH): Promise<bigint | null> {
  let calls = 0;
  const test = async (k: bigint) => (calls++ < tries ? works(k) : false);
  if (min > max || !(await test(min))) return null;
  if (await test(max)) return max;
  let lo = min;
  let hi = max;
  while (hi - lo > 1n && calls < tries) {
    const mid = lo + (hi - lo) / 2n;
    if (await test(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

export const lineRefOf = (l: StoreLine): LineRefArg => ({ side: l.side, dueAt: l.dueAt, cls: l.cls, tranche: l.tranche });

export interface TreasuryDeps {
  read: Reader;
  send(ixs: Parameters<typeof sendIxs>[2], opts: SendOpts): Promise<string>;
  simulate(ixs: TransactionInstruction[]): Promise<string | null>;
  now(): number;
}

export const realTreasuryDeps = (ctx: Ctx): TreasuryDeps => ({
  read: connReader(ctx.conn),
  send: (ixs, opts) => sendIxs(ctx.conn, ctx.payer, ixs, opts),
  simulate: (ixs) => simulate(ctx.conn, ctx.payer, ixs),
  now: () => Date.now(),
});

/**
 * Job 8: Treasury. The Treasury Account holds the Gemas Tesoro bought by Instant Redeem; once their Source's yield has
 * repaid them it redeems them, which refills the Treasury and is where the Yield Fee on bought Gemas is realised: the
 * Pool is owed its half of the fee and a fifth of the Instant fee (ticket 31). (SOL: `redeem_treasury` pays simSOL into the
 * Treasury vault; staking tokens stay in the custody vault as the Treasury's own shares; ETH and HYPE: bridge
 * `redeem_treasury_to_evm` records a Claim that the bridge job pays into the vault's own treasury with `send_pay_yield`).
 * A Redeem pays only the repaid part of a line, so a free dry run finds how much that is. Permissionless and bounded: at
 * most KEEPER_TREASURY_MAX_PER_PASS lines of at least KEEPER_TREASURY_MIN_GEMAS Gemas each per pass.
 */
export async function treasuryJob(ctx: Ctx, d: TreasuryDeps = realTreasuryDeps(ctx)): Promise<number> {
  const treasuryKey = pda("treasury");
  const [treasuryInfo] = await d.read.many([treasuryKey]);
  if (!treasuryInfo) {
    log("treasury", "-", "no Treasury yet");
    return 0;
  }
  const treasury: any = ctx.core.coder.accounts.decode("treasury", treasuryInfo.data);
  const account = keyOf(treasury.account);
  const vault = keyOf(treasury.vault);
  const [basket] = await d.read.many([basketOf(account)]);
  if (!basket) {
    log("treasury", "-", "the Treasury Account has no basket");
    return 0;
  }
  const lines = decodeStore(basket.data).lines();
  const plan = planTreasuryRedeems(lines.filter((l) => due(`treasury:${keyOfLine(l)}`, d.now())));
  let actions = 0;
  for (const line of plan) {
    const subject = `source=${shortKey(line.source)}`;
    try {
      const build = await redeemBuilder(ctx, d, line, vault, treasuryKey, account);
      if (!build) {
        log("treasury", subject, "SKIP the Source is not one the keeper can redeem");
        continue;
      }
      const best = await largestRedeemable(MIN_GEMAS < line.amount ? MIN_GEMAS : line.amount, line.amount, async (k) => (await d.simulate(await build.ixs(k))) === null);
      if (best === null) {
        nextTry.set(`treasury:${keyOfLine(line)}`, d.now() + RETRY_MS);
        log("treasury", subject, `wait: ${line.amount} Gemas, fewer than ${MIN_GEMAS} are repaid yet`);
        continue;
      }
      actions += +(await act(ctx, "treasury", subject, `${build.what} ${best} of ${line.amount} Gemas`, async () => d.send(await build.ixs(best), { units: 600_000 }))).ok;
    } catch (e) {
      log("treasury", subject, `ERROR ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`);
    }
  }
  log("treasury", "-", `${lines.length} line(s) in the Treasury Account, ${plan.length} tried, ${actions} redeemed`);
  return actions;
}

const keyOfLine = (l: StoreLine) => `${l.source.toBase58()}:${l.side}:${l.dueAt}:${l.cls}:${l.tranche}`;

async function redeemBuilder(
  ctx: Ctx,
  d: TreasuryDeps,
  line: StoreLine,
  vault: PublicKey,
  treasuryKey: PublicKey,
  account: PublicKey,
): Promise<{ what: string; ixs: (gemas: bigint) => Promise<TransactionInstruction[]> } | null> {
  const [src] = await d.read.many([line.source]);
  if (!src) return null;
  const position = keyOf((ctx.core.coder.accounts.decode("sourceState", src.data) as any).inner.position);
  const [pos] = await d.read.many([position]);
  if (!pos) return null;
  const decoded: any = ctx.core.coder.accounts.decode("positionState", pos.data);
  const books = (await supplySources(ctx.core, d.read, [{ source: line.source, cut: false }])).metas;
  const chain = Object.keys(decoded.inner.sourceChain)[0] as "solana" | "ethereum" | "hyperEvm";
  const ref = lineRefOf(line);
  if (chain !== "solana") {
    return {
      what: "redeem_treasury_to_evm (the bridge job pays the Claim)",
      ixs: async (gemas) => [redeemTreasuryToEvmIx({ payer: ctx.payer.publicKey, chain, treasury: treasuryKey, treasuryAccount: account, treasuryBasket: basketOf(account), treasurySpill: spillOf(account), position, source: line.source, line: ref, gemas, remaining: books })],
    };
  }
  const custody: Custody | null = await custodyOf(ctx.core, d.read, decoded, SIM_SOL_MINT);
  if (!custody) return null;
  const kind: AccountMeta[] = custody.kind === "native" ? payingAccounts(custody, vault) : ratingAccounts(custody);
  return { what: "redeem_treasury", ixs: async (gemas) => [await redeemTreasuryIx(ctx.core, { line: ref, amount: gemas, position, source: line.source, remaining: dedupe([...kind, ...books]) })] };
}

