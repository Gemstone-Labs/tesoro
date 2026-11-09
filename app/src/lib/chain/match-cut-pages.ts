import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import type { PublicKey } from "@solana/web3.js";
import coreIdl from "./idl/tesoro_core.json";
import { aheadOf, loadCar, sourcesOf } from "./many-seat-plan";
import { loadMatch, missingCutPages, runOf, sourcesAhead, viewOf, type Ahead, type Reader } from "./settle-plan";

const coder = new BorshAccountsCoder(coreIdl as unknown as Idl);
const MANY_SEAT_DISC = Buffer.from((coreIdl as { accounts: { name: string; discriminator: number[] }[] }).accounts.find((a) => a.name === "ManySeatMatch")!.discriminator);

/** More steps than any run has (100 seats, a few lines each): the walk stops where the run ends. */
const WHOLE_RUN = 10_000;

/**
 * The checkpoint pages the rest of a settling Match's fee cuts will write and nobody has created yet: the pages a finish's
 * page step (`cutPageIxs`, the next chunk's share of these) may ask the relayer to pay for. Empty for a Match that is gone
 * or has no run. A car (many-seat) or a head-to-head Match.
 */
export async function matchCutPages(read: Reader, match: PublicKey): Promise<PublicKey[]> {
  const [info] = await read.many([match]);
  if (!info) return [];
  let ahead: Ahead[];
  try {
    ahead = Buffer.from(info.data.subarray(0, 8)).equals(MANY_SEAT_DISC) ? await carAhead(read, match) : await headToHeadAhead(read, match, info.data);
  } catch {
    // an account that does not decode as a Match settles nothing
    return [];
  }
  return (await missingCutPages(read, ahead)).map((p) => p.address);
}

async function carAhead(read: Reader, car: PublicKey): Promise<Ahead[]> {
  const l = await loadCar(read, car);
  return l ? sourcesOf(aheadOf(l.car, l.seats, l.lines, WHOLE_RUN)) : [];
}

async function headToHeadAhead(read: Reader, match: PublicKey, data: Buffer): Promise<Ahead[]> {
  const view = viewOf(match, coder.decode("MatchState", data));
  const run = runOf(view.inner.run);
  return run ? sourcesAhead(run, (await loadMatch(read, view)).stores, WHOLE_RUN) : [];
}
