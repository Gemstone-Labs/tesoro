import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TESORO_CORE_PROGRAM_ID } from "../../app/src/games/block-puzzle/chain.ts";
import { act, log, type Ctx } from "./act.ts";
import { shortKey } from "./env.ts";
import { hasInstruction, loadIdl } from "./runtime.ts";

const status = (o: object) => Object.keys(o)[0];
const CRANK = "accrue_native_yield";

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * Job 3: yield. Solana-native Positions are cranked through tesoro_core's permissionless
 * `accrue_native_yield` when the IDL we can see has it (`target/idl`, or TESORO_IDL_DIR, else the
 * app's copy) and the deployed program accepts it; otherwise the job reports why and skips.
 * ETH Positions need `reportYield` on the Hoodi PositionVault: a later job, stubbed here.
 */
export async function yieldJob(ctx: Ctx): Promise<number> {
  const positions: any[] = await ctx.core.account.positionState.all();
  const native = positions.filter((p) => status(p.account.inner.sourceChain) === "solana" && status(p.account.inner.status) === "locked");
  const evm = positions.filter((p) => status(p.account.inner.sourceChain) !== "solana" && status(p.account.inner.status) === "locked");
  if (evm.length) log("yield", "-", `STUB ${evm.length} ETH/HyperEVM Position(s): Hoodi PositionVault.reportYield job not implemented yet`);

  const idl = loadIdl("tesoro_core");
  const def = idl.instructions.find((i: any) => i.name === CRANK);
  if (!hasInstruction(idl, CRANK) || !def) {
    log("yield", "-", `SKIP ${native.length} Solana Position(s): ${CRANK} is not in the tesoro_core IDL yet`);
    return 0;
  }
  if (def.args.length > 0) {
    log("yield", "-", `SKIP ${native.length} Solana Position(s): ${CRANK} takes args (${def.args.map((a: any) => a.name).join(", ")}) this keeper does not know how to fill`);
    return 0;
  }

  let actions = 0;
  const config = PublicKey.findProgramAddressSync([Buffer.from("config")], TESORO_CORE_PROGRAM_ID)[0];
  for (const { publicKey, account } of native) {
    const subject = `position=${shortKey(publicKey)}`;
    const known: Record<string, PublicKey> = {
      caller: ctx.payer.publicKey,
      payer: ctx.payer.publicKey,
      keeper: ctx.payer.publicKey,
      cranker: ctx.payer.publicKey,
      position: publicKey,
      positionState: publicKey,
      config,
      systemProgram: SystemProgram.programId,
    };
    const open = account.inner.openAdvance;
    if (open !== null && open !== undefined) {
      const idx = Buffer.alloc(4);
      idx.writeUInt32LE(Number(open));
      known.source = PublicKey.findProgramAddressSync([Buffer.from("source"), publicKey.toBuffer(), idx], TESORO_CORE_PROGRAM_ID)[0];
      known.sourceState = known.source;
    }
    const accounts: Record<string, PublicKey> = {};
    for (const a of def.accounts) {
      const name = camel(a.name);
      if (known[name]) accounts[name] = known[name];
    }
    const r = await act(ctx, "yield", subject, `${CRANK}`, async () => {
      const ix = await ctx.core.methods[camel(CRANK)]().accountsPartial(accounts).instruction();
      const tx = await ctx.bp.sendBase(ctx.signer, [ix]).catch((e: Error) => {
        // Anchor 101: the deployed program predates the instruction.
        if (/custom program error: 0x65|InstructionFallbackNotFound|"Custom":101/.test(e.message)) throw new Error("deployed tesoro_core does not have accrue_native_yield yet");
        throw e;
      });
      return tx;
    });
    actions += +r.ok;
  }
  log("yield", "-", `${native.length} Solana Position(s) cranked, ${actions} action(s)`);
  return actions;
}
