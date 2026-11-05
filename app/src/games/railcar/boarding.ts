/**
 * Boarding and stepping off a Railcar seat, as the page and the tests build them: whose Gemas the entry draws (the
 * Player's, or a Backer's under an accepted Offer), whether the Offer's Backer is already in the car, and the step-off
 * with the accounts its lines need to go home. Reads only; the hook sends.
 */
import type { AccountMeta, Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { basketPda, spillPda, sponsorPda } from "../../lib/chain/basket";
import { previewEntry, readEntryStores, type EntryPreview } from "../../lib/chain/entry";
import { decodeSeatMark, seatMarkPda, stepOffIx, type SeatView } from "../../lib/chain/many-seat";
import type { LoadedCar } from "../../lib/chain/many-seat-plan";
import { decodeTicketHead } from "../../lib/chain/pot-store";
import { supplySources, type Reader } from "../../lib/chain/settle-plan";
import { ENTRY_GEMAS } from "./chain";

/** An accepted Offer the Player boards with: the Backer's Account funds the entry. */
export interface BoardingBacking {
  offer: PublicKey;
  backerAccount: PublicKey;
}

/**
 * The entry as core will draw it: from the Player's own Gemas, or under a Backing from the Backer's, where the draw may
 * use what the Offer reserved (`draw_backing_direct`). `funder` numbers the Pot.
 */
export async function boardingEntry(conn: Pick<Connection, "getMultipleAccountsInfo">, me: PublicKey, backing?: BoardingBacking): Promise<{ funder: PublicKey; preview: EntryPreview }> {
  const funder = backing?.backerAccount ?? me;
  const stores = await readEntryStores(funder, conn);
  return { funder, preview: previewEntry(stores, BigInt(ENTRY_GEMAS), { backing: !!backing }) };
}

/**
 * The Backer holds a mark in this car (a seat of their own, a seat they fund, or a step-off's return still on its way):
 * core refuses the backed join (`AlreadySeated`), and the Offer boards the next car instead.
 */
export async function backerSeatedIn(read: Reader, car: PublicKey, backer: PublicKey): Promise<boolean> {
  const [mark] = await read.many([seatMarkPda(car, backer)]);
  return !!mark;
}

type Core = Parameters<typeof supplySources>[0];

/**
 * `step_off_many_seat_match` for a seat, with what its lines need to go home: the funder's stores (the Backer's for a
 * backed seat) and the books of the lines' Sources.
 */
export async function stepOffFor(core: Core, read: Reader, a: { caller: PublicKey; loaded: LoadedCar; seat: SeatView }): Promise<TransactionInstruction> {
  const car = a.loaded.car.address;
  const [mark, pot, sponsor] = await read.many([seatMarkPda(car, a.seat.player), a.seat.pot, sponsorPda()]);
  if (!mark || !pot) throw new Error("Your seat could not be read. Try again.");
  const books = await supplySources(core, read, (a.loaded.lines[a.seat.index] ?? []).map((l) => ({ source: l.source, cut: false })));
  const stores: AccountMeta[] = [basketPda(a.seat.funder), spillPda(a.seat.funder)].map((k) => ({ pubkey: k, isSigner: false, isWritable: true }));
  return stepOffIx({ caller: a.caller, car, seat: a.seat, markPayer: decodeSeatMark(mark.data).payer, potPayer: decodeTicketHead(pot.data).payer, sponsor: !!sponsor, remaining: [...stores, ...books.metas] });
}
