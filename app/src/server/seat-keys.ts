import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import { TESORO_CORE_ID } from "@/lib/chain/native";
import { SEATS_PER_PAGE, decodeSeatMark, decodeSeatPage, seatMarkPda, seatPagePda, type SeatMarkView, type SeatPageView } from "@/lib/chain/many-seat";

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

/**
 * Whether the car names `signer` as the seat key of `account`'s seat: the Account's seat mark gives the seat, its page the
 * seat's Player and key. Read with the app's one seat-page decoder.
 */
export async function carNamesSeatKey(read: (k: PublicKey) => Promise<MatchAccount | null>, car: PublicKey, account: PublicKey, signer: PublicKey): Promise<boolean> {
  const markInfo = await read(seatMarkPda(car, account));
  if (!markInfo || !markInfo.owner.equals(TESORO_CORE_ID)) return false;
  let mark: SeatMarkView;
  try {
    mark = decodeSeatMark(markInfo.data);
  } catch {
    return false;
  }
  if (!mark.matchKey.equals(car) || !mark.account.equals(account) || mark.returning) return false;
  const pageInfo = await read(seatPagePda(car, Math.floor(mark.seat / SEATS_PER_PAGE)));
  if (!pageInfo || !pageInfo.owner.equals(TESORO_CORE_ID)) return false;
  let page: SeatPageView;
  try {
    page = decodeSeatPage(pageInfo.data);
  } catch {
    return false;
  }
  const seat = page.seats.find((s) => s.index === mark.seat);
  return !!seat && page.matchKey.equals(car) && seat.seated && seat.player.equals(account) && seat.signer.equals(signer);
}
