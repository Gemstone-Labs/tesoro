import { Transaction, type Connection, type Keypair, type TransactionInstruction } from "@solana/web3.js";

export const when = (deadline: number, now: number) => (deadline > now ? `in ${deadline - now}s` : `${now - deadline}s ago`);

/** Free dry-run of a rollup transaction; null when it would succeed, else the error text. */
export async function simulate(conn: Connection, payer: Keypair, ixs: TransactionInstruction[]): Promise<string | null> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(payer);
  try {
    const res = await conn.simulateTransaction(tx);
    return res.value.err ? JSON.stringify(res.value.err) : null;
  } catch (e) {
    return String((e as Error).message ?? e);
  }
}
