import { PublicKey } from "@solana/web3.js";
import { CORE_ID } from "./rules";
import type { ClosureRef, ClosureStore } from "./completion";

const COUNTERS_SEED = Buffer.from("counters");
const COUNTERS_BYTES = 8 + 1 + 8 + 4 + 4 + 8;
const NEXT_MATCH_AT = 8 + 1;
const NEXT_TICKET_AT = 8 + 1 + 8 + 4 + 4;

export interface ClosureReads {
  /** One getMultipleAccounts call at finalized commitment: every answer is from the same slot. */
  accountsTogether(keys: PublicKey[]): Promise<({ owner: PublicKey; data: Uint8Array } | null)[]>;
}

const countersOf = (account: string) => PublicKey.findProgramAddressSync([COUNTERS_SEED, new PublicKey(account).toBuffer()], CORE_ID)[0];

/** The Account's counter for this kind of address, or null when the counters do not exist (or are the old, shorter layout). */
function counterOf(ref: ClosureRef, counters: { owner: PublicKey; data: Uint8Array } | null): bigint | null {
  if (!counters || !counters.owner.equals(CORE_ID) || counters.data.length !== COUNTERS_BYTES) return null;
  return Buffer.from(counters.data).readBigUInt64LE(ref.seed.kind === "match" ? NEXT_MATCH_AT : NEXT_TICKET_AT);
}

/**
 * Gives back the float of sponsored Matches, Tickets and Pots that were closed, whoever closed them (the keeper, the winner's
 * page, a Player paying their own fee). A hold goes only when its address holds no Core account and the Account's counter is
 * past the number in the address: the program made the address once and cannot make it again. The address and the counter are
 * read in one call, so a creation that lands between two reads cannot look like a close.
 */
export async function releaseClosedHolds(store: ClosureStore, chain: ClosureReads, limit = 50): Promise<number> {
  const candidates = await store.closureCandidates(limit);
  if (!candidates.length) return 0;
  const keys = candidates.flatMap((c) => [new PublicKey(c.key), countersOf(c.seed.account)]);
  const read = await chain.accountsTogether(keys);
  let released = 0;
  for (const [i, ref] of candidates.entries()) {
    const address = read[2 * i], counter = counterOf(ref, read[2 * i + 1]);
    if (address && address.owner.equals(CORE_ID)) continue;
    if (counter === null || counter <= BigInt(ref.seed.n)) continue;
    released += Number(await store.releaseClosed({ key: ref.key, generation: ref.generation }));
  }
  return released;
}
