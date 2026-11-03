import { log, type Ctx } from "./act.ts";
import { historyRpc, webhookHistoryOn } from "./history.ts";
import { eventAuthority } from "./kit.ts";
import { catchUp, decodePending, jsonRpcCoreChain, rpcWebhookStore } from "../../app/src/server/history/webhook.ts";

/**
 * Match history from the Helius webhook (app route /api/webhooks/helius): the route stores and decodes what Helius delivers;
 * this job repairs what it dropped. With KEEPER_WEBHOOK_HISTORY=1 the keeper's own history scan stops writing the history tables.
 */
export const CATCH_UP_EVERY_MS = 15 * 60_000;

let lastRun = 0;
export const _resetCatchUpClock = () => void (lastRun = 0);

export interface CatchUpJobDeps {
  run: () => Promise<{ stored: number; finalized: number; decoded: number; failed: number }>;
  now: () => number;
}

/** The catch-up job: runs on the first pass after boot, then every 15 minutes. Returns how many transactions it stored. */
export async function webhookCatchUpJob(ctx: Ctx, deps: CatchUpJobDeps = realCatchUpDeps(ctx)): Promise<number> {
  if (!webhookHistoryOn()) return 0;
  if (deps.now() - lastRun < CATCH_UP_EVERY_MS) return 0;
  if (ctx.settings.dryRun) {
    log("webhook", "-", "DRY-RUN would catch up on Match history");
    return 0;
  }
  const r = await deps.run();
  lastRun = deps.now();
  log("webhook", "-", `catch-up stored ${r.stored}, finalized ${r.finalized}, decoded ${r.decoded}${r.failed ? `, ${r.failed} undecodable` : ""}`);
  return r.stored;
}

function realCatchUpDeps(ctx: Ctx, env: NodeJS.ProcessEnv = process.env): CatchUpJobDeps {
  return {
    now: () => Date.now(),
    run: async () => {
      const rpc = historyRpc(env);
      if (!rpc) throw new Error("webhook history needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
      const store = rpcWebhookStore(rpc);
      const c = await catchUp({ store, chain: jsonRpcCoreChain(ctx.settings.rpc, eventAuthority.toBase58()), firstPages: Number(env.KEEPER_HISTORY_FIRST_PAGES ?? 1) });
      const d = await decodePending({ store, rpc, warn: (m) => log("webhook", "-", `WARN ${m}`) });
      return { stored: c.stored, finalized: c.finalized, decoded: d.decoded, failed: d.failed };
    },
  };
}
