import { PublicKey } from "@solana/web3.js";
import type { GameId } from "../../app/src/lib/mock/types.ts";
import { gameOfProgram } from "../../app/src/lib/chain/games.ts";
import type { MatchRunStartedRecord } from "../../app/src/server/history/events.ts";
import { partiesOf } from "../../app/src/server/history/ingest.ts";
import { matchKeyOf } from "../../app/src/server/history/match-key.ts";
import { log, type Ctx } from "./act.ts";
import { startedRuns } from "./history.ts";

export type { GameId };

/** What the app's /api/notify/event route takes (app/src/server/notify/routes.ts `SettledPush`). */
export interface SettledPush {
  matchId: string;
  game: GameId;
  entry: number;
  participants: { authority: string; result: "won" | "lost" | "draw"; gemas: number }[];
}

/**
 * Each Player's result and Gemas won or lost after Fees, from the run-start record core emitted when the Match settled.
 * `partiesOf` (the history rules) gives the Gema change of every side; a backed Player never loses Gemas. Refunds and
 * no-shows are not "settled" Matches (the Delayed and refunded events speak for those).
 */
export function settledPush(start: MatchRunStartedRecord, game: GameId, authorityOf: (account: string) => string | undefined): SettledPush | null {
  if (start.kind !== 0 && start.kind !== 2) return null;
  const participants = partiesOf(start)
    .filter((p) => p.role === "player" && p.result !== "refunded")
    .flatMap((p) => {
      const authority = authorityOf(p.account);
      return authority ? [{ authority, result: p.result as "won" | "lost" | "draw", gemas: Math.abs(p.delta) }] : [];
    });
  return participants.length ? { matchId: matchKeyOf(start), game, entry: start.entry, participants } : null;
}

/**
 * What the app server did with a push: took it (2xx), refused it as malformed (400: e.g. a Game that app does not
 * list yet, so asking again cannot help), or failed (down, 5xx, bad secret: the next pass tries again).
 */
export type PushResult = "sent" | "rejected" | "failed";

/** POSTs `body` with the shared secret. Never throws. */
export async function postToApp(url: string, secret: string, body: unknown, fetchFn: typeof fetch = fetch): Promise<PushResult> {
  try {
    const res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify(body) });
    return res.ok ? "sent" : res.status === 400 ? "rejected" : "failed";
  } catch {
    return "failed";
  }
}

export const pushSettled = (url: string, secret: string, push: SettledPush, fetchFn: typeof fetch = fetch) => postToApp(url, secret, push, fetchFn);

/** Matches settled longer ago than this are not announced (a restart does not replay old history). */
const WINDOW_SECS = 3 * 24 * 3600;
const PER_PASS = 15;
const pushed = new Set<string>();

/** The Game a tesoro_core Match's program id belongs to; null for a program the app does not play. */
export const gameOfKey = gameOfProgram;

/**
 * Job: tells the app server about Matches that settled, so it can email the Players. It reads the run starts the history
 * scan saw (`startedRuns`), so it needs no Match account (a settled Match is closed away). The server holds the once-only
 * record (per Match and Player); `pushed` just stops this process asking again.
 */
export async function notifyJob(ctx: Ctx, env: NodeJS.ProcessEnv = process.env, queue = startedRuns, fetchFn: typeof fetch = fetch): Promise<number> {
  const url = env.NOTIFY_URL;
  const secret = env.NOTIFY_SECRET;
  if (!url || !secret) return 0;
  const authorities = new Map<string, string>();
  let sent = 0;
  let looked = 0;
  for (const entry of [...queue]) {
    const { start, blockTime } = entry;
    const id = matchKeyOf(start);
    const drop = () => void queue.splice(queue.indexOf(entry), 1);
    if (pushed.has(id) || (blockTime !== null && ctx.now - blockTime > WINDOW_SECS)) {
      drop();
      continue;
    }
    const game = gameOfKey(new PublicKey(start.game));
    if (!game || (start.kind !== 0 && start.kind !== 2)) {
      drop();
      continue;
    }
    if (looked++ >= PER_PASS) break;
    try {
      for (const account of [start.aPlayer, start.bPlayer]) {
        if (account && !authorities.has(account)) authorities.set(account, (await ctx.core.account.tesoroAccount.fetch(new PublicKey(account))).authority.toBase58());
      }
      const push = settledPush(start, game, (a) => authorities.get(a));
      if (!push) {
        drop();
        continue;
      }
      const res = await pushSettled(url, secret, push, fetchFn);
      if (res === "sent") {
        pushed.add(id);
        drop();
        sent++;
        log("notify", `match=${id}`, "DONE settled Match sent to the app");
      } else if (res === "rejected") {
        pushed.add(id);
        drop();
        log("notify", `match=${id}`, `SKIP the app does not take ${game} events`);
      } else log("notify", `match=${id}`, "FAIL the app did not take the event, will retry");
    } catch (e) {
      log("notify", `match=${id}`, `ERROR ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`);
    }
  }
  return sent;
}
