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
export function feeChangeRefusal(heads: Head[]): string | null {
  const open = heads.filter((h) => h.stage !== "closed");
  if (!open.length) return null;
  const cars = open.filter((h) => h.car).length;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return `refusing to change a fee: ${open.length} open (${plural(open.length - cars, "Match", "Matches")}, ${plural(cars, "car", "cars")}), e.g. ${open[0].address.toBase58()} (${open[0].stage}). Fees are read at settlement, so a change now would change what an open Match pays. Wait until every Match has settled and closed, then run this again.`;
}

/** Every head-to-head Match and many-seat car of tesoro_core `core`, read with one sliced scan each. */
export async function matchHeads(rpc: ScanRpc, core: PublicKey): Promise<Head[]> {
  const rowsOf = (name: string) => scanProgramAccounts(rpc, core, { filters: [{ memcmp: { offset: 0, bytes: anchor.utils.bytes.bs58.encode(discriminatorOf(name)) } }], dataSlice: { offset: 0, length: SLICE_LEN } });
  const [matches, cars] = await Promise.all([rowsOf("MatchState"), rowsOf("ManySeatMatch")]);
  return [...matches.map((r) => headOf(r.pubkey, r.account.data)), ...cars.map((r) => carHeadAt(r.pubkey, r.account.data))].filter((h): h is Head => !!h);
}
