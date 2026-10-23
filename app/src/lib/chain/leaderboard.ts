/**
 * Leaderboard reads shared by the app's server route, the keeper and the game clients: the pool
 * Account's basket, the live Leaderboard Fee in Config, the recorded Season, and a season's wins from
 * the `MatchWon` event-CPIs of tesoro_core (the Match history database serves the same wins to the
 * app; this scan is the keeper's and the fallback's source). See docs/adr/0006.
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, type Connection } from "@solana/web3.js";
import coreIdl from "./idl/tesoro_core.json";
import { PRIZE_BPS, pointsForWin, seasonEnd, seasonStart, setLeaderboardSince, type Win } from "./season";
import { basketPda, decodeStore, spillPda } from "./basket";
import { decodeMatchRecords, innerInstructionsOf } from "../../server/history/events";
import { matchKeyOf } from "../../server/history/match-key";

const CORE = new PublicKey(coreIdl.address);
const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, CORE)[0];

/** The address that owns the pool Account; nobody can sign for it. */
export const POOL_AUTHORITY = pda([Buffer.from("leaderboard")]);
/** The Leaderboard Pool: a TesoroAccount, so its Gemas move like any other Account's. */
export const POOL_ACCOUNT = pda([Buffer.from("account"), POOL_AUTHORITY.toBuffer()]);
export const CONFIG = pda([Buffer.from("config")]);
export const seasonPda = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return pda([Buffer.from("season"), b]);
};
/** @deprecated The window is part of `SeasonState` now; this address is not an account. The old keeper still imports it until ticket 19 rewrites the Season job. */
export const seasonWindowPda = (n: number) => seasonPda(n);

/** Fee terms the program applies at settlement; `bps` 0 means no pool fee. */
export interface LeaderboardTerms {
  bps: number;
  recipient: PublicKey | null;
  /** `Config.leaderboard_since`, unix seconds (0 while off). */
  since: number;
}
export const NO_LEADERBOARD: LeaderboardTerms = { bps: 0, recipient: null, since: 0 };

// Config: disc 8, bump 1, admin 32, oracle 32, platform_bps 2, platform_recipient 32, games (4 + 98 each), then the Leaderboard fields.
const GAMES_AT = 8 + 1 + 32 + 32 + 2 + 32;
const GAME_BYTES = 32 + 32 + 2 + 32;

/** Reads the fee from the raw Config bytes. An account that predates the Leaderboard has no such fields: no fee. */
export function parseLeaderboardTerms(data: Uint8Array): LeaderboardTerms {
  // DataView, not Buffer: the browser's Buffer polyfill has no readBigInt64LE.
  const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < GAMES_AT + 4) return NO_LEADERBOARD;
  const at = GAMES_AT + 4 + d.getUint32(GAMES_AT, true) * GAME_BYTES;
  if (data.length < at + 2 + 32 + 8) return NO_LEADERBOARD;
  const pool = new PublicKey(data.subarray(at + 2, at + 34));
  if (pool.equals(PublicKey.default)) return NO_LEADERBOARD;
  return { bps: d.getUint16(at, true), recipient: pool, since: Number(d.getBigInt64(at + 34, true)) };
}

/**
 * The entry sizes set on-chain (`Config.entry_sizes`: four u64 after the Leaderboard fields, zero-padded),
 * or null while none is set (the program then allows its default ladder, 100 / 500 / 1,000) or the account predates the field.
 * The pickers read `cluster-settings`, which mirrors what the admin sets; this is the check against the chain.
 */
export function parseEntrySizes(data: Uint8Array): number[] | null {
  const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < GAMES_AT + 4) return null;
  const at = GAMES_AT + 4 + d.getUint32(GAMES_AT, true) * GAME_BYTES + 2 + 32 + 8;
  if (data.length < at + 4 * 8) return null;
  const sizes: number[] = [];
  for (let i = 0; i < 4; i++) {
    const n = Number(d.getBigUint64(at + i * 8, true));
    if (n > 0) sizes.push(n);
  }
  return sizes.length ? sizes : null;
}

const TERMS_TTL_MS = 60_000;
let cached: { at: number; terms: LeaderboardTerms; conn: Connection } | null = null;

/** The live terms (cached a minute): settlement payouts must include the pool exactly when the program charges it. */
export async function fetchLeaderboardTerms(conn: Connection, fresh = false): Promise<LeaderboardTerms> {
  if (!fresh && cached && cached.conn === conn && Date.now() - cached.at < TERMS_TTL_MS) return cached.terms;
  const info = await conn.getAccountInfo(CONFIG, "confirmed");
  const terms = info ? parseLeaderboardTerms(info.data) : NO_LEADERBOARD;
  cached = { at: Date.now(), terms, conn };
  setLeaderboardSince(terms.since);
  return terms;
}

/** The Pool's playable Gemas from its raw basket and spill accounts (header totals of both). */
export function poolTotalOf(basket: Uint8Array | null, spill: Uint8Array | null = null): bigint {
  let total = 0n;
  for (const data of [basket, spill]) {
    if (!data) continue;
    const { header } = decodeStore(data);
    total += header.ownTotal + header.wonTotal;
  }
  return total;
}

