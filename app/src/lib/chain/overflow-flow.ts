import "./polyfill";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import { getChain } from "./client";
import type { GetToken } from "./demo-client";
import type { Connection, TransactionInstruction } from "@solana/web3.js";
import { booksFor, readEntryStores } from "./entry";
import { claimOverflowIx, type WaitingRecord } from "./overflow";
import { exitSend } from "./redeem";

/**
 * "Claim" on Gemas waiting for room: one `claim_overflow` per record, sent through the relayer when it takes it (nothing
 * but a Core instruction travels, so the fee is free to the Player), else paid by the wallet. Anyone could send these; the
 * Gemas land in the Account they belong to. A record that still finds no room stays and the next Claim tries again.
 */
export async function claimWaiting(signer: ChainSigner, getToken: GetToken, records: readonly WaitingRecord[]): Promise<string[]> {
  const sent: string[] = [];
  for (const record of records) {
    // read after the previous claim: it may have added the line this one merges into
    sent.push(await exitSend(signer, getToken, [await claimInstruction(getChain().base, record)]));
  }
  return sent;
}

/**
 * `claim_overflow` for one record, with the books and checkpoint pages of every line it can touch. A claimed line that
 * merges into a line the Account holds first catches the older one up, which reads the checkpoint records between the two
 * (`MissingCheckpoint` when they are not passed): the pages of the record's lines and of the Account's own lines.
 */
export async function claimInstruction(conn: Pick<Connection, "getMultipleAccountsInfo">, record: WaitingRecord): Promise<TransactionInstruction> {
  const stores = await readEntryStores(record.owner, conn);
  const metas = await booksFor(record.sources, [...record.storeLines, ...stores.basket.lines, ...stores.spill.lines], conn);
  return claimOverflowIx(record, metas.map((m) => m.pubkey));
}
