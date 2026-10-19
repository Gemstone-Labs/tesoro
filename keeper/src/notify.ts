import anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import type { GameId } from "../../app/src/lib/mock/types.ts";
import { gameOfProgram } from "../../app/src/lib/chain/games.ts";
import { backedSplit, feeGemas } from "../../app/src/lib/chain/ledger.ts";
import { fetchLeaderboardTerms } from "../../app/src/lib/chain/leaderboard.ts";
import { matchOpenedAt } from "../../app/src/lib/chain/match-id.ts";
import { leaderboardBpsFor } from "../../app/src/lib/chain/season.ts";
import { log, type Ctx } from "./act.ts";
import { pk } from "./runtime.ts";

export type { GameId };

/** What the app's /api/notify/event route takes (app/src/server/notify/routes.ts `SettledPush`). */
export interface SettledPush {
  matchId: string;
  game: GameId;
  entry: number;
  participants: { authority: string; result: "won" | "lost" | "draw"; gemas: number }[];
}

export interface SettledMatch {
  id: bigint;
  game: GameId;
  entry: bigint;
  fees: { platformBps: number; studioBps: number };
  leaderboardBps: number;
  /** MatchSettled.result: 0 the opener won, 1 the joiner won, 2 a draw. */
  result: number;
  /** The Players' wallet authority and whether a Backer funded them, by side (the joiner may be absent). */
  sides: [{ authority: string; backedShareBps: number | null }, { authority: string; backedShareBps: number | null } | null];
}

/** Each Player's result and Gemas won or lost after Fees. A backed Player never loses Gemas. */
export function settledPush(m: SettledMatch): SettledPush {
  const entry = Number(m.entry);
  const participants = m.sides.flatMap((side, i) => {
    if (!side) return [];
    const result = m.result === 2 ? "draw" : (m.result === i ? "won" : "lost");
    let gemas = 0;
    if (result === "won") {
      gemas =
        side.backedShareBps !== null
          ? backedSplit({ entry, ...m.fees, leaderboardBps: m.leaderboardBps, shareBps: side.backedShareBps, won: true }).playerNet
          : entry - Number(feeGemas(m.entry, m.fees.platformBps, m.fees.studioBps, m.leaderboardBps));
    } else if (result === "lost") gemas = side.backedShareBps !== null ? 0 : entry;
    return [{ authority: side.authority, result, gemas }] as SettledPush["participants"];
  });
  return { matchId: m.id.toString(), game: m.game, entry, participants };
}

/** True when the server took the event (2xx). Never throws: the next pass tries again. */
export async function pushSettled(url: string, secret: string, push: SettledPush, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify(push) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Matches settled longer ago than this are not announced (a restart does not replay old history). */
const WINDOW_MS = 3 * 24 * 3_600_000;
const PER_PASS = 15;
const pushed = new Set<string>();

/** The Game a tesoro_core Match's program id belongs to; null for a program the app does not play. */
export const gameOfKey = gameOfProgram;

/** The `result` of a Match's `MatchSettled` event, found in the transactions that touched the Match account. */
async function settledResult(ctx: Ctx, match: PublicKey, id: bigint): Promise<number | null> {
  const parser = new anchor.EventParser(ctx.core.programId, new anchor.BorshCoder(ctx.coreIdl));
  for (const s of await ctx.conn.getSignaturesForAddress(match, { limit: 25 }, "confirmed")) {
    if (s.err) continue;
    const tx = await ctx.conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    for (const ev of parser.parseLogs(tx?.meta?.logMessages ?? [])) {
      const d: any = ev.data;
      if ((ev.name === "MatchSettled" || ev.name === "matchSettled") && (d.matchId ?? d.match_id).toString() === id.toString()) return Number(d.result);
    }
  }
  return null;
}

/**
 * Job: tells the app server about Matches that settled, so it can email the Players. The server holds the
 * once-only record (per Match and Player); `pushed` just stops this process asking again.
 */
export async function notifyJob(ctx: Ctx, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const url = env.NOTIFY_URL;
  const secret = env.NOTIFY_SECRET;
  if (!url || !secret) return 0;
  await fetchLeaderboardTerms(ctx.conn);
  const all: any[] = await ctx.core.account.matchState.all();
  let sent = 0;
  let looked = 0;
  for (const { publicKey, account } of all) {
    if (Object.keys(account.inner.status)[0] !== "settled") continue;
    const id = BigInt(account.id.toString());
    const game = gameOfKey(pk(account.inner.game));
    if (!game || pushed.has(id.toString())) continue;
    const opened = matchOpenedAt(id, game);
    if (Date.now() - opened > WINDOW_MS) continue;
    if (looked++ >= PER_PASS) break;
    try {
      const result = await settledResult(ctx, publicKey, id);
      if (result === null) continue;
      const m = account.inner;
      const authorityOf = async (side: any) => (await ctx.core.account.tesoroAccount.fetch(pk(side.player))).authority.toBase58();
      const sideOf = async (side: any) => ({ authority: await authorityOf(side), backedShareBps: pk(side.funder).equals(pk(side.player)) ? null : Number(side.shareBps) });
      const push = settledPush({
        id,
        game,
        entry: BigInt(m.entry.toString()),
        fees: { platformBps: Number(m.fees.platformBps), studioBps: Number(m.fees.studioBps) },
        leaderboardBps: leaderboardBpsFor(opened),
        result,
        sides: [await sideOf(m.a), m.b ? await sideOf(m.b) : null],
      });
      if (await pushSettled(url, secret, push)) {
        pushed.add(id.toString());
        sent++;
        log("notify", `match=${id}`, "DONE settled Match sent to the app");
      } else log("notify", `match=${id}`, "FAIL the app did not take the event, will retry");
    } catch (e) {
      log("notify", `match=${id}`, `ERROR ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`);
    }
  }
  return sent;
}
