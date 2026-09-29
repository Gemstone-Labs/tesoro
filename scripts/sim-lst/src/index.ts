// Helpers for the SIMULATED simSOL pool (programs/sim_lst). Yield runs on an accelerated clock:
// "Simulated yield · 1 month = 10 min".
import { createHash } from "node:crypto";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type Signer,
} from "@solana/web3.js";

export const SIM_LST_PROGRAM_ID = new PublicKey("WgcM5GessXmBx91ggdMrgFEVaitNQBJZ3KTmz1VqD4F");
export const RATE_SCALE = 1_000_000_000n;
const BPS_DENOMINATOR = 10_000n;
const SECONDS_PER_YEAR = 31_536_000n;

const seed = (s: string) => Buffer.from(s);
export const [POOL_PDA] = PublicKey.findProgramAddressSync([seed("pool")], SIM_LST_PROGRAM_ID);
export const [MINT_PDA] = PublicKey.findProgramAddressSync([seed("mint")], SIM_LST_PROGRAM_ID);
export const [VAULT_PDA] = PublicKey.findProgramAddressSync([seed("vault")], SIM_LST_PROGRAM_ID);

export interface PoolState {
  admin: PublicKey;
  mint: PublicKey;
  baseRate: bigint;
  baseTs: bigint;
  apyBps: number;
  speedup: number;
  faucetAmount: bigint;
  faucetCooldown: bigint;
  paused: boolean;
}

export async function fetchPool(connection: Connection): Promise<PoolState> {
  const info = await connection.getAccountInfo(POOL_PDA, "confirmed");
  if (!info || !info.owner.equals(SIM_LST_PROGRAM_ID)) throw new Error("sim_lst pool not initialized");
  const d = Buffer.from(info.data);
  return {
    admin: new PublicKey(d.subarray(8, 40)),
    mint: new PublicKey(d.subarray(40, 72)),
    baseRate: d.readBigUInt64LE(72),
    baseTs: d.readBigInt64LE(80),
    apyBps: d.readUInt32LE(88),
    speedup: d.readUInt32LE(92),
    faucetAmount: d.readBigUInt64LE(96),
    faucetCooldown: d.readBigInt64LE(104),
    paused: d[112] === 1,
  };
}

/** Mirrors the on-chain formula: base + base * apy_bps * (elapsed * speedup) / (10_000 * year). */
export function rateAt(pool: PoolState, nowSec: bigint): bigint {
  const elapsed = nowSec > pool.baseTs ? nowSec - pool.baseTs : 0n;
  const growth =
    (pool.baseRate * BigInt(pool.apyBps) * elapsed * BigInt(pool.speedup)) /
    (BPS_DENOMINATOR * SECONDS_PER_YEAR);
  return pool.baseRate + growth;
}

/** Current SOL-per-simSOL rate, 1e9 fixed point, using the cluster's latest block time. */
export async function readRate(
  connection: Connection,
): Promise<{ rate: bigint; rateSol: number; pool: PoolState }> {
  const pool = await fetchPool(connection);
  const slot = await connection.getSlot("confirmed");
  const blockTime = await connection.getBlockTime(slot);
  const now = BigInt(blockTime ?? Math.floor(Date.now() / 1000));
  const rate = rateAt(pool, now);
  return { rate, rateSol: Number(rate) / Number(RATE_SCALE), pool };
}

function discriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

/** Builds the SIMULATED faucet instruction ("get test tokens"). */
export function faucetInstruction(user: PublicKey, mint: PublicKey = MINT_PDA): TransactionInstruction {
  const [claim] = PublicKey.findProgramAddressSync([seed("faucet"), user.toBuffer()], SIM_LST_PROGRAM_ID);
  return new TransactionInstruction({
    programId: SIM_LST_PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: POOL_PDA, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: getAssociatedTokenAddressSync(mint, user), isSigner: false, isWritable: true },
      { pubkey: claim, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: discriminator("faucet"),
  });
}

/** Sends the faucet transaction signed by `user`; returns the signature. */
export async function claimFaucet(connection: Connection, user: Signer): Promise<string> {
  const tx = new Transaction().add(faucetInstruction(user.publicKey));
  tx.feePayer = user.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(user);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}
