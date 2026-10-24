import { SendTransactionError, type Connection } from "@solana/web3.js";

/** A known atomic rejection, distinct from an RPC timeout after a transaction may have landed. */
export class ChainTransactionFailed extends Error {}

type Sender = Pick<Connection, "sendRawTransaction" | "getSignatureStatuses">;

export async function sendConfirmed(conn: Sender, raw: Uint8Array): Promise<string> {
  let sig: string;
  try {
    sig = await conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 });
  } catch (e) {
    if (e instanceof SendTransactionError && e.message.startsWith("Simulation failed.") && !/already.?processed/i.test(e.transactionError.message)) throw new ChainTransactionFailed(e.transactionError.message);
    throw e;
  }
  for (let i = 0; i < 60; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new ChainTransactionFailed(JSON.stringify(st.err));
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("not confirmed in time");
}
