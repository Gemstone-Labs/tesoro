import { PublicKey } from "@solana/web3.js";
import { BLOCK_PUZZLE_PROGRAM_ID } from "../../app/src/games/block-puzzle/chain.ts";
import { TRADING_DUEL_PROGRAM_ID } from "../../app/src/games/trading-duel/chain.ts";
import { HOLDEM_PROGRAM_ID } from "../../app/src/games/holdem/chain.ts";
import { holdem } from "./holdem.ts";
import { shortKey } from "./env.ts";
import { log, type Ctx } from "./act.ts";
import { blockBurst } from "./burst.ts";
import { tradingDuel } from "./duel.ts";
import { vanguard } from "./vanguard.ts";
import { VANGUARD_PROGRAM_ID } from "../../app/src/games/vanguard/chain.ts";
import { pk } from "./runtime.ts";
import { matchLabel } from "./kit.ts";
import { settleMatches, viewOf, type MatchView } from "./settle.ts";


/** Job 1: Match hygiene for every open or active Match in tesoro_core. Returns the number of actions taken. */
export async function matchHygiene(ctx: Ctx): Promise<number> {
  const all: any[] = await ctx.core.account.matchState.all();
  let actions = 0;
  let live = 0;
  const running: MatchView[] = [];
  for (const { publicKey, account } of all) {
    const view = viewOf(publicKey, account);
    // A started run (settle or refund) is the same for every Game: chunks, then close_match.
    if (view.stage === "settling" || view.stage === "refunding" || view.stage === "closed") {
      running.push(view);
      continue;
    }
    live++;
    const st = view.stage;
    // Every Game addresses its tables by the Match's own address.
    const id = publicKey;
    const game = pk(account.inner.game);
    const subject = `match=${matchLabel(view.ref)}`;
    try {
      if (game.equals(BLOCK_PUZZLE_PROGRAM_ID)) actions += await blockBurst(ctx, id, account.inner, st, subject);
      else if (game.equals(HOLDEM_PROGRAM_ID)) actions += await holdem(ctx, id, account.inner, st, subject);
      else if (game.equals(TRADING_DUEL_PROGRAM_ID)) actions += await tradingDuel(ctx, id, account.inner, st, subject);
      else if (game.equals(VANGUARD_PROGRAM_ID)) actions += await vanguard(ctx, id, account.inner, st, subject);
      else log("match", subject, `SKIP unknown game ${shortKey(game)}`);
    } catch (e) {
      log("match", subject, `ERROR ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`);
    }
  }
  actions += await settleMatches(ctx, running);
  log("match", "-", `scanned ${all.length} Matches, ${live} not started, ${running.length} running, ${actions} action(s)`);
  return actions;
}
