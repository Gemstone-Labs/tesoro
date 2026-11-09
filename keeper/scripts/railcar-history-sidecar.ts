/**
 * Staging-only: writes the Railcar rides' Match history while production's decoder (main) skips Railcar events.
 * Reads finalized transactions of core's and Railcar's event authorities from the chain, decodes them with this branch's
 * decoder and stores only the many-seat pieces through `ingest_match_event` (idempotent). It never touches webhook_tx
 * and never writes a head-to-head Match. Remove it once main decodes Railcar.
 *
 *   pnpm --filter @tesoro/keeper exec tsx scripts/railcar-history-sidecar.ts [--once | --loop <seconds>] \
 *     [--since-hours 24] [--rpc <url>] [--write]
 *
 * A dry run (the default) prints what it would ingest. `--write` needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 * RPC: --rpc, else KEEPER_RPC or TESORO_BASE_RPC, else the public devnet RPC. Only the process env is read.
 */
import { parseArgs } from "../src/cli-args.ts";
import { settings } from "../src/env.ts";
import { historyRpc } from "../src/history.ts";
import { jsonRpcRideChain, railcarHistoryPass } from "../src/railcar-history.ts";

const argv = process.argv.slice(2);
const a = parseArgs(argv, ["once", "write"]);
const s = settings(argv, { ...process.env });
const dryRun = !a.flag("write");
const loopSecs = a.value("loop") ? Number(a.value("loop")) : null;
const sinceHours = Number(a.value("since-hours") ?? 24);
if (loopSecs !== null && !(loopSecs > 0)) throw new Error("--loop takes a number of seconds");
if (!(sinceHours > 0)) throw new Error("--since-hours takes a positive number");
const rpc = historyRpc();
if (!dryRun && !rpc) throw new Error("--write needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");

const chain = jsonRpcRideChain(s.rpc);
const seen = new Set<string>();
const stamp = () => new Date().toISOString().slice(11, 19);
const say = (line: string) => console.log(`${stamp()} ${line}`);

async function pass() {
  const sinceTs = Math.floor(Date.now() / 1000 - sinceHours * 3600);
  const r = await railcarHistoryPass({ chain, rpc, sinceTs, dryRun, seen, log: say });
  say(`${dryRun ? "DRY RUN " : ""}scanned ${r.scanned} new transaction(s) of the last ${sinceHours} h: ${r.matches.length} Railcar Match(es)${r.matches.length ? ` (${r.matches.join(", ")})` : ""}, ${dryRun ? "nothing written" : `${r.added} new piece(s)`}${r.failed.length ? `, ${r.failed.length} to retry` : ""}`);
}

say(`Railcar history sidecar: ${dryRun ? "dry run" : "WRITING"}, rpc ${new URL(s.rpc).host}, ${loopSecs ? `every ${loopSecs} s` : "once"}`);
if (loopSecs === null) await pass();
else {
  for (;;) {
    await pass().catch((e) => say(`pass failed, retrying next round: ${String((e as Error).message ?? e).split("\n")[0]}`));
    await new Promise((r) => setTimeout(r, loopSecs * 1000));
  }
}
