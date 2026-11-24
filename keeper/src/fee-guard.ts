import anchor from "@coral-xyz/anchor";
import type { PublicKey } from "@solana/web3.js";
import { scanProgramAccounts, type ScanRpc } from "./credits.ts";
import { discriminatorOf } from "./lists.ts";
import { SLICE_LEN, carHeadAt, headOf, type Head } from "./safety-sweep.ts";

/**
 * Fees are read when a Match settles, not when it opens (tesoro_core `matching.rs` and `many_seat_settle.rs` read
 * `leaderboard_terms()` at settlement; decisions Q40, review #4): a fee change while a Match is open changes a Pot already
 * shown, such as the Prize on a Railcar car. Admin scripts that change a fee refuse until every Match and car is closed.
 * Null when none is open, else why the change is refused.
 */
export function feeChangeRefusal(heads: Head[], unreadable: PublicKey[] = []): string | null {
  if (unreadable.length)
    return `refusing to change a fee: ${unreadable.length} Match or car could not be read (a short row, an unknown stage or an older layout), e.g. ${unreadable[0].toBase58()}, so it may still be open. Check it before changing a fee.`;
  const open = heads.filter((h) => h.stage !== "closed");
  if (!open.length) return null;
  const cars = open.filter((h) => h.car).length;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return `refusing to change a fee: ${open.length} open (${plural(open.length - cars, "Match", "Matches")}, ${plural(cars, "car", "cars")}), e.g. ${open[0].address.toBase58()} (${open[0].stage}). Fees are read at settlement, so a change now would change what an open Match pays. Wait until every Match has settled and closed, then run this again.`;
}

/**
 * Every head-to-head Match and many-seat car of tesoro_core `core`, read with one sliced scan each. `unreadable`: rows with
 * the Match or car discriminator that do not decode (the fee guard refuses on them: they may be open).
 */
export async function matchHeads(rpc: ScanRpc, core: PublicKey): Promise<{ heads: Head[]; unreadable: PublicKey[] }> {
  const rowsOf = (name: string) => scanProgramAccounts(rpc, core, { filters: [{ memcmp: { offset: 0, bytes: anchor.utils.bytes.bs58.encode(discriminatorOf(name)) } }], dataSlice: { offset: 0, length: SLICE_LEN } });
  const [matches, cars] = await Promise.all([rowsOf("MatchState"), rowsOf("ManySeatMatch")]);
  const heads: Head[] = [];
  const unreadable: PublicKey[] = [];
  const take = (pubkey: PublicKey, h: Head | null) => (h ? heads.push(h) : unreadable.push(pubkey));
  for (const r of matches) take(r.pubkey, headOf(r.pubkey, r.account.data));
  for (const r of cars) take(r.pubkey, carHeadAt(r.pubkey, r.account.data));
  return { heads, unreadable };
}

/** `p`, or a rejection after `ms` that says what took too long and what to do (some RPCs, such as rpc.magicblock.app, hang on getProgramAccounts). */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000} s: this RPC may not serve getProgramAccounts (rpc.magicblock.app hangs on it). Pass --rpc with a Helius or Alchemy URL and run this again.`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}
