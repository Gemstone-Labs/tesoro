// Admin helpers for the SIMULATED simSOL pool: initialize and fund the yield reserve.
import { createHash } from "node:crypto";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type Signer,
} from "@solana/web3.js";
import { MINT_PDA, POOL_PDA, SIM_LST_PROGRAM_ID, VAULT_PDA } from "./index";

const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

/** initialize(apy_bps, speedup, faucet_amount, faucet_cooldown). */
export function initializeInstruction(
  admin: PublicKey,
  apyBps: number,
  speedup: number,
  faucetAmount: bigint,
  faucetCooldown: bigint,
): TransactionInstruction {
  const data = Buffer.alloc(32);
  disc("initialize").copy(data, 0);
  data.writeUInt32LE(apyBps, 8);
  data.writeUInt32LE(speedup, 12);
  data.writeBigUInt64LE(faucetAmount, 16);
  data.writeBigInt64LE(faucetCooldown, 24);
  return new TransactionInstruction({
    programId: SIM_LST_PROGRAM_ID,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: POOL_PDA, isSigner: false, isWritable: true },
      { pubkey: MINT_PDA, isSigner: false, isWritable: true },
      { pubkey: VAULT_PDA, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/** fund_reserve(lamports): tops up the vault that pays the simulated yield. */
export function fundReserveInstruction(admin: PublicKey, lamports: bigint): TransactionInstruction {
  const data = Buffer.alloc(16);
  disc("fund_reserve").copy(data, 0);
  data.writeBigUInt64LE(lamports, 8);
  return new TransactionInstruction({
    programId: SIM_LST_PROGRAM_ID,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: POOL_PDA, isSigner: false, isWritable: false },
      { pubkey: VAULT_PDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export async function sendInstruction(
  connection: Connection,
  payer: Signer,
  ix: TransactionInstruction,
): Promise<string> {
  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(payer);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}
