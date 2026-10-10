import { Connection } from "@solana/web3.js";
import { fetchLeaderboardTerms, fetchPoolTotal, fetchSeasonRecord, fetchSeasonWins } from "@/lib/chain/leaderboard";
import type { LeaderboardView } from "@/lib/chain/leaderboard-view";
import { DEFAULT_BASE_RPC } from "@/lib/chain/rpc-config";
import { seasonAt, seasonEnd, seasonStart, standings } from "@/lib/chain/season";

const TOP = 50;
const FRESH_MS = 30_000;
const STALE_MS = 10 * 60_000;

let conn: Connection | null = null;
const connection = () => (conn ??= new Connection(process.env.TESORO_BASE_RPC || DEFAULT_BASE_RPC, { commitment: "confirmed" }));

/** Builds the page's data from chain. Standings are the season's `MatchWon` events (see lib/chain/leaderboard.ts). */
export async function buildLeaderboard(c: Connection, nowSecs: number): Promise<LeaderboardView> {
  const number = Math.max(1, seasonAt(nowSecs));
  const terms = await fetchLeaderboardTerms(c, true);
  const [pool, wins, record] = await Promise.all([
    terms.recipient ? fetchPoolTotal(c) : Promise.resolve(0n),
    terms.recipient ? fetchSeasonWins(c, number) : Promise.resolve([]),
    number > 1 ? fetchSeasonRecord(c, number - 1) : Promise.resolve(null),
  ]);
  const table = standings(wins);
  return {
    now: nowSecs,
    season: { number, start: seasonStart(number), end: seasonEnd(number) },
    poolGemas: Number(pool),
    feeBps: terms.bps,
    standings: table.slice(0, TOP).map((s) => ({ rank: s.rank, account: s.account, points: s.points, wins: s.wins })),
    players: table.length,
    last: record
      ? {
          number: record.number,
          poolGemas: Number(record.poolTotal),
          winners: record.winners.map((account, i) => ({ rank: i + 1, account, points: record.points[i], gemas: Number(record.amounts[i]), paid: !!(record.paidMask & (1 << i)) })),
        }
      : null,
    settling: number > 1 && !record && terms.recipient ? number - 1 : null,
  };
}

let cache: { at: number; view: LeaderboardView } | null = null;
let inflight: Promise<void> | null = null;

/** Cached 30 s, stale for 10 min after an RPC failure; one upstream build at a time. */
export async function getLeaderboard(): Promise<LeaderboardView> {
  const age = cache ? Date.now() - cache.at : Infinity;
  if (cache && age < FRESH_MS) return cache.view;
  inflight ??= buildLeaderboard(connection(), Math.floor(Date.now() / 1000))
    .then((view) => void (cache = { at: Date.now(), view }))
    .finally(() => void (inflight = null));
  try {
    await inflight;
  } catch (e) {
    if (cache && age < STALE_MS) return cache.view;
    throw e;
  }
  return cache!.view;
}

