import { createHash } from "node:crypto";
import bs58 from "bs58";
import { PublicKey, VersionedTransaction, type Connection, type VersionedTransactionResponse, type TransactionInstruction } from "@solana/web3.js";
import type { ObservationStore } from "./observed-completion.ts";

const CORE = new PublicKey("AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh");
/** Railcar's `open_car` creates the car's core Match by CPI (completion.test.ts keeps it equal to the IDL's address). */
export const RAILCAR = new PublicKey("DJkNxkAogb32VQm1TQMSVCbzHcaV3SDBy5kBmpqaNHxC");
export interface ReservationRef { key: string; generation: string }
/**
 * Where a held address comes from: a Match is `["match", account, n]` and a Ticket or Pot `["ticket", account, n]`, and the
 * Core program only makes one when `n` is the next value of that Account's counter. So the address is absent while the
 * counter is past `n` only after it was created and closed, and it can never be made again.
 */
export interface HoldSeed { kind: "match" | "ticket"; account: string; n: string }
export interface CompletionInput {
  signature: string;
  raw: string;
  creates: string[];
  ensures: string[];
  closes: string[];
  reserve: string;
  /** Seeds of the created and ensured addresses, by address. */
  seeds?: Record<string, HoldSeed>;
}
export interface CompletionJournal extends Omit<CompletionInput, "closes" | "seeds"> {
  acquired: ReservationRef[];
  closes: ReservationRef[];
  state: "pending" | "succeeded" | "failed";
}
export interface CompletionStore {
  /** Atomically snapshot generations and acquire new reserves before any broadcast. False on a replay. */
  prepareCompletion(input: CompletionInput): Promise<boolean>;
  /** Terminal, idempotent and generation scoped. Only trusted callers with chain evidence may finish. */
  finishCompletion(signature: string, success: boolean, preflight?: boolean): Promise<void>;
  pendingCompletions(limit?: number): Promise<CompletionJournal[]>;
}

// Account roles in the deployed Core instruction interface; tested against its IDL.
const ROLES = [
  { name: "open_match", kind: "creates", slots: [14] },
  { name: "open_ticket", kind: "creates", slots: [7] },
  { name: "join_match", kind: "ensures", slots: [9] },
  { name: "close_match", kind: "closes", slots: [1, 3, 5] },
  { name: "close_ticket", kind: "closes", slots: [1] },
  { name: "join_many_seat_match", kind: "ensures", slots: [8] },
  { name: "close_many_seat_match", kind: "closes", slots: [1] },
] as const;
const RAILCAR_ROLES = [{ name: "open_car", kind: "creates", slots: [5] }] as const;
const discriminator = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

export function completionEffects(ixs: (Pick<TransactionInstruction, "programId" | "keys"> & { data: Uint8Array })[]) {
  const result: { creates: string[]; ensures: string[]; closes: string[] } = { creates: [], ensures: [], closes: [] };
  for (const ix of ixs) {
    const roles = ix.programId.equals(CORE) ? ROLES : ix.programId.equals(RAILCAR) ? RAILCAR_ROLES : null;
    if (!roles) continue;
    const role = (roles as readonly { name: string; kind: "creates" | "ensures" | "closes"; slots: readonly number[] }[]).find((r) => discriminator(r.name).equals(Buffer.from(ix.data).subarray(0, 8)));
    if (!role) continue;
    for (const slot of role.slots) {
      const key = ix.keys[slot]?.pubkey;
      if (!key) throw new Error(`Missing ${role.name} account ${slot}`);
      if (!key.equals(CORE)) result[role.kind].push(key.toBase58());
    }
  }
  return Object.fromEntries(Object.entries(result).map(([k, v]) => [k, [...new Set(v)]])) as typeof result;
}

export function completionInput(tx: VersionedTransaction, effects: ReturnType<typeof completionEffects>, reserve: bigint, seeds: Record<string, HoldSeed> = {}): CompletionInput {
  if (tx.signatures[0].every((b) => b === 0)) throw new Error("Persist only a signed sponsor transaction");
  return { signature: bs58.encode(tx.signatures[0]), raw: Buffer.from(tx.serialize()).toString("base64"), ...effects, reserve: reserve.toString(), seeds };
}

const u64At = (data: Uint8Array, at: number) => Buffer.from(data).readBigUInt64LE(at).toString();
/** Account slots and argument offsets (after the 8-byte discriminator) that name the seed of a created address; tested against the IDL. */
const SEEDED = [
  { name: "open_match", kind: "match", address: 14, account: 8, n: 8 + 32 + 8 },
  { name: "open_ticket", kind: "ticket", address: 7, account: 4, n: 8 },
] as const;
/** Railcar's `open_car(n)`: the car's Match is `["match", opener Account, n]`. */
const RAILCAR_SEEDED = { name: "open_car", kind: "match", address: 5, account: 11, n: 8 } as const;

