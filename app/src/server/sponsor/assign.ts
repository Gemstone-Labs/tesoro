import { BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import { gameOfProgram } from "@/lib/chain/games";
import type { GameId } from "@/lib/mock/types";
import { assignMatchIx, canAssign, type TablePick } from "./assign-ix";
import { CORE_ID } from "./rules";

/** A built message is good for 75 s; the table is held a little longer than that. */
export const BUILD_LEASE_MS = 90_000;
/** After a join is sent the table is held for the Match's start window (the Game's 5 minutes plus a margin). */
export const START_WINDOW_MS = 6 * 60_000;

/**
 * Who holds which table. A lease is keyed by Game, table and epoch, so a table that went through a Match (a new epoch)
 * is free again at once, and one nobody confirmed frees itself when its time is up. Production keeps these in Postgres so
 * every server instance sees the same leases; tests keep them in memory.
 */
export interface LeaseStore {
  /** Takes the lease when it is free or expired; false when someone else holds it. */
  take(key: string, holder: string, ttlMs: number, now: number): Promise<boolean>;
  /** Holds the lease for `holder` until `now + ttlMs`. */
  extend(key: string, holder: string, ttlMs: number, now: number): Promise<void>;
  release(key: string, holder: string): Promise<void>;
}

export class MemoryLeaseStore implements LeaseStore {
  private readonly rows = new Map<string, { holder: string; until: number }>();
  async take(key: string, holder: string, ttlMs: number, now: number) {
    const r = this.rows.get(key);
    if (r && r.until > now) return false;
    this.rows.set(key, { holder, until: now + ttlMs });
    return true;
  }
  async extend(key: string, holder: string, ttlMs: number, now: number) {
    this.rows.set(key, { holder, until: now + ttlMs });
  }
  async release(key: string, holder: string) {
    if (this.rows.get(key)?.holder === holder) this.rows.delete(key);
  }
}

export interface AssignerDeps {
  /** Signs `assign_match`: the Table operator of the Games. */
  operator: Keypair;
  leases: LeaseStore;
  /** Tables of `game` that can take a Match right now (delegated, seated, Idle, a free slot, no live Assignment). */
  tables(game: GameId): Promise<TablePick[]>;
  now(): number;
}

export interface Assignment {
  ix: TransactionInstruction;
  leaseKey: string;
  holder: string;
}

/** What a lease needs to be extended or released. */
export type LeaseRef = Pick<Assignment, "leaseKey" | "holder">;

export class Assigner {
  constructor(private readonly d: AssignerDeps) {}

  get operator(): PublicKey {
    return this.d.operator.publicKey;
  }

  get keypair(): Keypair {
    return this.d.operator;
  }

  /** The `assign_match` for the lowest table nobody holds, or null (the keeper assigns the Match later). */
  async assign(game: GameId, match: PublicKey, accountA: PublicKey, accountB: PublicKey, holder: string): Promise<Assignment | null> {
    if (!canAssign(game)) return null;
    const free = [...(await this.d.tables(game))].sort((x, y) => x.generation - y.generation || x.index - y.index);
    for (const pick of free) {
      const leaseKey = `${game}/${pick.generation}/${pick.index}/${pick.epoch}`;
      if (!(await this.d.leases.take(leaseKey, holder, BUILD_LEASE_MS, this.d.now()))) continue;
      return { ix: assignMatchIx(game, { operator: this.operator, match, accountA, accountB, pick }), leaseKey, holder };
    }
    return null;
  }

  /** The join was sent: keep the table through the Match's start window. */
  confirm(a: LeaseRef): Promise<void> {
    return this.d.leases.extend(a.leaseKey, a.holder, START_WINDOW_MS, this.d.now());
  }

  /** The join will not be sent: free the table. */
  release(a: LeaseRef): Promise<void> {
    return this.d.leases.release(a.leaseKey, a.holder);
  }
}

const coder = new BorshInstructionCoder(coreIdl as Idl);
const joinAccounts = (coreIdl as unknown as { instructions: { name: string; accounts: { name: string }[] }[] }).instructions.find((i) => i.name === "join_match")!.accounts.map((a) => a.name);
const at = (name: string) => joinAccounts.indexOf(name);

/** The Match a transaction joins, the Game it is of, and the joining Player's Account; null when it joins none we assign. */
export function joinOf(ixs: { programId: PublicKey; keys: { pubkey: PublicKey }[]; data: Uint8Array }[]): { match: PublicKey; game: GameId; joiner: PublicKey } | null {
  for (const ix of ixs) {
    if (!ix.programId.equals(CORE_ID) || coder.decode(Buffer.from(ix.data))?.name !== "join_match") continue;
    const game = gameOfProgram(ix.keys[at("game_program")].pubkey);
    if (!game || !canAssign(game)) return null;
    return { match: ix.keys[at("match_state")].pubkey, game, joiner: ix.keys[at("player_account")].pubkey };
  }
  return null;
}
