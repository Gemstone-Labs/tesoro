import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import { TESORO_CORE_ID } from "@/lib/chain/native";

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
