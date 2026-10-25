import { PublicKey, type ConfirmedSignatureInfo, type VersionedTransactionResponse } from "@solana/web3.js";
import { completionEffects, type CompletionChain, type ReservationRef } from "./completion.js";

export interface LiveReservation extends ReservationRef { origin: string; before: string | null }
export interface ObservationStore {
  claimReservations(limit?: number): Promise<LiveReservation[]>;
  advanceReservation(ref: LiveReservation, before: string | null): Promise<void>;
  releaseObservedCompletion(ref: LiveReservation, signature: string): Promise<boolean>;
}
export interface ObservationChain extends CompletionChain {
  getSignaturesForAddress(address: PublicKey, options: { limit: number; before?: string }, commitment: "finalized"): Promise<ConfirmedSignatureInfo[]>;
  blockSignatures?(slot: number): Promise<string[] | null>;
}

function evidence(tx: VersionedTransactionResponse, address: string) {
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses });
  const ixs = tx.transaction.message.compiledInstructions.map((ix) => ({
    programId: keys.get(ix.programIdIndex)!, keys: ix.accountKeyIndexes.map((i) => ({ pubkey: keys.get(i)!, isSigner: false, isWritable: true })), data: ix.data,
  }));
  const index = Array.from({ length: keys.length }, (_, i) => i).find((i) => keys.get(i)?.toBase58() === address);
  return { effects: completionEffects(ixs), pre: index === undefined ? 0 : tx.meta?.preBalances[index] ?? 0, post: index === undefined ? 0 : tx.meta?.postBalances[index] ?? 0 };
}

/** Recover physical closes sent by self-paying clients, bound to the reservation's originating admission. */
export async function recoverObservedCompletions(store: ObservationStore, chain: ObservationChain): Promise<number> {
  let done = 0;
  for (const ref of await store.claimReservations(3)) {
    const origin = await chain.getTransaction(ref.origin, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
    if (!origin?.meta || origin.meta.err || origin.transaction.signatures[0] !== ref.origin) continue;
    const anchored = evidence(origin, ref.key);
    if (anchored.post <= 0 || ![...anchored.effects.creates, ...anchored.effects.ensures].includes(ref.key)) continue;
    const page = await chain.getSignaturesForAddress(new PublicKey(ref.key), { limit: 20, ...(ref.before ? { before: ref.before } : {}) }, "finalized");
    let stopPage = false;
    for (const sig of page) {
      if (sig.err || sig.signature === ref.origin || sig.slot < origin.slot) continue;
      const close = await chain.getTransaction(sig.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
      // Do not advance past a gap: the missing transaction might be the close we need.
      if (!close?.meta || close.transaction.signatures[0] !== sig.signature || close.slot !== sig.slot) { stopPage = true; break; }
      if (close.meta.err) continue;
      const closed = evidence(close, ref.key);
      if (!closed.effects.closes.includes(ref.key) || closed.pre <= 0 || closed.post !== 0) continue;
      if (close.slot === origin.slot) {
        const block = await chain.blockSignatures?.(origin.slot);
        const start = block?.indexOf(ref.origin) ?? -1, end = block?.indexOf(sig.signature) ?? -1;
        if (start < 0 || end < 0) { stopPage = true; break; }
        if (end <= start) continue;
      }
      done += Number(await store.releaseObservedCompletion(ref, sig.signature));
      stopPage = true;
      break;
    }
    if (!stopPage) {
      const oldest = page.at(-1);
      await store.advanceReservation(ref, page.length === 20 && oldest && oldest.slot >= origin.slot ? oldest.signature : null);
    }
  }
  return done;
}
