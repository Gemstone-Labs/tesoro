/**
 * Broadcasts from the relayer's EVM key one at a time per network, and retries when the node reports a nonce conflict
 * (another server instance sent from the same key at the same moment). viem reads the pending nonce on every send, so a retry
 * picks a fresh one. Only the broadcast is queued: callers wait for the receipt outside.
 */
const queues = new Map<string, Promise<unknown>>();

export const NONCE_CONFLICT = /nonce too low|nonce has already been used|replacement transaction underpriced|already known|nonce too high|NonceTooLow|TransactionUnderpriced/i;

export const isNonceConflict = (e: unknown): boolean => {
  const err = e as { message?: string; shortMessage?: string; details?: string; cause?: unknown };
  return NONCE_CONFLICT.test(`${err?.shortMessage ?? ""} ${err?.message ?? ""} ${err?.details ?? ""}`) || (!!err?.cause && isNonceConflict(err.cause));
};

export function relayerSend<T>(net: string, send: () => Promise<T>, backoffMs = 400): Promise<T> {
  const attempt = async (): Promise<T> => {
    for (let i = 0; ; i++) {
      try {
        return await send();
      } catch (e) {
        if (i >= 2 || !isNonceConflict(e)) throw e;
        await new Promise((r) => setTimeout(r, backoffMs * (i + 1)));
      }
    }
  };
  const run = (queues.get(net) ?? Promise.resolve()).then(attempt);
  queues.set(net, run.catch(() => {}));
  return run;
}
