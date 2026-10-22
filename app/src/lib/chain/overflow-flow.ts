import "./polyfill";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import { getChain } from "./client";
import type { GetToken } from "./demo-client";
import { claimOverflowIx, type WaitingRecord } from "./overflow";
import { exitSend, sourceAccounts } from "./redeem";

/**
 * "Claim" on Gemas waiting for room: one `claim_overflow` per record, sent through the relayer when it takes it (nothing
 * but a Core instruction travels, so the fee is free to the Player), else paid by the wallet. Anyone could send these; the
 * Gemas land in the Account they belong to. A record that still finds no room stays and the next Claim tries again.
 */
export async function claimWaiting(signer: ChainSigner, getToken: GetToken, records: readonly WaitingRecord[]): Promise<string[]> {
  const sent: string[] = [];
  for (const record of records) {
    const books = new Set<string>();
    const keys = [];
    for (const source of record.sources) {
      // the Source's book and the checkpoint pages a merge may write; creating a page is not part of a claim
      for (const k of (await sourceAccounts(getChain().base, source, [], signer.publicKey)).accounts) {
        if (!books.has(k.toBase58())) {
          books.add(k.toBase58());
          keys.push(k);
        }
      }
    }
    sent.push(await exitSend(signer, getToken, [claimOverflowIx(record, keys)]));
  }
  return sent;
}
