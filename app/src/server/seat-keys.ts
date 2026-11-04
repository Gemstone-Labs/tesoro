import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import { TESORO_CORE_ID } from "@/lib/chain/native";
import { SEATS_PER_PAGE, seatMarkPda, seatPagePda } from "@/lib/chain/many-seat";

const matchCoder = new BorshAccountsCoder(coreIdl as unknown as Idl);

export interface MatchSide {
  /** The side's Account key. */
  player: PublicKey;
  funder: PublicKey;
  /** The seat key that co-signed the entry (the wallet when it named none). */
  signer: PublicKey;
}

/** The Match's entered sides, A first (empty when the data is not a MatchState). */
export function matchSides(data: Uint8Array): MatchSide[] {
  try {
    const m = matchCoder.decode("MatchState", Buffer.from(data)) as { inner: { a: { player: number[]; funder: number[]; signer: number[] }; b: { player: number[]; funder: number[]; signer: number[] } | null } };
    return [m.inner.a, m.inner.b].flatMap((p) => (p ? [{ player: new PublicKey(p.player), funder: new PublicKey(p.funder), signer: new PublicKey(p.signer) }] : []));
  } catch {
    return [];
  }
}

export interface MatchAccount {
  owner: PublicKey;
  data: Uint8Array;
}

/**
 * Whether the Match names `signer` as the seat key of `account`'s side (side A only with `openerOnly`). Nothing here derives
 * an Account from a key: the Account comes from the request's wallet and the Match must name both.
 */
export function matchNamesSeatKey(match: MatchAccount | null, account: PublicKey, signer: PublicKey, openerOnly = false): boolean {
  if (!match || !match.owner.equals(TESORO_CORE_ID)) return false;
  const sides = matchSides(match.data);
  return (openerOnly ? sides.slice(0, 1) : sides).some((side) => side.player.equals(account) && side.signer.equals(signer));
}

const MANY_SEAT_DISC = Buffer.from((coreIdl as { accounts: { name: string; discriminator: number[] }[] }).accounts.find((a) => a.name === "ManySeatMatch")!.discriminator);
/** Whether the account is a many-seat car (Railcar's Match). */
export const isManySeat = (a: MatchAccount): boolean => a.owner.equals(TESORO_CORE_ID) && Buffer.from(a.data.subarray(0, 8)).equals(MANY_SEAT_DISC);

const PAGE_HEAD = 8 + 72;
/** Where a seat's key sits in the seat-key layout (a 192-byte seat; `signer` after the 160 bytes of the first layout). */
const SEAT_SIGNER_AT = 160;

/**
 * Whether the car names `signer` as the seat key of `account`'s seat: the Account's seat mark gives the seat, its page the
 * seat's Player and key. A page of the first layout (160-byte seats, no key) names no seat key.
 */
export async function carNamesSeatKey(read: (k: PublicKey) => Promise<MatchAccount | null>, car: PublicKey, account: PublicKey, signer: PublicKey): Promise<boolean> {
  const mark = await read(seatMarkPda(car, account));
  if (!mark || !mark.owner.equals(TESORO_CORE_ID) || mark.data.length < 16) return false;
  const seat = mark.data[9];
  const page = await read(seatPagePda(car, Math.floor(seat / SEATS_PER_PAGE)));
  if (!page || !page.owner.equals(TESORO_CORE_ID)) return false;
  const seatLen = Math.floor((page.data.length - PAGE_HEAD) / SEATS_PER_PAGE);
  if (seatLen < SEAT_SIGNER_AT + 32) return false;
  const at = PAGE_HEAD + (seat % SEATS_PER_PAGE) * seatLen;
  const d = Buffer.from(page.data);
  return d[at] === 1 && new PublicKey(d.subarray(at + 40, at + 72)).equals(account) && new PublicKey(d.subarray(at + SEAT_SIGNER_AT, at + SEAT_SIGNER_AT + 32)).equals(signer);
}