/** The seeds of what the instructions create. `join_match` only ensures a Match: its seed is read from the Match by `matchSeed`. */
export async function holdSeeds(
  ixs: (Pick<TransactionInstruction, "programId" | "keys"> & { data: Uint8Array })[],
  matchSeed: (match: string) => Promise<HoldSeed | null>,
): Promise<Record<string, HoldSeed>> {
  const out: Record<string, HoldSeed> = {};
  for (const ix of ixs) {
    const head = Buffer.from(ix.data).subarray(0, 8);
    if (ix.programId.equals(RAILCAR) && discriminator(RAILCAR_SEEDED.name).equals(head)) {
      const address = ix.keys[RAILCAR_SEEDED.address]?.pubkey, account = ix.keys[RAILCAR_SEEDED.account]?.pubkey;
      if (!address || !account) throw new Error("Missing open_car account");
      out[address.toBase58()] = { kind: "match", account: account.toBase58(), n: u64At(ix.data, RAILCAR_SEEDED.n) };
      continue;
    }
    if (!ix.programId.equals(CORE)) continue;
    const seeded = SEEDED.find((r) => discriminator(r.name).equals(head));
    if (seeded) {
      const address = ix.keys[seeded.address]?.pubkey, account = ix.keys[seeded.account]?.pubkey;
      if (!address || !account) throw new Error(`Missing ${seeded.name} account`);
      out[address.toBase58()] = { kind: seeded.kind, account: account.toBase58(), n: u64At(ix.data, seeded.n) };
    } else if (discriminator("join_match").equals(head) || discriminator("join_many_seat_match").equals(head)) {
      const match = ix.keys[discriminator("join_match").equals(head) ? 9 : 8]?.pubkey.toBase58();
      const seed = match ? await matchSeed(match) : null;
      if (match && seed) out[match] = seed;
    }
  }
  return out;
}

export interface ClosureRef extends ReservationRef { seed: HoldSeed }
/** Holds whose address can show they were closed: absent while the Account's counter is past `seed.n`. */
export interface ClosureStore {
  /** The next holds to check, oldest check first; marks them as checked. */
  closureCandidates(limit?: number): Promise<ClosureRef[]>;
  /** Compare-and-delete by generation under the journal lock. False when the hold is gone or is a newer generation. */
  releaseClosed(ref: ReservationRef): Promise<boolean>;
}

export interface CompletionChain {
  getTransaction(signature: string, options: { commitment: "finalized"; maxSupportedTransactionVersion: 0 }): Promise<VersionedTransactionResponse | null>;
  isBlockhashValid?: Connection["isBlockhashValid"];
  sendRawTransaction?: Connection["sendRawTransaction"];
}

export async function recoverCompletions(store: CompletionStore, chain: CompletionChain, limit = 20): Promise<number> {
  let done = 0;
  for (const journal of await store.pendingCompletions(limit)) done += Number(await reconcileCompletion(store, chain, journal));
  return done;
}

/** No account-absence sweep: only the saved transaction's finalized execution can retire its captured generations. */
export async function reconcileCompletion(store: CompletionStore, chain: CompletionChain, journal: CompletionJournal): Promise<boolean> {
  const tx = await chain.getTransaction(journal.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
  const saved = VersionedTransaction.deserialize(Buffer.from(journal.raw, "base64"));
  if (bs58.encode(saved.signatures[0]) !== journal.signature) throw new Error("Sponsor signature does not match saved transaction");
  if (!tx) {
    if (chain.isBlockhashValid && chain.sendRawTransaction && (await chain.isBlockhashValid(saved.message.recentBlockhash, { commitment: "finalized" })).value) {
      // A replay uses the identical signed bytes; it cannot charge twice or affect a later generation.
      await chain.sendRawTransaction(Buffer.from(journal.raw, "base64"), { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0 }).catch(() => undefined);
    }
    return false;
  }
  if (!tx.meta) return false;
  if (tx.transaction.signatures[0] !== journal.signature || !Buffer.from(saved.message.serialize()).equals(Buffer.from(tx.transaction.message.serialize()))) throw new Error("Sponsor confirmation does not match saved transaction");
  if (tx.meta.err) {
    await store.finishCompletion(journal.signature, false);
    return true;
  }
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
  const ixs = tx.transaction.message.compiledInstructions.map((ix) => ({
    programId: keys.get(ix.programIdIndex)!,
    keys: ix.accountKeyIndexes.map((i) => ({ pubkey: keys.get(i)!, isSigner: false, isWritable: true })),
    data: Buffer.from(ix.data),
  }));
  const closed = new Set(completionEffects(ixs).closes);
  for (const ref of journal.closes) {
    const index = Array.from({ length: keys.length }, (_, i) => i).find((i) => keys.get(i)?.toBase58() === ref.key);
    if (!closed.has(ref.key) || index === undefined || !(tx.meta.preBalances[index] > 0) || tx.meta.postBalances[index] !== 0) return false;
  }
  await store.finishCompletion(journal.signature, true);
  return true;
}

/** The same narrow RPC adapter is used by app and keeper; it never writes sponsor_hold directly. */
export function completionStore(rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>): CompletionStore & ObservationStore & ClosureStore {
  return {
    prepareCompletion: async (input) => Boolean(await rpc("sponsor_prepare_completion", { p_input: input })),
    finishCompletion: async (signature, success, preflight = false) => { await rpc("sponsor_finish_completion", { p_signature: signature, p_success: success, p_preflight: preflight }); },
    pendingCompletions: async (limit = 50) => await rpc("sponsor_pending_completions", { p_limit: limit }) as CompletionJournal[],
    claimReservations: async (limit = 3) => await rpc("sponsor_claim_reservations", { p_limit: limit }) as Awaited<ReturnType<ObservationStore["claimReservations"]>>,
    advanceReservation: async (ref, before) => { await rpc("sponsor_advance_reservation", { p_ref: ref, p_before: before }); },
    closureCandidates: async (limit = 50) => await rpc("sponsor_closure_candidates", { p_limit: limit }) as ClosureRef[],
    releaseClosed: async (ref) => Boolean(await rpc("sponsor_release_closed", { p_ref: ref })),
    releaseObservedCompletion: async (ref, signature) => Boolean(await rpc("sponsor_release_observed", { p_ref: ref, p_signature: signature })),
  };
}
