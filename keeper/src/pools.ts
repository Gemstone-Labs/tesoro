import { PublicKey } from "@solana/web3.js";
import { act, log, type Ctx } from "./act.ts";
import { shortKey } from "./env.ts";
import { keyOf } from "./kit.ts";
import { connLister, type Lister } from "./lists.ts";
import { sendIxs, type SendOpts } from "./send.ts";
import { poolIsStale, updateStakePoolBalanceIx } from "./stake-pool-update.ts";
import { connReader, type Reader } from "./supply.ts";

export interface PoolDeps {
  list: Lister;
  read: Reader;
  send(ixs: Parameters<typeof sendIxs>[2], opts: SendOpts): Promise<string>;
  epoch(): Promise<bigint>;
}

export const realPoolDeps = (ctx: Ctx): PoolDeps => ({
  list: connLister(ctx.conn),
  read: connReader(ctx.conn),
  send: (ixs, opts) => sendIxs(ctx.conn, ctx.payer, ixs, opts),
  epoch: async () => BigInt((await ctx.conn.getEpochInfo("confirmed")).epoch),
});

/**
 * Job: keeps the stake pools behind the staking-token custodies fresh. tesoro_core refuses to price a payout (Redeem,
 * Unlock, a fee cut, a harvest, a prize) from a pool whose last `UpdateStakePoolBalance` is more than one epoch old, and
 * anyone may send that update. The pools' operators normally update them each epoch; this only covers the gap. It needs the
 * pool's validator list to be current too, so a failure here means that list is stale and the next pass tries again.
 */
export async function poolJob(ctx: Ctx, d: PoolDeps = realPoolDeps(ctx)): Promise<number> {
  const custodies = await d.list("StakeCustody");
  if (!custodies.length) return 0;
  const pools = [...new Map(custodies.map((c) => [keyOf((ctx.core.coder.accounts.decode("stakeCustody", c.data) as any).pool).toBase58(), 0])).keys()].map((k) => new PublicKey(k));
  const infos = await d.read.many(pools);
  const epoch = await d.epoch();
  let actions = 0;
  for (let i = 0; i < pools.length; i++) {
    const info = infos[i];
    if (!info || !poolIsStale(info, epoch)) continue;
    const r = await act(ctx, "pools", `pool=${shortKey(pools[i])}`, "UpdateStakePoolBalance (the pool is behind this epoch)", async () => d.send([updateStakePoolBalanceIx(pools[i], info)], { units: 200_000 }));
    actions += +r.ok;
  }
  if (!actions) log("pools", "-", `${pools.length} stake pool(s), all fresh enough`);
  return actions;
}
