import { SendTransactionError, type Connection } from "@solana/web3.js";

/** A known atomic rejection, distinct from an RPC timeout after a transaction may have landed. */
export class ChainTransactionFailed extends Error {
  /** `finalized`: the failure is final. A fast failure (see `failFast`) was seen at confirmed only and is final for the Player's page, not for the books. */
  constructor(message: string, readonly beforeBroadcast = true, readonly finalized = true) { super(message); }
}

type Sender = Pick<Connection, "sendRawTransaction" | "getSignatureStatuses">;

/**
 * Sends and waits. A success returns once confirmed; a failure throws once finalized, so a fork cannot undo it. With `failFast`, a
 * program error (`InstructionError` with a `Custom` code) throws as soon as it is confirmed, with `finalized: false`: the rider
 * whose board lost a race to another rider's open learns in about a second and rebuilds. Fee and balance failures still wait, as
 * they depend on the fork. Accounting stays with the journal, which finishes only on finalized evidence.
 */
export async function sendConfirmed(conn: Sender, raw: Uint8Array, o: { failFast?: boolean } = {}): Promise<string> {
  let sig: string;
  try {
    sig = await conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 });
  } catch (e) {
    if (e instanceof SendTransactionError && e.message.startsWith("Simulation failed.") && !/already.?processed/i.test(e.transactionError.message)) throw new ChainTransactionFailed(e.transactionError.message);
    throw e;
  }
  for (let i = 0; i < 60; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err && st.confirmationStatus === "finalized") throw new ChainTransactionFailed(JSON.stringify(st.err), false);
    if (st?.err && o.failFast && st.confirmationStatus === "confirmed" && isProgramError(st.err)) throw new ChainTransactionFailed(JSON.stringify(st.err), false, false);
    if (!st?.err && (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized")) return sig;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("not confirmed in time");
}

const isProgramError = (err: unknown): boolean => typeof err === "object" && err !== null && "InstructionError" in err && typeof (err as { InstructionError: unknown[] }).InstructionError[1] === "object";
