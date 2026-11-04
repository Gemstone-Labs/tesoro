import type { PublicKey } from "@solana/web3.js";
import { getChain } from "@/lib/chain/client";
import { matchAddressOf } from "@/lib/chain/match-id";
import { matchSides } from "@/server/seat-keys";
import { seatKeys, type SeatKeyManager } from "./seat-key";

export type MatchRead = (address: PublicKey) => Promise<Uint8Array | null>;

const readOnChain: MatchRead = async (address) => (await getChain().base.getAccountInfo(address, "confirmed"))?.data ?? null;

/**
 * Deletes the keys of Matches that are over or never happened: the Match account is gone (closed), or exists and names another
 * key (a lost join race, an entry from another attempt). The check that leaves a key alone is positive: the Match names it.
 */
export function pruneSeatKeys(manager: SeatKeyManager = seatKeys(), read: MatchRead = readOnChain, graceMs?: number): Promise<string[]> {
  return manager.prune(async (matchKey, publicKey) => {
    const address = matchAddressOf(matchKey);
    if (!address) return "unnamed";
    const data = await read(address);
    if (!data) return "unnamed";
    return matchSides(data).some((s) => s.signer.toBase58() === publicKey) ? "named" : "unnamed";
  }, graceMs);
}
