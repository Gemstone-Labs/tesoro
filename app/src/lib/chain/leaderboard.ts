/**
 * Leaderboard reads shared by the app's server route, the keeper and the game clients: the pool
 * Account, the live Leaderboard Fee in Config, and a season's wins from the pool's transaction
 * history (every won Match pays the pool its fee, and emits `MatchWon`). See docs/adr/0006.
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, type Connection } from "@solana/web3.js";
import coreIdl from "./idl/tesoro_core.json";
import { pointsForWin, seasonEnd, seasonStart, setLeaderboardSince, type Win } from "./season";

const CORE = new PublicKey(coreIdl.address);
const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, CORE)[0];

/** The address that owns the pool Account; nobody can sign for it. */
export const POOL_AUTHORITY = pda([Buffer.from("leaderboard")]);
/** The Leaderboard Pool: a TesoroAccount, so its Gemas move like any other Account's. */
export const POOL_ACCOUNT = pda([Buffer.from("account"), POOL_AUTHORITY.toBuffer()]);
export const CONFIG = pda([Buffer.from("config")]);
export const seasonWindowPda = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return pda([Buffer.from("season_window"), b]);
};
export const seasonPda = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return pda([Buffer.from("season"), b]);
};

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
 * or null while none is set (the program then allows 500 / 1,000 / 2,500) or the account predates the field.
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

// TesoroAccount: disc 8, bump 1, authority 32, evm 20, then own_total, won_total, own_reserved, won_reserved.
const OWN_TOTAL_AT = 8 + 1 + 32 + 20;

/** Own plus won Gemas from the raw pool Account bytes. */
export function poolTotalOf(data: Uint8Array): bigint {
  const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return d.getBigUint64(OWN_TOTAL_AT, true) + d.getBigUint64(OWN_TOTAL_AT + 8, true);
}

/** Gemas in the pool right now. */
export async function fetchPoolTotal(conn: Connection): Promise<bigint> {
  const info = await conn.getAccountInfo(POOL_ACCOUNT, "confirmed");
  if (!info || info.data.length < OWN_TOTAL_AT + 16) return 0n;
  return poolTotalOf(info.data);
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

/** A recorded season, or null while nobody has recorded it. */
export async function fetchSeasonRecord(conn: Connection, n: number): Promise<SeasonRecord | null> {
  const info = await conn.getAccountInfo(seasonPda(n), "confirmed");
  if (!info) return null;
  const coder = new anchor.BorshAccountsCoder(coreIdl as any);
  const s: any = coder.decode("SeasonState", Buffer.from(info.data)).inner;
  const count = Number(s.count);
  const windowInfo = await conn.getAccountInfo(seasonWindowPda(n), "confirmed");
  const w: any = windowInfo ? coder.decode("SeasonWindowState", Buffer.from(windowInfo.data)).inner : null;
  return {
    number: Number(s.number),
    poolTotal: BigInt(s.pool_total?.toString() ?? s.poolTotal.toString()),
    count,
    winners: (s.winners as number[][]).slice(0, count).map((w) => new PublicKey(Uint8Array.from(w)).toBase58()),
    points: (s.points as any[]).slice(0, count).map((p) => Number(p.toString())),
    amounts: (s.amounts as any[]).slice(0, count).map((a) => BigInt(a.toString())),
    paidMask: Number(s.paidMask ?? s.paid_mask),
    recordedAt: w ? Number((w.recordedAt ?? w.recorded_at).toString()) : null,
    voidedMask: w ? Number(w.voidedMask ?? w.voided_mask) : 0,
  };
}

const winCache = new Map<string, Win | null>();

const WON_DISC = Buffer.from((coreIdl as any).events.find((e: any) => e.name === "MatchWon").discriminator);
/** Body of `MatchWon` before it named the loser: match_id, game, entry, player, funder, points, pool_fee, season, ts. */
const WON_BODY_V1 = 8 + 32 + 8 + 32 + 32 + 8 + 8 + 4 + 8;
const ZERO_KEY = PublicKey.default.toBase58();

/**
 * Parses the `MatchWon` events of one transaction's logs. By hand, because events written before the loser
 * was added are 32 bytes shorter and the current IDL would refuse them (they read as uncapped).
 */
export function winsFromLogs(logs: string[], signature: string): Win[] {
  const out: Win[] = [];
  for (const line of logs) {
    const at = line.indexOf("Program data: ");
    if (at < 0) continue;
    const buf = Buffer.from(line.slice(at + 14), "base64");
    if (buf.length < 8 + WON_BODY_V1 || !buf.subarray(0, 8).equals(WON_DISC)) continue;
    const v = new DataView(buf.buffer, buf.byteOffset + 8, buf.length - 8);
    const key = (o: number) => new PublicKey(buf.subarray(8 + o, 8 + o + 32)).toBase58();
    const loser = buf.length >= 8 + WON_BODY_V1 + 32 ? key(WON_BODY_V1) : undefined;
    out.push({
      player: key(48),
      points: Number(v.getBigUint64(112, true)),
      ts: Number(v.getBigInt64(132, true)),
      matchId: v.getBigUint64(0, true).toString(),
      ...(loser && loser !== ZERO_KEY ? { loser } : {}),
    });
  }
  void signature;
  return out;
}

/**
 * Every Match won in season `n`, from the pool's history: each win pays the pool, so the pool's
 * signatures are exactly the wins (plus the season's own payouts, which carry no `MatchWon`).
 * Wins are keyed by signature and cached for good: a confirmed transaction never changes.
 */
export async function fetchSeasonWins(conn: Connection, n: number, concurrency = 6): Promise<Win[]> {
  const from = seasonStart(n);
  const to = seasonEnd(n);
  const sigs: string[] = [];
  let before: string | undefined;
  for (let page = 0; page < 20; page++) {
    const batch = await conn.getSignaturesForAddress(POOL_ACCOUNT, { before, limit: 1000 }, "confirmed");
    if (!batch.length) break;
    let older = false;
    for (const s of batch) {
      if (s.blockTime != null && s.blockTime < from) older = true;
      else if (!s.err && s.blockTime != null && s.blockTime < to) sigs.push(s.signature);
    }
    if (older || batch.length < 1000) break;
    before = batch[batch.length - 1].signature;
  }
  const wins: Win[] = [];
  const todo = sigs.filter((s) => !winCache.has(s));
  for (let i = 0; i < todo.length; i += concurrency) {
    await Promise.all(
      todo.slice(i, i + concurrency).map(async (sig) => {
        const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
        if (!tx || tx.meta?.err) return;
        const found = winsFromLogs(tx.meta?.logMessages ?? [], sig);
        // One settlement per transaction; a season's wins carry the settle time in the event.
        winCache.set(sig, found[0] ?? null);
      }),
    );
  }
  for (const sig of sigs) {
    const w = winCache.get(sig);
    if (w && w.ts >= from && w.ts < to) wins.push(w);
  }
  return wins;
}

export { pointsForWin };
