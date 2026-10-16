import { ComputeBudgetProgram, type PublicKey } from "@solana/web3.js";
import { act, log, type Ctx } from "./act.ts";
import { shortKey } from "./env.ts";
import { eidOf, redeemTreasuryToEvmIx } from "./lz.ts";
import { pk } from "./runtime.ts";
import { simulate } from "./tee.ts";
import { redeemableFor, type SourceMath } from "../../app/src/lib/chain/ledger.ts";
import { POOL, poolSpeedup, redeemTreasuryIx, sourceAtClock, treasuryAccountPda } from "../../app/src/lib/chain/native.ts";

const status = (o: object) => Object.keys(o)[0];

/** A Redeem smaller than this many Gemas is left for a later pass, when more yield has landed. */
const MIN_GEMAS = BigInt(process.env.KEEPER_TREASURY_MIN_GEMAS ?? 100);
/** Redeems sent per pass, so the job stays short and the others get their turn. */
const MAX_PER_PASS = Number(process.env.KEEPER_TREASURY_MAX_PER_PASS ?? 4);

/** One Holding of the Treasury Account: Gemas it bought by Instant Redeem. */
export interface TreasuryHolding {
  holding: PublicKey;
  source: PublicKey;
  position: PublicKey;
  /** Gemas of the Holding not reserved (all of them: nobody can enter the Treasury Account in a Match). */
  free: bigint;
  math: SourceMath;
  chain: "solana" | "ethereum" | "hyperEvm";
  positionId: Uint8Array;
}

export interface TreasuryRedeem {
  holding: TreasuryHolding;
  gemas: bigint;
}

/**
 * Which Holdings the Treasury Account redeems this pass: those whose pro rata share of the Source's repaid Gemas
 * (`redeemableFor`, the normal Redeem rule) is at least `minGemas`, the largest first, at most `max`.
 */
export function planTreasuryRedeems(rows: TreasuryHolding[], max = MAX_PER_PASS, minGemas = MIN_GEMAS): TreasuryRedeem[] {
  return rows
    .map((holding) => ({ holding, gemas: redeemableFor(holding.math, holding.free) }))
    .filter((r) => r.gemas > 0n && r.gemas >= minGemas)
    .sort((a, b) => (a.gemas === b.gemas ? 0 : a.gemas > b.gemas ? -1 : 1))
    .slice(0, max);
}

const big = (x: any) => BigInt(x.toString());
const mathOf = (inner: any): SourceMath => ({
  issued: big(inner.issued),
  returned: big(inner.returned),
  redeemed: big(inner.redeemed),
  yieldUnits: big(inner.yieldUnits),
  unitNum: big(inner.unitNum),
  unitDen: big(inner.unitDen),
});

const nativeMathNow = (pos: any, inner: any, speedup: number, nowSec: number): SourceMath => {
  const math = mathOf(inner);
  if (status(pos.inner.sourceChain) !== "solana") return math;
  const p = pos.inner;
  const facts = { principal: big(p.principal), rateBps: p.rateBps, yieldFeeBps: p.yieldFeeBps, openedAt: Number(big(p.openedAt)), openAdvance: p.openAdvance ?? null, appliedNet: big(p.appliedNet) };
  return sourceAtClock(facts, inner.index, math, speedup, nowSec);
};

/**
 * Job 8: Treasury. The Treasury Account holds the Gemas Tesoro bought by Instant Redeem; once their Source's yield has
 * repaid them it redeems them at full value, which refills the treasury (SOL: `redeem_treasury` pays simSOL into the
 * treasury vault; ETH and HYPE: bridge `redeem_treasury_to_evm` records a Claim that the bridge job pays into the
 * vault's own treasury with `send_pay_yield`). Permissionless and bounded: at most KEEPER_TREASURY_MAX_PER_PASS redeems
 * of at least KEEPER_TREASURY_MIN_GEMAS Gemas each per pass.
 */
export async function treasuryJob(ctx: Ctx): Promise<number> {
  const account = treasuryAccountPda();
  const rows: any[] = await ctx.core.account.holdingState.all([{ memcmp: { offset: 9, bytes: account.toBase58() } }]);
  if (!rows.length) {
    log("treasury", "-", "the Treasury Account holds no Gemas");
    return 0;
  }
  const sources: any[] = await ctx.core.account.sourceState.fetchMultiple(rows.map((r) => pk(r.account.inner.source)));
  const positionKeys = sources.map((s) => (s ? pk(s.inner.position) : null));
  const unique = [...new Map(positionKeys.filter(Boolean).map((k) => [k!.toBase58(), k!])).values()];
  const fetched: any[] = unique.length ? await ctx.core.account.positionState.fetchMultiple(unique) : [];
  const positions = new Map(unique.map((k, i) => [k.toBase58(), fetched[i]]));

  // A Solana-native Source's Debt is derived from the clock (ADR 0010): its stored yield is only a floor.
  const poolInfo = await ctx.conn.getAccountInfo(POOL, "confirmed");
  const speedup = poolInfo ? poolSpeedup(poolInfo.data) : 4380;
  const nowSec = Math.floor(Date.now() / 1000);
  const holdings: TreasuryHolding[] = [];
  rows.forEach((row, i) => {
    const src = sources[i];
    const position = positionKeys[i];
    const pos = position ? positions.get(position.toBase58()) : null;
    if (!src || !position || !pos) return;
    const inner = row.account.inner;
    holdings.push({
      holding: row.publicKey,
      source: pk(inner.source),
      position,
      free: big(inner.amount) - big(inner.reserved),
      math: nativeMathNow(pos, src.inner, speedup, nowSec),
      chain: status(pos.inner.sourceChain) as TreasuryHolding["chain"],
      positionId: Uint8Array.from(pos.positionId),
    });
  });

  const plan = planTreasuryRedeems(holdings);
  let actions = 0;
  for (const { holding: h, gemas } of plan) {
    const subject = `source=${shortKey(h.source)} ${h.chain}`;
    const eid = eidOf(h.chain);
    const ix = h.chain === "solana" ? redeemTreasuryIx(h.position, h.source, gemas) : eid === null ? null : redeemTreasuryToEvmIx(ctx.payer.publicKey, eid, h.positionId, h.source, gemas);
    if (!ix) continue;
    const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix];
    const err = await simulate(ctx.conn, ctx.payer, ixs);
    if (err) {
      log("treasury", subject, `wait: redeem of ${gemas} Gemas would fail (${err.slice(0, 160)})`);
      continue;
    }
    const what = h.chain === "solana" ? `redeem_treasury ${gemas} Gemas` : `redeem_treasury_to_evm ${gemas} Gemas (the bridge job pays the Claim)`;
    actions += +(await act(ctx, "treasury", subject, what, () => ctx.bp.sendBase(ctx.signer, ixs))).ok;
  }
  log("treasury", "-", `${holdings.length} Holding(s) of the Treasury Account, ${plan.length} due, ${actions} redeemed`);
  return actions;
}