/** Gemas in the pool right now. */
export async function fetchPoolTotal(conn: Connection): Promise<bigint> {
  const [basket, spill] = await conn.getMultipleAccountsInfo([basketPda(POOL_ACCOUNT), spillPda(POOL_ACCOUNT)], "confirmed");
  return poolTotalOf(basket?.data ?? null, spill?.data ?? null);
}

export interface SeasonRecord {
  number: number;
  poolTotal: bigint;
  count: number;
  winners: string[];
  points: number[];
  amounts: bigint[];
  paidMask: number;
  /** Unix seconds it was recorded, and the ranks voided inside the payout window. Null/0 for a Season recorded before the window existed. */
  recordedAt: number | null;
  voidedMask: number;
}

const field = (o: any, camel: string, snake: string) => o[camel] ?? o[snake];

/** The Season record from a decoded `SeasonState` (budget frozen when it was recorded). */
export function seasonRecordOf(state: any): SeasonRecord {
  const s: any = state.inner;
  const count = Number(s.count);
  const lines: any[] = s.lines ?? [];
  const total = lines.reduce((a, l) => a + BigInt(l.amount.toString()), 0n);
  const cursor: number[] = Array.from(s.cursor);
  const window = s.window;
  const recordedAt = Number(field(window, "recordedAt", "recorded_at").toString());
  let paidMask = 0;
  for (let r = 0; r < count; r++) if (cursor[r] === lines.length) paidMask |= 1 << r;
  return {
    number: Number(s.number),
    poolTotal: total,
    count,
    winners: (s.winners as number[][]).slice(0, count).map((w) => new PublicKey(Uint8Array.from(w)).toBase58()),
    points: (s.points as any[]).slice(0, count).map((p) => Number(p.toString())),
    amounts: PRIZE_BPS.slice(0, count).map((bps) => lines.reduce((a, l) => a + (BigInt(l.amount.toString()) * BigInt(bps)) / 10_000n, 0n)),
    paidMask,
    recordedAt: recordedAt > 0 ? recordedAt : null,
    voidedMask: Number(field(window, "voidedMask", "voided_mask")),
  };
}

/** A recorded season, or null while nobody has recorded it. */
export async function fetchSeasonRecord(conn: Connection, n: number): Promise<SeasonRecord | null> {
  const info = await conn.getAccountInfo(seasonPda(n), "confirmed");
  if (!info) return null;
  const coder = new anchor.BorshAccountsCoder(coreIdl as any);
  try {
    return seasonRecordOf(coder.decode("SeasonState", Buffer.from(info.data)));
  } catch {
    return null; // a record written by the pre-economy program has another layout: it was paid by that program
  }
}

const winCache = new Map<string, Win[]>();

/**
 * The wins among a transaction's inner instructions: `MatchWon` event-CPIs that tesoro_core itself issued
 * (`decodeMatchRecords` checks the program id and core's event-authority account, so another program's
 * instruction or log carrying the same bytes counts for nothing).
 */
export function winsFromInner(inner: Parameters<typeof decodeMatchRecords>[0]): Win[] {
  return decodeMatchRecords(inner).flatMap((r) =>
    r.type === "won" ? [{ player: r.winner, points: r.points, ts: r.ts, matchId: matchKeyOf({ opener: r.opener, n: r.n }), loser: r.loser === ZERO_KEY ? undefined : r.loser }] : [],
  );
}

const ZERO_KEY = PublicKey.default.toBase58();
/** Core's event-authority PDA: every event-CPI lists it, so its signatures are exactly the transactions that emitted events. */
const EVENT_AUTHORITY = pda([Buffer.from("__event_authority")]);

/**
 * Every Match won in season `n`, from the `MatchWon` events of tesoro_core's transactions. Wins are keyed by
 * signature and cached for good: a confirmed transaction never changes.
 */
export async function fetchSeasonWins(conn: Connection, n: number, concurrency = 6): Promise<Win[]> {
  const from = seasonStart(n);
  const to = seasonEnd(n);
  const sigs: string[] = [];
  let before: string | undefined;
  for (let page = 0; page < 40; page++) {
    const batch = await conn.getSignaturesForAddress(EVENT_AUTHORITY, { before, limit: 1000 }, "confirmed");
    if (!batch.length) break;
    let older = false;
    for (const s of batch) {
      if (s.blockTime != null && s.blockTime < from) older = true;
      else if (!s.err && s.blockTime != null && s.blockTime < to) sigs.push(s.signature);
    }
    if (older || batch.length < 1000) break;
    before = batch[batch.length - 1].signature;
  }
  const todo = sigs.filter((s) => !winCache.has(s));
  for (let i = 0; i < todo.length; i += concurrency) {
    await Promise.all(
      todo.slice(i, i + concurrency).map(async (sig) => {
        const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
        if (!tx || tx.meta?.err) return;
        winCache.set(sig, winsFromInner(innerInstructionsOf(tx as never)));
      }),
    );
  }
  const wins: Win[] = [];
  for (const sig of sigs) for (const w of winCache.get(sig) ?? []) if (w.ts >= from && w.ts < to) wins.push(w);
  return wins;
}

export { pointsForWin };
