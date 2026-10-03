/**
 * Devnet smoke test of the per-Position yield model: a fresh wallet opens a Position with a 1-month Advance and a
 * crank every 20 s prints the on-chain Debt until it reaches 0 (expected about 10 minutes).
 *
 *   RPC_URL=https://rpc.magicblock.app/devnet pnpm --filter @tesoro/keeper exec tsx scripts/yield-smoke.ts [months]
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { accountPda, accrueNativeYieldIx, faucetIx, fetchNativeInfo, openNativePositionIx, positionPda, takeNativeAdvanceIx, TESORO_CORE_ID } from "../../app/src/lib/chain/native.ts";
import { covered, live } from "../../app/src/lib/chain/ledger.ts";

const months = Number(process.argv[2] ?? 1);
const c = new Connection(process.env.RPC_URL ?? "https://rpc.magicblock.app/devnet", "confirmed");
const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), ".config/solana/dev-2026-10.json"), "utf8"))));
const user = Keypair.generate();
const send = (ixs: TransactionInstruction[], signer = user) => sendAndConfirmTransaction(c, new Transaction().add(...ixs), [signer]);

console.log("fund", await send([SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: user.publicKey, lamports: 60_000_000 })], deployer));
const createAccount = new TransactionInstruction({
  programId: TESORO_CORE_ID,
  keys: [
    { pubkey: user.publicKey, isSigner: true, isWritable: true },
    { pubkey: accountPda(user.publicKey), isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data: Buffer.concat([createHash("sha256").update("global:create_account").digest().subarray(0, 8), Buffer.alloc(20)]),
});
console.log("create_account + faucet", await send([createAccount, faucetIx(user.publicKey)]));
const nonce = BigInt(Date.now());
const position: PublicKey = await positionPda(user.publicKey, nonce);
const t0 = Date.now();
console.log("open + advance", await send([openNativePositionIx(user.publicKey, nonce, 5_000_000_000n, position), takeNativeAdvanceIx(user.publicKey, position, 0, months)]));
console.log("position", position.toBase58(), "owner", user.publicKey.toBase58());

const debtOf = async () => {
  const info = await fetchNativeInfo(c, position);
  const src = info!.source!.math;
  return { info: info!, debtUnits: live(src) - covered(src) };
};
for (;;) {
  await new Promise((r) => setTimeout(r, 20_000));
  const before = await debtOf();
  const sig = await send([accrueNativeYieldIx(position, before.info.openAdvance)]);
  const after = await debtOf();
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log(`t+${secs}s crank ${sig.slice(0, 12)} debt ${before.debtUnits} -> ${after.debtUnits} (vault shares ${after.info.vaultShares}, cumulative ${after.info.cumulativeYield})`);
  if (after.debtUnits === 0n) break;
}
