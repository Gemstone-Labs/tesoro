import { Connection } from "@solana/web3.js";
import { fetchLeaderboardTerms, fetchPoolTotal, fetchSeasonRecord } from "@/lib/chain/leaderboard";
import { configuredRpc, seasonWinsOf } from "./history/season-wins";
import type { LeaderboardRow, LeaderboardView } from "@/lib/chain/leaderboard-view";
import { baseRpc } from "@/lib/chain/rpc-config";
import { seasonAt, seasonEnd, payoutOpensAt, seasonStart, standings } from "@/lib/chain/season";

const TOP = 50;
const FRESH_MS = 30_000;
const STALE_MS = 10 * 60_000;

let conn: Connection | null = null;
const connection = () => (conn ??= new Connection(baseRpc(process.env.TESORO_BASE_RPC), { commitment: "confirmed" }));

interface Built {
  view: LeaderboardView;
  /** Every ranked Account, for `?me=` below the top the view lists. */
  rows: Map<string, LeaderboardRow>;
}

async function build(c: Connection, nowSecs: number): Promise<Built> {
  const number = Math.max(1, seasonAt(nowSecs));
  const terms = await fetchLeaderboardTerms(c, true);
  const [pool, wins, record] = await Promise.all([
    terms.recipient ? fetchPoolTotal(c) : Promise.resolve(0n),
    terms.recipient ? configuredRpc().then((rpc) => seasonWinsOf(c, number, rpc)) : Promise.resolve([]),
    number > 1 ? fetchSeasonRecord(c, number - 1) : Promise.resolve(null),
  ]);
  const table = standings(wins).map((s) => ({ rank: s.rank, account: s.account, points: s.points, wins: s.wins }));
  const view: LeaderboardView = {
    now: nowSecs,
    season: { number, start: seasonStart(number), end: seasonEnd(number) },
    poolGemas: Number(pool),
    feeBps: terms.bps,
    standings: table.slice(0, TOP),
    players: table.length,
    last: record
      ? {
          number: record.number,
          poolGemas: Number(record.poolTotal),
          winners: record.winners.map((account, i) => ({ rank: i + 1, account, points: record.points[i], gemas: Number(record.amounts[i]), paid: !!(record.paidMask & (1 << i)), voided: !!(record.voidedMask & (1 << i)) })),
          payoutAt: record.recordedAt === null ? null : payoutOpensAt(record.recordedAt),
        }
      : null,
    settling: number > 1 && !record && terms.recipient ? number - 1 : null,
  };
  return { view, rows: new Map(table.map((r) => [r.account, r])) };
}

let cache: (Built & { at: number }) | null = null;
let inflight: Promise<void> | null = null;

/** Cached 30 s, stale for 10 min after an RPC failure; one upstream build at a time. With `me`, adds that Account's row. */
export async function getLeaderboard(me?: string | null): Promise<LeaderboardView> {
  const built = await cached();
  return me ? { ...built.view, me: built.rows.get(me) ?? null } : built.view;
}

async function cached(): Promise<Built> {
  const age = cache ? Date.now() - cache.at : Infinity;
  if (cache && age < FRESH_MS) return cache;
  inflight ??= build(connection(), Math.floor(Date.now() / 1000))
    .then((built) => void (cache = { ...built, at: Date.now() }))
    .finally(() => void (inflight = null));
  try {
    await inflight;
  } catch (e) {
    if (cache && age < STALE_MS) return cache;
    throw e;
  }
  return cache!;
}

