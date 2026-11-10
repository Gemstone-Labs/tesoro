/**
 * Boarding a Railcar seat, as the page and the tests build it: whose Gemas the entry draws (the Player's, or a Backer's
 * under an accepted Offer) and whether the Offer's Backer is already in the car. The step-off is in step-off.ts. Reads
 * only; the hook sends.
 */
import type { Connection, PublicKey } from "@solana/web3.js";
import { previewEntry, readEntryStores, type EntryPreview } from "../../lib/chain/entry";
import { seatMarkPda } from "../../lib/chain/many-seat";
import type { Reader } from "../../lib/chain/settle-plan";
import { ENTRY_GEMAS } from "./chain";

/** An accepted Offer the Player boards with: the Backer's Account funds the entry, staged in the Offer's Backing Ticket. */
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


/** Anchor's ConstraintSeeds, and Railcar's CarBoarding (6000 + its index 5): see `isStaleBoard`. */
const CONSTRAINT_SEEDS = 2006;
const CAR_BOARDING = 6005;

/**
 * The custom program error codes an error message carries, in every form they arrive in: the structured status
 * (`{"InstructionError":[2,{"Custom":2006}]}`, `InstructionError [2, Custom 2006]`, `Custom(6005)`), the simulation's
 * `custom program error: 0x7d6`, and the same in decimal.
 */
export function customErrorCodes(message: string): number[] {
  const codes: number[] = [];
  for (const m of message.matchAll(/\bCustom\W+(\d+)\b/gi)) codes.push(Number(m[1]));
  for (const m of message.matchAll(/custom program error:?\s*(?:0x([0-9a-f]+)|(\d+))\b/gi)) codes.push(m[1] !== undefined ? parseInt(m[1], 16) : Number(m[2]));
  return codes;
}

/**
 * Errors a board gets when it was built from a snapshot another rider's transaction has since changed: `open_car` names the car
 * address from the config's next number (ConstraintSeeds, 2006 = 0x7d6) and the boarding car (CarBoarding, 6005 = 0x1775).
 * The transaction passed its preflight against the state it was built from and failed when it ran, so it is built again from
 * fresh state.
 */
export const isStaleBoard = (e: unknown): boolean =>
  e instanceof Error && (customErrorCodes(e.message).some((c) => c === CONSTRAINT_SEEDS || c === CAR_BOARDING) || /ConstraintSeeds|A car is still boarding/i.test(e.message));

/**
 * A failed transaction shows its error once it finalizes (about 13 s on devnet), by which time the rider whose open won has
 * landed, so the second read already shows the car. Five attempts, waiting 0.7 s longer each time, cover a read that still
 * misses it on a fast local validator (5 riders in 1 s: one open, four joins that no longer race).
 */
const BOARD_ATTEMPTS = 5;

/** Runs a board, building it again from fresh state (the attempt reads the chain itself) when only a stale snapshot failed it. */
export async function boardWithRetry(attempt: () => Promise<void>, o: { waitMs?: (n: number) => number } = {}): Promise<void> {
  const waitMs = o.waitMs ?? ((n: number) => 700 * n);
  for (let n = 1; ; n++) {
    try {
      return await attempt();
    } catch (e) {
      if (n >= BOARD_ATTEMPTS || !isStaleBoard(e)) throw e;
      await new Promise((r) => setTimeout(r, waitMs(n)));
    }
  }
}
