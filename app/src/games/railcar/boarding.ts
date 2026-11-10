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


/**
 * Errors a board gets when it was built from a snapshot another rider's transaction has since changed: `open_car` names the car
 * address from the config's next number (Anchor ConstraintSeeds, 0x7d6) and the boarding car (CarBoarding, 0x1775), and a join
 * names a seat page. None of them sends anything, so the board can be built again from fresh state.
 */
export const isStaleBoard = (e: unknown): boolean => e instanceof Error && /0x7d6|0x1775|ConstraintSeeds|A car is still boarding/i.test(e.message);

const BOARD_ATTEMPTS = 3;

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
