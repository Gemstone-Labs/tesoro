import { Connection } from "@solana/web3.js";
import { PAYOUT_WINDOW_SECS, seasonAt, seasonStart } from "../../app/src/lib/chain/season.ts";
import { log, type Ctx } from "./act.ts";
import { batchesJob } from "./batches.ts";
import { makeScanRpc, scanProgramAccounts } from "./credits.ts";
import { harvestJob } from "./counters.ts";
import { CORE_ID } from "./kit.ts";
import { failuresSince, failureMark } from "./errors.ts";
import { discriminatorOf } from "./lists.ts";
import { poolJob } from "./pools.ts";
import { solanaFetch } from "./runtime.ts";
import { realSeasonDeps, seasonPass, type SeasonDeps } from "./season.ts";
import { settleMatches, viewOf, type MatchView } from "./settle.ts";
import { treasuryJob } from "./treasury.ts";
import anchor from "@coral-xyz/anchor";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The steps of the weekly Season run, in order. `record` ends Monday's work; `pay` is Wednesday's. */
export const STEP_ORDER = ["settle", "redeem", "harvest", "batches", "pools", "record", "pay"] as const;
export type StepName = (typeof STEP_ORDER)[number];

/** What one pass of a step did. `pending`: it did something that a further pass may follow up, or failed and should be retried. */
export interface StepResult {
  actions: number;
  pending: boolean;
  /** Sources whose action failed this pass and were left for the next Season's run. */
  skipped?: string[];
}

export type Steps = Record<StepName, () => Promise<StepResult>>;

/** What survives between runs (the hourly retries are separate processes). */
export interface RunState {
  /** The Season whose week this is; a new Season starts the steps over. */
  season: number;
  /** Steps finished this week. */
  done: StepName[];
  /** Seasons found to have no wins: never read again. */
  empty: number[];
}

export interface StateStore {
  load(): RunState | null;
  save(state: RunState): void;
}

export const memoryStore = (initial: RunState | null = null): StateStore => {
  let state = initial;
  return { load: () => state, save: (s) => void (state = s) };
};

const MONDAY_AFTER_SECS = Number(process.env.KEEPER_SEASON_RUN_START_SECS ?? 15 * 60);
const PAY_AFTER_SECS = Number(process.env.KEEPER_SEASON_RUN_PAY_SECS ?? PAYOUT_WINDOW_SECS + 30 * 60);
/** Passes of one step in one run before it is left for the next retry. */
const MAX_PASSES = Number(process.env.KEEPER_SEASON_RUN_PASSES ?? 5);

/** The steps due at `nowSecs`: Monday's from 00:15 UTC of the Season's first day, `pay` once the 48 h window has passed (Wednesday 00:30). */
export function stepsDue(nowSecs: number): StepName[] {
  const season = seasonAt(nowSecs);
  if (season < 1) return [];
  const start = seasonStart(season);
  if (nowSecs < start + MONDAY_AFTER_SECS) return [];
  return nowSecs < start + PAY_AFTER_SECS ? STEP_ORDER.filter((s) => s !== "pay") : [...STEP_ORDER];
}

/**
 * Holds a step to "0 errors". A failure that belongs to no Source throws, so the run stops there and resumes at that step.
 * When every failure names a Source, one bad Source cannot hold up the payout: the step finishes with those Sources
 * in `skipped`. A skipped Source keeps its counters (nothing moved), so the next week's run harvests them into the next
 * Season's prize; the frozen budget of this Season is unaffected.
 */
export function failOnErrors(steps: Steps): Steps {
  const wrap = (run: () => Promise<StepResult>) => async (): Promise<StepResult> => {
    const mark = failureMark();
    const r = await run();
    const failed = failuresSince(mark);
    if (failed.some((f) => !f.source)) throw new Error(`${failed.length} action(s) failed`);
    return failed.length ? { ...r, skipped: [...new Set(failed.map((f) => f.source!))] } : r;
  };
  return Object.fromEntries(STEP_ORDER.map((n) => [n, wrap(steps[n])])) as Steps;
}

export interface RunReport {
  season: number;
  /** Steps that finished in this run. */
  finished: StepName[];
  /** Steps finished in this or an earlier run this week. */
  done: StepName[];
  /** Sources a step skipped because their action failed: to alert on, they roll into the next Season. */
  skipped: { step: StepName; source: string }[];
  /** The step that stopped the run (failed or still had work after its passes); null when everything due is done. */
  stoppedAt: StepName | null;
}

