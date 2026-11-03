import { join } from "node:path";
import { Connection } from "@solana/web3.js";
import { Budget, log, type Ctx } from "./act.ts";
import { ADMIN_COMMANDS, ADMIN_FLAGS, assertExpectedCluster, parseAdminArgv, runAdmin, type AdminSteps } from "./admin.ts";
import { fileHistory, weeklyBatchRule } from "./admin-batches.ts";
import { batchJob, realBatchDeps } from "./batches.ts";
import { exitOnUnknownFlag, parseArgs } from "./cli-args.ts";
import { realCounterDeps, cashInJob } from "./counters.ts";
import { meter } from "./credits.ts";
import { loadPayer, settings } from "./env.ts";
import { stateDir } from "./history.ts";
import { fillRuleFrom, orderJob, realOrderDeps } from "./orders.ts";
import { buildRuntime, clusterNow, newConnection, solanaFetch } from "./runtime.ts";
import { gameSettings, newGameState, runGame, schedulerSettings, type GameId } from "./scheduler.ts";
import { ADAPTERS } from "./scheduler-games.ts";
import { treasuryJob } from "./treasury.ts";

/**
 * The by-hand jobs that no loop runs. One command per run; `--dry-run` shows what would be sent and sends and saves nothing.
 * Every command needs `--cluster` (it must match TESORO_CLUSTER) and the key the step signs with (KEEPER_KEYPAIR or
 * KEEPER_SECRET_KEY; for `fill` the Economy's fill_keeper, for the table commands the Games' TableConfig operator).
 */
const USAGE = `Usage: admin-cli <${ADMIN_COMMANDS.join("|")}> --cluster test|mainnet [--dry-run] [--rpc <url>] [--gpa-rpc <url>] [flags]
  tables   make the Sponsor, Fuel and tables of each Game up to the pool size (--game <id> for one, --size <n> to override KEEPER_<G>_TABLE_CAP, --passes <n>)
  fees     cash in the Platform and Studio fee counters of Solana Sources
  fill     redeem the Treasury's repaid lines, then fill open Instant Redeem orders (--max-gemas <n> is required)
  refill   refill each Game's Sponsor from its Fuel when it is under the floor
  batches  seal, send and close Platform and Studio fee batches of EVM Sources; a sent batch goes again only after the vault paid
           more and a day has passed (--history <file> keeps the record, default KEEPER_STATE_DIR/admin-batches.json)
  --dry-run  print what would be done, send and save nothing`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function gamesOf(want: string | undefined) {
  const ids = ADAPTERS.map((a) => a.id);
  if (want && !ids.includes(want as GameId)) throw new Error(`--game ${want}: expected ${ids.join(" | ")}`);
  return ADAPTERS.filter((a) => !want || a.id === want);
}

/** The real step of each command, built from the keeper's own job code. */
export function adminSteps(ctx: Ctx, a: ReturnType<typeof parseArgs>, history: string): AdminSteps {
  const games = gamesOf(a.value("game"));
  const slice = (only: "setup" | "refill", size?: number) => async () => {
    let actions = 0;
    for (const g of games) {
      const base = gameSettings(g.id as GameId, g.env);
      const set = only === "setup" ? { ...base, cap: size ?? base.cap, min: size ?? base.cap, spare: 0 } : base;
      actions += await runGame(ctx, g, set, [], newGameState(), { settings: { ...schedulerSettings(), assign: false }, only });
    }
    return actions;
  };
  const size = a.value("size");
  return {
    tables: slice("setup", size ? Number(size) : undefined),
    refill: slice("refill"),
    fees: () => cashInJob(ctx, realCounterDeps(ctx)),
    redeem: () => treasuryJob(ctx),
    fill: () => orderJob(ctx, { ...realOrderDeps(ctx), rule: { ...fillRuleFrom(), maxGemasPerPass: BigInt(a.value("max-gemas") ?? 0) } }),
    batches: () => batchJob(ctx, realBatchDeps(ctx, realCounterDeps(ctx)), weeklyBatchRule(fileHistory(history))),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  let parsed;
  try {
    parsed = parseAdminArgv(argv);
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    process.exit(2);
  }
  exitOnUnknownFlag(parsed.rest, ADMIN_FLAGS, USAGE);
  const a = parseArgs(parsed.rest, ["dry-run"]);
  assertExpectedCluster(a.value("cluster"));
  const s = settings(parsed.rest);
  const conn = newConnection(s.rpc, s.gpaRpc);
  const payer = await loadPayer(conn, s, (m) => log("wallet", "-", m), new Connection(s.gpaRpc, { fetch: solanaFetch }));
  const ctx: Ctx = { ...buildRuntime(s, conn, payer), budget: new Budget(s.hourlyCapLamports), lz: new Budget(s.lzHourlyCapLamports) };
  ctx.now = await clusterNow(conn);
  ctx.budget.observe(await conn.getBalance(payer.publicKey));
  const history = a.value("history") ?? join(stateDir(), "admin-batches.json");
  const actions = await meter.inJob(`admin-${parsed.command}`, () =>
    runAdmin(parsed.command, { dryRun: s.dryRun, passes: Number(a.value("passes") ?? 30), pause: () => sleep(2000), maxGemas: BigInt(a.value("max-gemas") ?? 0) }, adminSteps(ctx, a, history)),
  );
  log("admin", parsed.command, `${s.dryRun ? "DRY-RUN " : ""}${actions} action(s) in the last pass`);
  for (const line of meter.report()) log("credits", "-", line.replace(/^credits /, ""));
  process.exit(0);
}

main().catch((e) => {
  console.error(String((e as Error).message ?? e));
  process.exit(1);
});
