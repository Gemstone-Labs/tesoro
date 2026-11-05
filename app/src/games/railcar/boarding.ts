import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { SeatView } from "../../lib/chain/many-seat";
import type { LoadedCar } from "../../lib/chain/many-seat-plan";
import type { Reader } from "../../lib/chain/settle-plan";
import type { EntryPreview } from "../../lib/chain/entry";

export interface BoardingBacking {
  offer: PublicKey;
  backerAccount: PublicKey;
}
export async function boardingEntry(_conn: unknown, _me: PublicKey, _backing?: BoardingBacking): Promise<{ funder: PublicKey; preview: EntryPreview }> {
  throw new Error("not built");
}
export async function backerSeatedIn(_read: Reader, _car: PublicKey, _backer: PublicKey): Promise<boolean> {
  throw new Error("not built");
}
export async function stepOffFor(_core: unknown, _read: Reader, _a: { caller: PublicKey; loaded: LoadedCar; seat: SeatView }): Promise<TransactionInstruction> {
  throw new Error("not built");
}
