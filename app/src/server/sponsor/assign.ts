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

/**
 * The tables that can take a Match, kept by the server (migration 0023). A table is claimed when its join is sent and freed when
 * its Match settles one epoch on; a rollup read (the keeper's pool repair) republishes the truth and corrects drift.
 */
export interface TablePool {
  /** The unclaimed tables of `game` whose epoch is known. */
  tables(game: GameId): Promise<TablePick[]>;
  /** False when the table is claimed already, or the pool holds it at another epoch. */
  claim(game: GameId, pick: TablePick, matchKey: string): Promise<boolean>;
  /** The Match settled. `advanced`: it ran, so its table is one epoch on; otherwise the epoch is unknown until a rollup read. */
  free(matchKey: string, advanced: boolean): Promise<boolean>;
}

/** A claim younger than this when the rollup was read is kept: its join may not be an Assignment on base yet. */
export const CLAIM_SETTLE_MS = 3 * 60_000;

/** The pool in memory, with the rules of the SQL functions; used by tests and by a server without a database. */
export class MemoryTablePool implements TablePool {
  private readonly rows = new Map<string, { game: GameId; pick: TablePick; claimed: { match: string; at: number } | null; known: boolean }>();
  constructor(private readonly now: () => number = Date.now) {}
  private static key(game: GameId, p: Pick<TablePick, "generation" | "index">) {
    return `${game}/${p.generation}/${p.index}`;
  }
  async tables(game: GameId) {
    return [...this.rows.values()].filter((r) => r.game === game && !r.claimed && r.known).map((r) => r.pick);
  }
  async claim(game: GameId, pick: TablePick, matchKey: string) {
    const r = this.rows.get(MemoryTablePool.key(game, pick));
    if (!r || !r.known || r.pick.epoch !== pick.epoch || (r.claimed && r.claimed.match !== matchKey)) return false;
    r.claimed = { match: matchKey, at: this.now() };
    return true;
  }
  async free(matchKey: string, advanced: boolean) {
    const r = [...this.rows.values()].find((x) => x.claimed?.match === matchKey);
    if (!r) return false;
    r.claimed = null;
    r.known = advanced;
    if (advanced) r.pick = { ...r.pick, epoch: r.pick.epoch + 1n };
    return true;
  }
  /** What the rollup shows: the tables able to take a Match, read at `readAt`. */
  publish(game: GameId, tables: TablePick[], readAt = this.now()) {
    const listed = new Set<string>();
    for (const t of tables) {
      const key = MemoryTablePool.key(game, t);
      listed.add(key);
      const old = this.rows.get(key);
      const keep = old?.claimed && old.claimed.at > readAt - CLAIM_SETTLE_MS ? old.claimed : null;
      this.rows.set(key, { game, pick: t, claimed: keep, known: true });
    }
    for (const [key, r] of this.rows) if (r.game === game && !r.claimed && !r.known && !listed.has(key)) this.rows.delete(key);
  }
}

export interface AssignerDeps {
  /** Signs `assign_match`: the Table operator of the Games. */
  operator: Keypair;
  leases: LeaseStore;
  /** Tables of `game` that can take a Match right now (delegated, seated, Idle, a free slot, no live Assignment). */
  tables(game: GameId): Promise<TablePick[]>;
  /** Marks the table as held by the Match once its join is sent (the pool's `claim`). */
  claim?(game: GameId, pick: TablePick, matchKey: string): Promise<boolean>;
  /** The table generation the Game assigns now (`config.generation`). A pick of any other generation is refused by the Game, so it is never built. */
  generation?(game: GameId): Promise<number>;
  now(): number;
}

export interface Assignment {
  ix: TransactionInstruction;
  leaseKey: string;
  holder: string;
  /** The Player's own lock for this Game (one outstanding lease per Player per Game), freed with the lease. */
  lockKey?: string;
  /** What the pool needs to claim the table once the join is sent (JSON-safe: it travels in the signed build meta). */
  claim?: { game: GameId; generation: number; index: number; epoch: string; matchKey: string };
}

/** What a lease needs to be extended or released, and the claim to make when the join is sent. */
export type LeaseRef = Pick<Assignment, "leaseKey" | "holder" | "claim" | "lockKey">;

/** The Player already holds a table lease for this Game: finish or drop that join first. */
export class PlayerBusy extends Error {}

export class Assigner {
  constructor(private readonly d: AssignerDeps) {}

  get operator(): PublicKey {
    return this.d.operator.publicKey;
  }

  get keypair(): Keypair {
    return this.d.operator;
  }

  /**
   * The `assign_match` for the lowest table nobody holds, or null (no table is free: the page asks again with `buildTable`). With `player`, a Player
   * holds at most one lease per Game at a time (PlayerBusy otherwise), so a loop of builds cannot take the tables.
   */
  async assign(game: GameId, match: PublicKey, accountA: PublicKey, accountB: PublicKey, holder: string, matchKey?: string, player?: string): Promise<Assignment | null> {
    if (!canAssign(game)) return null;
    const lockKey = player ? `player/${game}/${player}` : undefined;
    if (lockKey && !(await this.d.leases.take(lockKey, holder, BUILD_LEASE_MS, this.d.now()))) throw new PlayerBusy();
    const generation = await this.d.generation?.(game).catch(() => null);
    const current = generation === null ? [] : (await this.d.tables(game)).filter((t) => generation === undefined || t.generation === generation);
    const free = [...current].sort((x, y) => x.generation - y.generation || x.index - y.index);
    for (const pick of free) {
      const leaseKey = `${game}/${pick.generation}/${pick.index}/${pick.epoch}`;
      if (!(await this.d.leases.take(leaseKey, holder, BUILD_LEASE_MS, this.d.now()))) continue;
      return { ix: assignMatchIx(game, { operator: this.operator, match, accountA, accountB, pick }), leaseKey, holder, lockKey, claim: matchKey ? { game, generation: pick.generation, index: pick.index, epoch: pick.epoch.toString(), matchKey } : undefined };
    }
    if (lockKey) await this.d.leases.release(lockKey, holder);
    return null;
  }

  /** The join was sent: the pool holds the table until the Match settles; the lease covers the start window meanwhile. */
  async confirm(a: LeaseRef): Promise<void> {
    await this.d.leases.extend(a.leaseKey, a.holder, START_WINDOW_MS, this.d.now());
    if (a.claim && this.d.claim) await this.d.claim(a.claim.game, { generation: a.claim.generation, index: a.claim.index, epoch: BigInt(a.claim.epoch) }, a.claim.matchKey);
    if (a.lockKey) await this.d.leases.release(a.lockKey, a.holder);
  }

  /** The join will not be sent: free the table. */
  async release(a: LeaseRef): Promise<void> {
    await this.d.leases.release(a.leaseKey, a.holder);
    if (a.lockKey) await this.d.leases.release(a.lockKey, a.holder);
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
