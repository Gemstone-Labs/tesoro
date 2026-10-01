import type { Connection } from "@solana/web3.js";

/** The transaction was sent but did not confirm in time. It may still land until its blockhash expires. */
export class TxUnconfirmedError extends Error {
  constructor(
    readonly sig: string,
    readonly lastValidBlockHeight?: number,
  ) {
    super(`base tx not confirmed ${sig}`);
  }
}

/** The transaction landed and failed: nothing it did is on chain. */
export class TxFailedError extends Error {
  constructor(
    readonly sig: string,
    readonly txErr: unknown,
    logs: string[] = [],
  ) {
    super(`base tx failed ${sig}: ${JSON.stringify(txErr)}\n${logs.join("\n")}`);
  }
}

/** "expired": its blockhash is past its last valid block height and it never landed, so it never will. */
export type TxOutcome = "landed" | "failed" | "expired" | "unknown";

type StatusReader = Pick<Connection, "getSignatureStatuses" | "getBlockHeight">;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Settles what became of a sent transaction that did not confirm in time. RPC errors count as no news. */
export async function txOutcome(conn: StatusReader, sig: string, lastValidBlockHeight?: number, timeoutMs = 90_000, pollMs = 1000): Promise<TxOutcome> {
  const until = Date.now() + timeoutMs;
  const status = async (): Promise<TxOutcome | null> => {
    const st = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return st.err ? "failed" : "landed";
    return st ? "unknown" : null;
  };
  while (Date.now() < until) {
    try {
      const seen = await status();
      if (seen === "landed" || seen === "failed") return seen;
      if (seen === null && lastValidBlockHeight !== undefined && (await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) {
        // One more look: it may sit in the last valid block.
        await sleep(pollMs);
        const last = await status();
        if (last !== "unknown") return last ?? "expired";
      }
    } catch {
      // Keep polling.
    }
    await sleep(pollMs);
  }
  return "unknown";
}
