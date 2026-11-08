/**
 * Stepping a Railcar seat off before departure, with the accounts its lines need to go home: the page's step-off, and the
 * keeper's sweep stepping every seat off a car whose boarding ended. Reads only.
 */
import type { AccountMeta, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { basketPda, spillPda, sponsorPda } from "../../lib/chain/basket";
import { decodeSeatMark, returnSteppedOffIx, seatMarkPda, stepOffIx, type SeatView } from "../../lib/chain/many-seat";
import type { LoadedCar } from "../../lib/chain/many-seat-plan";
import { POT_AT, decodeStore, decodeTicketHead } from "../../lib/chain/pot-store";
import { supplySources, type Reader } from "../../lib/chain/settle-plan";

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

/**
 * `return_stepped_off` for the lines of a stepped-off seat still on their way home, or null once they are all home (the
 * funder's mark is gone). `funder` is whoever the seat's lines go back to (the Backer on a backed seat).
 */
export async function returnLinesFor(core: Core, read: Reader, a: { caller: PublicKey; car: PublicKey; funder: PublicKey }): Promise<TransactionInstruction | null> {
  const mark = seatMarkPda(a.car, a.funder);
  const [info] = await read.many([mark]);
  if (!info) return null;
  const m = decodeSeatMark(info.data);
  const [pot, sponsor] = await read.many([m.pot, sponsorPda()]);
  if (!pot) return null;
  const lines = decodeStore(pot.data, POT_AT).lines();
  const books = await supplySources(core, read, lines.map((l) => ({ source: l.source, cut: false })));
  const stores: AccountMeta[] = [basketPda(m.funder), spillPda(m.funder)].map((k) => ({ pubkey: k, isSigner: false, isWritable: true }));
  return returnSteppedOffIx({ caller: a.caller, mark, markPayer: m.payer, pot: m.pot, potPayer: decodeTicketHead(pot.data).payer, sponsor: !!sponsor, remaining: [...stores, ...books.metas] });
}
