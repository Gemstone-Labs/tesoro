import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { gameOfProgram } from "../../app/src/lib/chain/games.ts";
import { ingestMatchRecords, type MatchDetail } from "../../app/src/server/history/ingest.ts";
import type { MatchRunStartedRecord } from "../../app/src/server/history/events.ts";
import type { Rpc } from "../../app/src/server/history/rpc.ts";
import { log, type Ctx } from "./act.ts";
import { collectSignatures, pooled, transactionRecords, type ScanConn, type TxRecords } from "./events-scan.ts";
import { notePair } from "./sweeps.ts";

// ---- Where the scan stands -----------------------------------------------------------------------------------------

/** The newest signature whose records, and those of every older one, are handled. */
export interface Cursor {
  load(): string | null;
  save(signature: string): void;
}

export const memoryCursor = (initial: string | null = null): Cursor => {
  let v = initial;
  return { load: () => v, save: (s) => void (v = s) };
};

export const stateDir = (env: NodeJS.ProcessEnv = process.env) => env.KEEPER_STATE_DIR ?? join(homedir(), ".cache/tesoro-keeper");

export function fileCursor(path: string): Cursor {
  return {
    load() {
      try {
        return existsSync(path) ? ((JSON.parse(readFileSync(path, "utf8")) as { cursor?: string }).cursor ?? null) : null;
      } catch {
        return null;
      }
    },
    save(signature) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ cursor: signature }));
    },
  };
}

// ---- Sinks: who gets the records -----------------------------------------------------------------------------------

/** Takes the records of one transaction. A throwing sink stops the scan at that transaction. */
export type Sink = (tx: TxRecords) => Promise<void>;

/** The Postgres functions of migration 0010 over Supabase's REST API with the service role. */
export const restRpc = (url: string, serviceKey: string, fetchFn: typeof fetch = fetch): Rpc => async (fn, args) => {
  const res = await fetchFn(`${url.replace(/\/$/, "")}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`Match history ${fn} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
};

/** The history Rpc named by the environment, or null when no database is configured. */
export function historyRpc(env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): Rpc | null {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? restRpc(url, key, fetchFn) : null;
}

/** Writes the Match records to the history tables. `detail` supplies what core's records do not carry (Block Burst scores). */
export const databaseSink = (rpc: Rpc, detail?: (matchKey: string) => MatchDetail | undefined): Sink => async (tx) => {
  if (!tx.records.length) return;
  await ingestMatchRecords(rpc, tx.records, { signature: tx.signature, slot: tx.slot, blockTime: tx.blockTime ?? undefined, finalized: tx.finalized, gameOf: (p) => gameOfProgram(new PublicKey(p)), detail });
};

/** Run starts the notify job has yet to announce, newest last. Capped: a long outage must not hold memory. */
export const startedRuns: { start: MatchRunStartedRecord; blockTime: number | null }[] = [];
const QUEUE_CAP = 500;

/** Remembers the run starts of a transaction for the notify job (and the pairs the sweep job may close). Never throws, so the e-mail side cannot hold the scan. */
export const notifySink: Sink = async (tx) => {
  for (const r of tx.records) {
    if (r.type !== "start") continue;
    startedRuns.push({ start: r, blockTime: tx.blockTime });
    if (r.bPlayer) notePair(r.aPlayer, r.bPlayer);
  }
  while (startedRuns.length > QUEUE_CAP) startedRuns.shift();
};

// ---- The scan ------------------------------------------------------------------------------------------------------

export interface HistoryDeps {
  conn: ScanConn;
  cursor: Cursor;
  /** Run in order, for every transaction; the first that throws stops the scan there. */
  sinks: Sink[];
  /** Transactions handled in one pass; the rest wait for the next. */
  perPass: number;
  /** Signature pages read on the very first run, with no cursor (the backfill script reads them all). */
  firstRunPages: number;
  fetchConcurrency: number;
  /** Warn after this many unreadable passes; the cursor still waits for complete history. */
  skipAfter: number;
}

const unreadable = new Map<string, number>();

/**
 * One pass of the Match history writer: the transactions that emitted core events since the cursor, oldest first,
 * each handed to every sink in turn. The cursor moves only past transactions every sink took, so a crash, a database
 * outage or a restart repeats work (the sinks are idempotent) and never skips any.
 */
export async function scanHistory(deps: HistoryDeps): Promise<{ handled: number; stoppedAt: string | null }> {
  const cursor = deps.cursor.load();
  const newestFirst = await collectSignatures(deps.conn, { until: cursor ?? undefined, maxPages: cursor ? 200 : deps.firstRunPages });
  if (!newestFirst.length) return { handled: 0, stoppedAt: null };
  const todo = newestFirst.slice(-deps.perPass).reverse();
  const fetched = await pooled(todo, deps.fetchConcurrency, (s) => transactionRecords(deps.conn, s).catch(() => null));
  let handled = 0;
  for (let i = 0; i < todo.length; i++) {
    const sig = todo[i].signature;
    const tx = fetched[i];
    if (!tx) {
      const tries = (unreadable.get(sig) ?? 0) + 1;
      unreadable.set(sig, tries);
      if (tries >= deps.skipAfter) log("history", sig.slice(0, 8), `WARN transaction unreadable after ${tries} passes; cursor retained`);
      return { handled, stoppedAt: sig };
    } else {
      try {
        for (const sink of deps.sinks) await sink(tx);
      } catch (e) {
        log("history", sig.slice(0, 8), `FAIL ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}; the scan resumes here`);
        return { handled, stoppedAt: sig };
      }
    }
    deps.cursor.save(sig);
    unreadable.delete(sig);
    handled++;
  }
  return { handled, stoppedAt: null };
}

export function realHistoryDeps(ctx: Ctx, env: NodeJS.ProcessEnv = process.env, detail?: (matchKey: string) => MatchDetail | undefined): HistoryDeps {
  const rpc = historyRpc(env);
  return {
    conn: ctx.conn,
    cursor: fileCursor(join(stateDir(env), "history-cursor.json")),
    sinks: [...(rpc ? [databaseSink(rpc, detail)] : []), notifySink],
    perPass: Number(env.KEEPER_HISTORY_PER_PASS ?? 200),
    firstRunPages: Number(env.KEEPER_HISTORY_FIRST_PAGES ?? 3),
    fetchConcurrency: 6,
    skipAfter: Number(env.KEEPER_HISTORY_SKIP_AFTER ?? 5),
  };
}

/** Job: the Match history writer (the tables behind History, Match pages, win cards and the Lobby ticker). */
export async function historyJob(ctx: Ctx, deps: HistoryDeps = realHistoryDeps(ctx)): Promise<number> {
  if (ctx.settings.dryRun) {
    log("history", "-", "DRY-RUN would scan for new Match records");
    return 0;
  }
  if (deps.sinks.length === 1) log("history", "-", "no database configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY): records go to notifications only");
  const r = await scanHistory(deps);
  if (r.handled || r.stoppedAt) log("history", "-", `${r.handled} transaction(s) handled${r.stoppedAt ? `, stopped at ${r.stoppedAt.slice(0, 8)}` : ""}`);
  return r.handled;
}
