import { TransactionMessage, VersionedTransaction, type Connection, type Keypair, type SimulatedTransactionResponse, type TransactionInstruction } from "@solana/web3.js";

export const when = (deadline: number, now: number) => (deadline > now ? `in ${deadline - now}s` : `${now - deadline}s ago`);

/**
 * Free dry-run of `ixs` signed by `payer`. The keeper and the app resolve two installs of @solana/web3.js (pnpm peer
 * variants), so a legacy `Transaction` built here fails the connection's `instanceof Transaction` check and throws
 * "Cannot read properties of undefined (reading 'numRequiredSignatures')". A VersionedTransaction is matched by shape.
 */
export async function simulateIxs(conn: Connection, payer: Keypair, ixs: TransactionInstruction[]): Promise<SimulatedTransactionResponse> {
  const { blockhash } = await conn.getLatestBlockhash();
  const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([payer]);
  return (await conn.simulateTransaction(tx, { sigVerify: false })).value;
}

/** Free dry-run of a rollup transaction; null when it would succeed, else the error text. */
export async function simulate(conn: Connection, payer: Keypair, ixs: TransactionInstruction[]): Promise<string | null> {
  try {
    const res = await simulateIxs(conn, payer, ixs);
    if (!res.err) return null;
    const why = res.logs?.filter((l) => /Error|failed|custom program error/i.test(l)).pop();
    return `${JSON.stringify(res.err)}${why ? ` ${why.replace("Program log: ", "")}` : ""}`;
  } catch (e) {
    return String((e as Error).message ?? e);
  }
}
