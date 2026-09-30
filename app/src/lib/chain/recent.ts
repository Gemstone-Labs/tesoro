import "./polyfill";
import { PublicKey } from "@solana/web3.js";
import { BlockPuzzleChain } from "@/games/block-puzzle/chain";
import type { GameId } from "@/lib/mock/types";
import { getChain } from "./client";
import { feeGemas } from "./ledger";
import { gameOf } from "./read";

/** A settled Match anyone may see: the Lobby ticker. Winners are shown by short key (no names on chain). */
export interface SettledMatch {
  id: bigint;
  game: GameId;
  entry: number;
  /** TesoroAccount key of the winning Player. */
  winner: string;
  /** Gemas the winning side received: the Pot minus Fees. */
  payout: number;
  /** Block Puzzle only: [winner score, loser score]. */
  scores: [number, number] | null;
  /** Milliseconds since the epoch (Match ids embed their creation time). */
  at: number;
}

const pk = (bytes: number[] | Uint8Array) => new PublicKey(Uint8Array.from(bytes));
const big = (n: { toString(): string }) => BigInt(n.toString());
const enumKey = (o: object) => Object.keys(o)[0];

async function decodeAll(keys: PublicKey[], decode: (data: Buffer) => any): Promise<any[]> {
  if (keys.length === 0) return [];
  const infos = await getChain().base.getMultipleAccountsInfo(keys);
  return infos.map((info) => {
    try {
      return info ? decode(info.data) : null;
    } catch {
      return null;
    }
  });
}

/** The newest `limit` settled Matches with a winner (draws and refunds are skipped), newest first. */
export async function fetchRecentSettled(limit = 8): Promise<SettledMatch[]> {
  const chain = getChain();
  const rows: any[] = await chain.core.account.matchState.all();
  const settled = rows
    .filter((m) => enumKey(m.account.inner.status) === "settled" && gameOf(pk(m.account.inner.game)) !== null && m.account.inner.b)
    .sort((x, y) => (big(x.account.id) < big(y.account.id) ? 1 : -1))
    .slice(0, limit * 2);

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
      payout: entry * 2 - Number(feeGemas(BigInt(entry), inner.fees.platformBps, inner.fees.studioBps)),
      scores,
      at: Number(id >> 1n),
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
  return out.sort((x, y) => (x.id < y.id ? 1 : -1)).slice(0, limit);
}
