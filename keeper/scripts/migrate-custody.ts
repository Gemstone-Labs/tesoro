/**
 * One-off after a tesoro_core upgrade that grows `NativeCustody`: extends every native custody still in an older
 * layout (194 bytes: before `tracked_shares`; 202 bytes: before `last_accrual_ts`, per-Position yield) to the
 * current 210 bytes (`migrate_native_custody`, permissionless, the payer covers the rent). Run it right after the
 * upgrade and `yield-cutover.ts post`: a custody in an older layout cannot be cranked, redeemed or unlocked.
 *
 *   RPC_URL=https://rpc.magicblock.app/devnet pnpm --filter @tesoro/keeper exec tsx scripts/migrate-custody.ts
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";

const CORE = new PublicKey("AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh");
const OLD_SIZES = [194, 202];
const rpc = process.env.RPC_URL ?? "https://rpc.magicblock.app/devnet";
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), ".config/solana/dev-2026-10.json"), "utf8"))));
const c = new Connection(rpc, "confirmed");
const disc = createHash("sha256").update("global:migrate_native_custody").digest().subarray(0, 8);

const legacy = (await Promise.all(OLD_SIZES.map((dataSize) => c.getProgramAccounts(CORE, { filters: [{ dataSize }] })))).flat();
console.log(`${legacy.length} legacy custod${legacy.length === 1 ? "y" : "ies"}`);
for (const { pubkey, account } of legacy) {
  const position = new PublicKey(account.data.subarray(10, 42));
  const vault = new PublicKey(account.data.subarray(138, 170));
  const ix = new TransactionInstruction({
    programId: CORE,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: false },
      { pubkey: pubkey, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(disc),
  });
  const sig = await sendAndConfirmTransaction(c, new Transaction().add(ix), [payer]);
  console.log(`custody ${pubkey.toBase58()} (position ${position.toBase58()}): ${sig}`);
}