/**
 * The weekly Season run. Walks the due steps in order, skipping those already done this week; a step repeats until a pass
 * leaves nothing pending. A step that throws or stays pending stops the run (later steps need it), and the next hourly
 * run resumes from that step. State is saved after every step.
 */
export async function seasonRun(nowSecs: number, steps: Steps, store: StateStore, maxPasses = MAX_PASSES): Promise<RunReport> {
  const season = seasonAt(nowSecs);
  const saved = store.load();
  const state: RunState = { season, done: saved && saved.season === season ? [...saved.done] : [], empty: saved?.empty ?? [] };
  const report: RunReport = { season, finished: [], done: state.done, stoppedAt: null, skipped: [] };
  /** Saves, keeping the empty Seasons a step recorded meanwhile. */
  const save = () => {
    state.empty = [...new Set([...state.empty, ...(store.load()?.empty ?? [])])];
    store.save(state);
  };
  for (const name of stepsDue(nowSecs)) {
    if (state.done.includes(name)) continue;
    let finished = false;
    try {
      for (let pass = 1; pass <= maxPasses && !finished; pass++) {
        const r = await steps[name]();
        finished = !r.pending;
        for (const source of r.skipped ?? []) {
          if (!report.skipped.some((x) => x.step === name && x.source === source)) report.skipped.push({ step: name, source });
          log("season-run", name, `ALERT source=${source} skipped: its action failed; its share rolls into the next Season`);
        }
        log("season-run", name, `pass ${pass}: ${r.actions} action(s)${finished ? ", done" : ", more to do"}`);
      }
    } catch (e) {
      log("season-run", name, `ERROR ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`);
    }
    if (!finished) {
      report.stoppedAt = name;
      break;
    }
    state.done.push(name);
    report.finished.push(name);
    save();
  }
  report.done = state.done;
  save();
  return report;
}

// ---- The real steps -------------------------------------------------------------------------------------------------

/** Settling Matches, found with a paginated scan (getProgramAccountsV2 on Helius) of MatchState accounts. */
export async function settlingViews(ctx: Ctx): Promise<MatchView[]> {
  const gpa = new Connection(ctx.settings.gpaRpc, { commitment: "confirmed", fetch: solanaFetch, disableRetryOnRateLimit: true });
  const rpc = makeScanRpc(ctx.settings.gpaRpc, solanaFetch, (p, c) => gpa.getProgramAccounts(p, c as any) as any);
  const rows = await scanProgramAccounts(rpc, CORE_ID, { filters: [{ memcmp: { offset: 0, bytes: anchor.utils.bytes.bs58.encode(discriminatorOf("MatchState")) } }] });
  return rows.map((r) => viewOf(r.pubkey, ctx.core.coder.accounts.decode("matchState", r.account.data))).filter((v) => v.stage === "settling");
}

const counted = (actions: number): StepResult => ({ actions, pending: actions > 0 });

/** The steps over the real chain. Seasons found empty go into `store`, so no later run reads them again. */
export function realSteps(ctx: Ctx, store: StateStore, d: SeasonDeps = realSeasonDeps(ctx)): Steps {
  const pass = async (pay: boolean): Promise<StepResult> => {
    const r = await seasonPass(ctx, d, { lookback: Infinity, pay, skip: new Set(store.load()?.empty ?? []) });
    if (r.empty.length) {
      const cur = store.load() ?? { season: 0, done: [], empty: [] };
      store.save({ ...cur, empty: [...new Set([...cur.empty, ...r.empty])] });
    }
    return { actions: r.actions, pending: r.pending.length > 0 };
  };
  return failOnErrors({
    settle: async () => counted(await settleMatches(ctx, await settlingViews(ctx))),
    redeem: async () => counted(await treasuryJob(ctx)),
    harvest: async () => counted(await harvestJob(ctx)),
    batches: async () => counted(await batchesJob(ctx)),
    pools: async () => counted(await poolJob(ctx)),
    record: () => pass(false),
    pay: () => pass(true),
  });
}

/** A RunState kept in a JSON file; a missing or unreadable file is no state. */
export function fileStore(path: string): StateStore {
  return {
    load() {
      try {
        return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as RunState) : null;
      } catch {
        return null;
      }
    },
    save(state) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(state));
    },
  };
}
