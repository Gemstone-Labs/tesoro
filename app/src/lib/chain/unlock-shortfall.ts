import { PublicKey, Transaction, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { tokensToLamports } from "./stake-pool";

/**
 * What an Unlock of a staking-token Position returns less than it should: the program's own `UnlockShortfall` event
 * (`gap_shares`, what the owner did not get after any Treasury top-up). Read from a simulation before Unlock and from the
 * transaction's logs after, so it stays right whoever the program makes pay (ticket 55).
 */
export interface UnlockShortfall {
  position: PublicKey;
  shortfallShares: bigint;
  toppedUpShares: bigint;
  gapShares: bigint;
}

/** Anchor discriminator of `UnlockShortfall` (idl/tesoro_core.json). */
const DISCRIMINATOR = Buffer.from([3, 215, 85, 235, 10, 139, 138, 101]);
const PREFIX = "Program data: ";

/** The `UnlockShortfall` event in a transaction's log lines, or null when the Unlock paid in full. */
export function parseUnlockShortfall(logs: readonly string[]): UnlockShortfall | null {
  for (const line of logs) {
    if (!line.startsWith(PREFIX)) continue;
    const data = Buffer.from(line.slice(PREFIX.length), "base64");
    if (data.length < 8 + 32 + 24 || !data.subarray(0, 8).equals(DISCRIMINATOR)) continue;
    return {
      position: new PublicKey(data.subarray(8, 40)),
      shortfallShares: data.readBigUInt64LE(40),
      toppedUpShares: data.readBigUInt64LE(48),
      gapShares: data.readBigUInt64LE(56),
    };
  }
  return null;
}

/** SOL base units the missing token shares are worth at the pool's rate (1e12 fixed point). */
export const shortfallLamports = (gapShares: bigint, rate: bigint) => tokensToLamports(gapShares, rate);

const sol = (lamports: bigint, digits = 2) => (Number(lamports) / 1e9).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export interface ShortfallCopy {
  title: string;
  body: string;
}

/** The plain-words line for the Unlock screen (`after: false`) and its receipt. Null when nothing is missing. */
export function shortfallCopy({ gapLamports, principalLamports, symbol, after = false }: { gapLamports: bigint; principalLamports: bigint; symbol: string; after?: boolean }): ShortfallCopy | null {
  if (gapLamports <= 0n) return null;
  const locked = sol(principalLamports, principalLamports % 10_000_000n === 0n ? 0 : 2);
  return {
    title: `About ${sol(gapLamports)} SOL short`,
    body: after
      ? `You got back what was left of your ${symbol}, about ${sol(gapLamports)} SOL less than the ${locked} SOL you locked: the staking token's rate fell after your yield was paid.`
      : `Unlock gives back what is left of your ${symbol}, about ${sol(gapLamports)} SOL less than the ${locked} SOL you locked: the staking token's rate fell after your yield was paid.`,
  };
}

/** Dry-runs the Unlock instructions as `payer` and reads the shortfall the program would report. Null when it pays in full or the dry run fails. */
export async function previewUnlockShortfall(conn: Connection, payer: PublicKey, ixs: TransactionInstruction[]): Promise<UnlockShortfall | null> {
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer, recentBlockhash: blockhash }).add(...ixs);
  const res = await conn.simulateTransaction(tx);
  if (res.value.err) return null;
  return parseUnlockShortfall(res.value.logs ?? []);
}

/** The shortfall a sent Unlock reported, from its confirmed transaction. Null when it paid in full; throws when the transaction cannot be read. */
export async function unlockOutcome(conn: Connection, signature: string): Promise<UnlockShortfall | null> {
  const tx = await conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!tx?.meta?.logMessages) throw new Error("Unlock transaction not readable yet");
  return parseUnlockShortfall(tx.meta.logMessages);
}
