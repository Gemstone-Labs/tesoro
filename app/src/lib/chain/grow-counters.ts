import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { coreIx, CORE_PROGRAM_ID } from "./core-ix";
import coreIdl from "./idl/tesoro_core.json";

/**
 * Counters made before `next_ticket` have 25 bytes, and the program cannot read them until they are 33. `grow_counters` is
 * permissionless: whoever sends a transaction that reads such an account puts the grow in front of it and pays the 8 bytes of rent.
 */
export const COUNTERS_V1_LEN = 25;
/** Rent of the 8 new bytes (8 x 6,960 lamports), and the compute one grow uses. */
export const GROW_COUNTERS_RENT = 55_680n;
export const GROW_COUNTERS_CU = 10_000;
/** `next_ticket` of a grown account: above every nonce an old client picked (AccountCounters::LEGACY_TICKET_BASE). */
export const LEGACY_TICKET_BASE = 1n << 63n;

const DISC = Buffer.from((coreIdl.accounts as { name: string; discriminator: number[] }[]).find((a) => a.name === "AccountCounters")!.discriminator);

export interface RawAccount {
  owner: PublicKey;
  data: Uint8Array;
}

export const isShortCounters = (a: RawAccount | null | undefined): boolean => !!a && a.owner.equals(CORE_PROGRAM_ID) && a.data.length === COUNTERS_V1_LEN && Buffer.from(a.data.subarray(0, 8)).equals(DISC);

export const growCountersIx = (payer: PublicKey, counters: PublicKey): TransactionInstruction => coreIx("grow_counters", { payer, counters });

/** The grow instructions for those of `keys` (read as `infos`, same order) that are short counters accounts. */
export const growIxsFor = (payer: PublicKey, keys: PublicKey[], infos: (RawAccount | null | undefined)[]): TransactionInstruction[] => {
  const seen = new Set<string>();
  const out: TransactionInstruction[] = [];
  keys.forEach((k, i) => {
    if (seen.has(k.toBase58()) || !isShortCounters(infos[i])) return;
    seen.add(k.toBase58());
    out.push(growCountersIx(payer, k));
  });
  return out;
};
