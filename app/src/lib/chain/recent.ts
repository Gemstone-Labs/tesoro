import "./polyfill";
import { PublicKey } from "@solana/web3.js";
import { BlockPuzzleChain } from "@/games/block-puzzle/chain";
import { getChain } from "./client";
import { feeGemas } from "./ledger";
import { matchOpenedAt } from "./match-id";
import { fetchLeaderboardTerms } from "./leaderboard";
import { leaderboardBpsFor } from "./season";
import { decodeAll, gameOf } from "./read";
import { pickSettled, topScores, type SettledMatch, type SettledQuery } from "./settled";

export type { SettledMatch } from "./settled";

const pk = (bytes: number[] | Uint8Array) => new PublicKey(Uint8Array.from(bytes));
const big = (n: { toString(): string }) => BigInt(n.toString());
const enumKey = (o: object) => Object.keys(o)[0];

const SCAN_TTL_MS = 20_000;
let scan: { at: number; rows: Promise<any[]> } | null = null;

/** Every tesoro_core Match. One list request serves every caller within SCAN_TTL_MS; a failure is not cached. */
function allMatches(): Promise<any[]> {
  if (scan && Date.now() - scan.at < SCAN_TTL_MS) return scan.rows;
  const rows: Promise<any[]> = getChain().core.account.matchState.all();
  const entry = { at: Date.now(), rows };
  scan = entry;
  rows.catch(() => {
    if (scan === entry) scan = null;
  });
  return rows;
}

/** Settled Matches with a winner (draws and refunds are skipped), newest first. */
export async function fetchSettled(q: SettledQuery): Promise<SettledMatch[]> {
  const chain = getChain();
  await fetchLeaderboardTerms(chain.core.provider.connection).catch(() => undefined);
  const rows = await allMatches();
  // Draws are only known once the Session is read: take some slack so `limit` winners usually remain.
  const settled = pickSettled(
    rows.map((m) => ({
      row: m,
      id: big(m.account.id),
      game: gameOf(pk(m.account.inner.game)),
      settled: enumKey(m.account.inner.status) === "settled",
      joined: !!m.account.inner.b,
    })),
    { ...q, limit: q.limit * 2 },
  ).map((c) => c.row);

  const bp = settled.filter((m) => gameOf(pk(m.account.inner.game)) === "block-puzzle");
  const hd = settled.filter((m) => gameOf(pk(m.account.inner.game)) === "holdem");
  const sessions = await decodeAll(
    bp.map((m) => BlockPuzzleChain.addresses(big(m.account.id)).session),
    (data) => chain.bp.coder.accounts.decode("session", data),
  );
  const tables = hd.length
    ? await (async () => {
        const [{ getHoldem }, { addresses }] = await Promise.all([import("./client"), import("@/games/holdem/chain")]);
        const program = getHoldem().program;
        return decodeAll(hd.map((m) => addresses(big(m.account.id)).gameMatch), (data) => program.coder.accounts.decode("gameMatch", data));
      })()
    : [];

  const td = settled.filter((m) => gameOf(pk(m.account.inner.game)) === "trading-duel");
  const duels = td.length
    ? await (async () => {
        const [{ getTradingDuel }, { addresses }] = await Promise.all([import("./client"), import("@/games/trading-duel/chain")]);
        const program = getTradingDuel().program;
        return decodeAll(td.map((m) => addresses(big(m.account.id)).duel), (data) => program.coder.accounts.decode("duel", data));
      })()
    : [];

  const out: SettledMatch[] = [];
  const push = (m: any, winnerSeat: 0 | 1, scores: [number, number] | null) => {
    const inner = m.account.inner;
    const entry = Number(inner.entry.toString());
    const side = winnerSeat === 0 ? inner.a : inner.b;
    if (!side) return;
    const id = big(m.account.id);
    out.push({
      id,
      game: gameOf(pk(inner.game)) ?? "block-puzzle",
      entry,
      winner: pk(side.player).toBase58(),
      payout: entry * 2 - Number(feeGemas(BigInt(entry), inner.fees.platformBps, inner.fees.studioBps, leaderboardBpsFor(matchOpenedAt(id, gameOf(pk(inner.game)))))),
      scores,
      at: matchOpenedAt(id, gameOf(pk(inner.game))),
    });
  };
  bp.forEach((m, i) => {
    const s = sessions[i];
    if (!s?.settled || (s.result !== 0 && s.result !== 1)) return;
    const scores = (s.scores as number[]).map(Number);
    push(m, s.result, s.result === 0 ? [scores[0], scores[1]] : [scores[1], scores[0]]);
  });
  hd.forEach((m, i) => {
    const w = tables[i]?.winner;
    if (w === 0 || w === 1) push(m, w, null);
  });
  td.forEach((m, i) => {
    const w = duels[i]?.winner;
    if (w === 0 || w === 1) push(m, w, null);
  });
  return out.sort((x, y) => (x.id < y.id ? 1 : -1)).slice(0, q.limit);
}

/** The newest `limit` settled Matches with a winner, any game (the Lobby ticker). */
export const fetchRecentSettled = (limit = 8) => fetchSettled({ limit });

/** Most Block Puzzle Matches read for one day's top scores. */
export const TOP_SCAN_LIMIT = 150;

/** The best winning Block Puzzle scores of the last 24 hours. */
export async function fetchTopScoresToday(now = Date.now()): Promise<[string, number][]> {
  return topScores(await fetchSettled({ game: "block-puzzle", since: now - 24 * 60 * 60 * 1000, limit: TOP_SCAN_LIMIT }));
}
