/**
 * Cutover to the per-Position yield model on devnet (docs/yield-model.md). The sim_lst admin is the deployer.
 *
 *   pre   (old programs still live) freeze the rate where it is: the old `set_params` rebases `base_rate` to the
 *         current rate, and sets speedup 4,380 so one simulated month (1/12 year) is exactly 10 minutes.
 *   post  (after the upgrades) record the tesoro_core `["yield"]` PDA as the sim_lst yield authority and top up the
 *         reserve that backs the minted yield.
 *
 *   RPC_URL=https://rpc.magicblock.app/devnet pnpm --filter @tesoro/keeper exec tsx scripts/yield-cutover.ts pre|post [reserveSol]
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";

const SIM_LST = new PublicKey("WgcM5GessXmBx91ggdMrgFEVaitNQBJZ3KTmz1VqD4F");
const CORE = new PublicKey("AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh");
const rpc = process.env.RPC_URL ?? "https://rpc.magicblock.app/devnet";
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), ".config/solana/dev-2026-10.json"), "utf8"))));
const c = new Connection(rpc, "confirmed");
const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const pda = (seed: string, program = SIM_LST) => PublicKey.findProgramAddressSync([Buffer.from(seed)], program)[0];
const pool = pda("pool");
const send = (ix: TransactionInstruction) => sendAndConfirmTransaction(c, new Transaction().add(ix), [payer]);

const mode = process.argv[2];
if (mode === "pre") {
  // set_params(apy_bps: None, speedup: Some(4380))
  const data = Buffer.concat([disc("set_params"), Buffer.from([0, 1]), Buffer.from(new Uint32Array([4380]).buffer)]);
  const sig = await send(
    new TransactionInstruction({ programId: SIM_LST, keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: false }, { pubkey: pool, isSigner: false, isWritable: true }], data }),
  );
  console.log("set_params (rebase + speedup 4380):", sig);
} else if (mode === "post") {
  const authority = pda("yield", CORE);
  const config = pda("yield_config");
  const sig = await send(
    new TransactionInstruction({
      programId: SIM_LST,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: pool, isSigner: false, isWritable: false },
        { pubkey: config, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([disc("set_yield_authority"), authority.toBuffer()]),
    }),
  );
  console.log(`set_yield_authority ${authority.toBase58()} (config ${config.toBase58()}):`, sig);
  const sol = Number(process.argv[3] ?? 0);
  if (sol > 0) {
    const lamports = Buffer.alloc(8);
    lamports.writeBigUInt64LE(BigInt(Math.round(sol * 1e9)));
    const fund = await send(
      new TransactionInstruction({
        programId: SIM_LST,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: pool, isSigner: false, isWritable: false },
          { pubkey: pda("vault"), isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([disc("fund_reserve"), lamports]),
      }),
    );
    console.log(`fund_reserve ${sol} SOL:`, fund);
  }
} else {
  throw new Error("usage: yield-cutover.ts pre|post [reserveSol]");
}
