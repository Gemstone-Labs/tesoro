import { accrueNativeYieldIx, SIM_SOL_MINT } from "../../app/src/lib/chain/native.ts";
import { act, log, type Ctx } from "./act.ts";
import { shortKey } from "./env.ts";
import { pk } from "./runtime.ts";

const status = (o: object) => Object.keys(o)[0];

/**
 * Job 3: yield. Every Solana-native Position (simSOL custody) with Debt > 0 gets the permissionless
 * `accrue_native_yield` each pass, which applies the vault's SIMULATED yield (sim_lst runs
 * 1 month = ~10 min) to its Debt. A Position has Debt exactly while `open_advance` is set: the
 * ledger clears it when Debt reaches zero. Accounts come from the real instruction: [position (w),
 * custody, vault, pool, open Advance's source (w, optional)], built by app/src/lib/chain/native.ts.
 * ETH Positions are handled by src/eth.ts (`reportYield` on Hoodi) and src/bridge.ts (`apply_yield`).
 */
export async function yieldJob(ctx: Ctx): Promise<number> {
  const positions: any[] = await ctx.core.account.positionState.all();
  const native = positions.filter((p) => {
    const i = p.account.inner;
    return status(i.sourceChain) === "solana" && pk(i.sourceAsset).equals(SIM_SOL_MINT);
  });
  const owing = native.filter((p) => status(p.account.inner.status) === "locked" && p.account.inner.openAdvance !== null && p.account.inner.openAdvance !== undefined);

  let actions = 0;
  for (const { publicKey, account } of owing) {
    const open = Number(account.inner.openAdvance);
    const r = await act(ctx, "yield", `position=${shortKey(publicKey)}`, "accrue_native_yield", async () => ctx.bp.sendBase(ctx.signer, [accrueNativeYieldIx(publicKey, open)]));
    actions += +r.ok;
  }
  log("yield", "-", `${native.length} native Position(s), ${owing.length} with Debt, ${actions} crank(s) sent`);
  return actions;
}
