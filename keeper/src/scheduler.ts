import { PublicKey } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { act, log, type Ctx } from "./act.ts";
import { clearRaised, raise } from "./alerts.ts";
import { resetMayProceed } from "./end-state.ts";
import { matchLabel, matchRefOf } from "./kit.ts";
import { shortKey } from "./env.ts";
import { pk } from "./runtime.ts";
import { settledPda } from "../../app/src/lib/chain/basket.ts";
import { assetOfIndex } from "../../app/src/games/trading-duel/chain.ts";

/**
 * The table scheduler (ticket 19t): one job, one loop, for every Game that plays on persistent tables.
 *
 * It runs on its own clock, whether or not any Match is open. Per Game, per pass, in this order:
 *  1. infrastructure: the operator key, the Sponsor and the configured Fuel exist and are delegated;
 *  2. upkeep of every table: commit, commit retry, wipe or close the seats, capture the end state, reset, free ring slots on
 *     tesoro_core's receipt, give up a table whose Match tesoro_core already refunded (one step per table per pass);
 *  3. assignment: the oldest waiting Matches go to Idle tables;
 *  4. growth: create, delegate and seat tables while Matches wait for one, under the cap;
 *  5. the Sponsor's fuel, and the alerts (stuck table, Sponsor low, cap reached, a Match waiting too long).
 *
 * Everything is read from the chain each pass (nothing but backoff clocks lives in memory), so a restart in the middle of any
 * step repeats it safely. The per-Match hooks (`duel.ts`, `holdem.ts`, `burst.ts`, `vanguard.ts`) drive a Match; the table
 * steps in this file are the only place a table is committed, reset or released. The keeper never checks in or plays for a Player.
 */

export type GameId = "trading-duel" | "holdem" | "block-burst" | "vanguard";

/** Where a table stands on the base layer. */
export type BaseState = "missing" | "program" | "delegated" | "foreign";

export interface RingSlotView {
  state: number;
  tesoroMatch: PublicKey;
  epoch: number;
  at: number;
}

/** What the scheduler needs of a Game's table, whatever the Game's own phases are called. */
export interface TableView {
  index: number;
  epoch: number;
  /** `idle`: no Match, `match`: a Match is on it, `over`: a result is in and the table waits to be reset. */
  coarse: "idle" | "match" | "over";
  /** Games with private seats make them once per table (`init_seats`); the others have nothing to make. */
  seatsCreated: boolean;
  seatsOpen: boolean;
  dirty: boolean;
  overAt: number;
  tesoroMatch: PublicKey;
  ring: RingSlotView[];
  /** The Game's own decoded table. */
  raw: unknown;
}

export type UpkeepDo = "commit_table" | "close_seats" | "wipe_seats" | "reset_table" | "release_slot" | "void_table" | "wait";
export interface UpkeepStep {
  do: UpkeepDo;
  why: string;
  slot?: { index: number; match: string };
}

export interface TableRow {
  index: number;
  base: BaseState;
  view: TableView | null;
}

export type SetupStep =
  | { do: "create_table" | "delegate_table" | "init_seats"; index: number }
  | { do: "create_sponsor" | "delegate_sponsor" }
  | { do: "create_fuel" | "delegate_fuel"; n: number };

/** Lamports the keeper puts into a missing Sponsor / Fuel. */
export interface Init {
  sponsor: bigint;
  fuel: bigint;
}

export interface Ref {
  generation: number;
  index: number;
}

export interface Promised {
  index: number;
  epoch: number;
  startDeadline: number;
}

/** What `assign_match` is given. */
export interface AssignPick {
  generation: number;
  index: number;
  epoch: number;
}

export interface GameAdapter {
  id: GameId;
  /** Short name used in logs and Condition keys. */
  label: string;
  /** `KEEPER_<ENV>_...` names. */
  env: string;
  programId: PublicKey;
  /** The Game keeps private seats that are made once per table with `init_seats`. */
  preSeated: boolean;
  config(ctx: Ctx): Promise<{ generation: number; maxTables: number; operator: PublicKey } | null>;
  tableAddress(generation: number, index: number): PublicKey;
  sponsorAddress(): PublicKey;
  fuelAddress(n: number): PublicKey;
  /** The table in the rollup, or null if it cannot be read. */
  read(ctx: Ctx, ref: Ref): Promise<TableView | null>;
  /** The step for one table, from the rollup view, base's copy and tesoro_core's receipts. */
  step(ctx: Ctx, view: TableView, ref: Ref, lastRecommit: number): Promise<UpkeepStep>;
  commit(ctx: Ctx, ref: Ref): Promise<string>;
  /** `close_seats` or `wipe_seats`, whichever the Game has. */
  seats(ctx: Ctx, ref: Ref): Promise<string>;
  reset(ctx: Ctx, ref: Ref): Promise<string>;
  release(ctx: Ctx, ref: Ref, view: TableView, slot: number, match: PublicKey): Promise<string>;
  void(ctx: Ctx, ref: Ref, view: TableView): Promise<string>;
  /** What the Match history must hold before the table is reset (ticket 33). */
  endState(ctx: Ctx, ref: Ref, view: TableView): Promise<{ tesoroMatch: PublicKey; epoch: number; fn: (t: any) => any; table: any }>;
  /** The Assignment of a Match, or null. */
  assignmentOf(ctx: Ctx, match: PublicKey): Promise<{ generation: number; index: number; epoch: number; startDeadline: number } | null>;
  assign(ctx: Ctx, match: PublicKey, inner: any, pick: AssignPick): Promise<string>;
  /** Base: refunds a joined Match no table was assigned to (the Game's `refund_untabled`). */
  refundUntabled(ctx: Ctx, match: PublicKey): Promise<string>;
  /** Rollup: gives up the Assignment of a Match that never began (the Game's `skip_epoch`). */
  skip(ctx: Ctx, match: PublicKey): Promise<string>;
  /** Setup transactions (base for create and delegate, rollup for init_seats). */
  setup(ctx: Ctx, step: SetupStep, ref: Ref, init: Init): Promise<string>;
  sponsorBalance(ctx: Ctx): Promise<number | null>;
  refill(ctx: Ctx, fuel: number, amount: bigint): Promise<string>;
  /** Matches that have an Assignment account, for cleanup. */
  assignmentMatches(ctx: Ctx): Promise<PublicKey[]>;
  closeAssignment(ctx: Ctx, match: PublicKey): Promise<string>;
}

// ---- settings --------------------------------------------------------------------------------------

export interface GameSettings {
  /** Most tables this Game may have (also bounded by `TableConfig.max_tables`). */
  cap: number;
  /** Idle tables kept ready beyond the Matches waiting. */
  spare: number;
  /** Tables made even when nothing waits. */
  min: number;
  /** Fuel account the Sponsor is refilled from, and how much each refill moves. */
  fuel: number;
  fuelAmount: bigint;
  /** The Sponsor is refilled below this many rollup lamports. */
  sponsorFloor: number;
  /** Lamports the keeper may put into a missing Sponsor / Fuel (0: it only raises an alert). */
  sponsorInit: bigint;
  fuelInit: bigint;
}

export interface SchedulerSettings {
  createPerPass: number;
  /** A joined Match with no table for this long (seconds, from when the keeper first saw it) raises an alert. */
  tableWaitSecs: number;
  /** A table Over for this long, or a result unsettled this long, raises an alert. */
  stuckOverSecs: number;
  unsettledSecs: number;
  /** Seconds between assignment cleanups. */
  cleanupSecs: number;
  cleanupPerPass: number;
}

const DEFAULT_CAP: Record<GameId, number> = { "trading-duel": 20, holdem: 20, "block-burst": 50, vanguard: 20 };
const num = (v: string | undefined, d: number) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

export function gameSettings(id: GameId, envName: string, env: NodeJS.ProcessEnv = process.env): GameSettings {
  const k = (s: string) => env[`KEEPER_${envName}_${s}`];
  return {
    cap: Math.max(0, Math.floor(num(k("TABLE_CAP"), DEFAULT_CAP[id]))),
    spare: Math.max(0, Math.floor(num(k("TABLE_SPARE"), 1))),
    min: Math.max(0, Math.floor(num(k("TABLE_MIN"), 1))),
    fuel: num(k("FUEL"), 0),
    fuelAmount: BigInt(Math.floor(num(k("FUEL_AMOUNT"), 50_000_000))),
    sponsorFloor: num(k("SPONSOR_FLOOR"), 20_000_000),
    sponsorInit: BigInt(Math.floor(num(k("SPONSOR_INIT"), 0))),
    fuelInit: BigInt(Math.floor(num(k("FUEL_INIT"), 0))),
  };
}

export function schedulerSettings(env: NodeJS.ProcessEnv = process.env): SchedulerSettings {
  return {
    createPerPass: Math.max(1, Math.floor(num(env.KEEPER_TABLES_CREATE_PER_PASS, 2))),
    tableWaitSecs: num(env.KEEPER_TABLE_WAIT_SECS, 300),
    stuckOverSecs: num(env.KEEPER_TABLES_STUCK_OVER_SECS, 1800),
    unsettledSecs: num(env.KEEPER_TABLES_UNSETTLED_SECS, 12 * 3600),
    cleanupSecs: num(env.KEEPER_TABLES_CLEANUP_SECS, 300),
    cleanupPerPass: Math.max(1, Math.floor(num(env.KEEPER_TABLES_CLEANUP_PER_PASS, 10))),
  };
}

// ---- pure planning ---------------------------------------------------------------------------------

export const SLOT_FREE = 0;
export const SLOT_DONE = 2;

export function baseStateOf(owner: PublicKey | null, program: PublicKey): BaseState {
  if (!owner) return "missing";
  if (owner.equals(program)) return "program";
  if (owner.equals(DELEGATION_PROGRAM_ID)) return "delegated";
  return "foreign";
}

/** A table that can take the next Match: delegated, seated, Idle, with a free ring slot, and no Assignment still able to begin on it. */
export function isAvailable(row: TableRow, promised: Promised[], now: number): boolean {
  const v = row.view;
  if (row.base !== "delegated" || !v || v.coarse !== "idle" || !v.seatsCreated) return false;
  if (!v.ring.some((s) => s.state === SLOT_FREE)) return false;
  // An Assignment holds its table's epoch until its start window closes; a window that closed without the Match beginning
  // frees the table again (the Match itself is refunded once the table's epoch has moved on, or by tesoro_core's deadline).
  return !promised.some((p) => p.index === row.index && p.epoch === v.epoch && p.startDeadline >= now);
}

export interface Waiting {
  address: PublicKey;
  openedAt: number;
}

/** Oldest waiting Match first, onto the lowest available table. */
export function planAssignments(rows: TableRow[], waiting: Waiting[], promised: Promised[], now: number): { match: Waiting; row: TableRow }[] {
  const free = rows.filter((r) => isAvailable(r, promised, now)).sort((a, b) => a.index - b.index);
  const queue = [...waiting].sort((a, b) => a.openedAt - b.openedAt || a.address.toBase58().localeCompare(b.address.toBase58()));
  return free.slice(0, queue.length).map((row, i) => ({ match: queue[i], row }));
}

/** How long a joined Match waits for a table before the Game refunds it: `table_kit::TABLE_WAIT_SECS`. */
export const TABLE_WAIT_SECS = 300;
/** tesoro_core's `MATCH_TIMEOUT_SECS`: a Match's deadline is this far past the moment it was joined. */
export const MATCH_TIMEOUT_SECS = 3600;
/** Rollup and keeper clocks may differ by a few seconds; a window is skipped only this long after it closed. */
export const SKIP_MARGIN_SECS = 5;

/**
 * When a joined Match no Assignment names was joined, mirroring `table_kit::untabled_since`: its deadline less core's timeout, or
 * null once the deadline was clamped to the absolute deadline (then core's own deadline is near).
 */
export function untabledSince(deadline: number, deadlineAbs: number): number | null {
  return deadline >= deadlineAbs ? null : deadline - MATCH_TIMEOUT_SECS;
}

export interface Unassigned {
  address: PublicKey;
  deadline: number;
  deadlineAbs: number;
}

/** The joined Matches without an Assignment that have waited for a table long enough to be refunded. */
export function dueForRefund<T extends Unassigned>(unplaced: T[], now: number): T[] {
  return unplaced.filter((m) => {
    const since = untabledSince(m.deadline, m.deadlineAbs);
    return since !== null && now >= since + TABLE_WAIT_SECS;
  });
}

export interface ExpiredAssignment {
  match: PublicKey;
  index: number;
  epoch: number;
  startDeadline: number;
}

/**
 * Assignments to give up with `skip_epoch`: the table is delegated, Idle at the Assignment's epoch, the start window closed, and the
 * ring has a free slot and none for that Match yet. Never an Assignment whose table is on a Match (that one is not Idle) or has
 * moved on (its Match refunds through `finalize` already).
 */
export function planSkips(rows: TableRow[], assignments: ExpiredAssignment[], now: number): ExpiredAssignment[] {
  const free = new Map<number, number>();
  const out: ExpiredAssignment[] = [];
  for (const a of assignments) {
    const row = rows.find((r) => r.index === a.index);
    const v = row?.view;
    if (!row || row.base !== "delegated" || !v || v.coarse !== "idle" || v.epoch !== a.epoch) continue;
    if (now <= a.startDeadline + SKIP_MARGIN_SECS) continue;
    if (v.ring.some((s) => s.state !== SLOT_FREE && s.tesoroMatch.equals(a.match))) continue;
    const left = free.get(a.index) ?? v.ring.filter((s) => s.state === SLOT_FREE).length;
    if (left <= 0) continue;
    free.set(a.index, left - 1);
    out.push(a);
  }
  return out;
}

export interface GrowthInput {
  rows: TableRow[];
  promised: Promised[];
  /** Matches that have no table and none planned this pass. */
  waiting: number;
  cap: number;
  maxTables: number;
  spare: number;
  min: number;
  createPerPass: number;
  preSeated: boolean;
  now: number;
}

export interface Growth {
  steps: { do: "create_table" | "delegate_table" | "init_seats"; index: number }[];
  /** Tables the Game wanted and the cap or `max_tables` refused. */
  capReached: boolean;
  /** Existing tables (created on base). */
  existing: number;
  /** Tables on their way (created, delegated or seated but not ready). */
  settingUp: number;
}

/**
 * Finishes the setup of tables already begun (always: their rent is paid), and starts new ones while Matches wait for a table:
 * the deficit is the waiting Matches plus `spare` minus the tables ready or on their way, at most `createPerPass` and never
 * past `min(cap, maxTables)`.
 */
export function planGrowth(g: GrowthInput): Growth {
  const steps: Growth["steps"] = [];
  let settingUp = 0;
  let ready = 0;
  for (const r of g.rows) {
    if (r.base === "program") {
      steps.push({ do: "delegate_table", index: r.index });
      settingUp++;
    } else if (r.base === "delegated" && r.view && g.preSeated && !r.view.seatsCreated) {
      steps.push({ do: "init_seats", index: r.index });
      settingUp++;
    } else if (isAvailable(r, g.promised, g.now)) ready++;
  }
  const existing = g.rows.filter((r) => r.base !== "missing").length;
  const limit = Math.min(g.cap, g.maxTables);
  const want = Math.max(g.waiting + g.spare - ready - settingUp, g.min - existing, 0);
  const room = Math.max(0, limit - existing);
  const make = Math.min(want, room, g.createPerPass);
  const missing = g.rows.filter((r) => r.base === "missing").sort((a, b) => a.index - b.index);
  for (const r of missing.slice(0, make)) steps.push({ do: "create_table", index: r.index });
  return { steps, capReached: want > room && g.waiting > ready + settingUp, existing, settingUp };
}

/** Why a table needs a person, or null. */
export function stuckReason(v: TableView, nowS: number, s: Pick<SchedulerSettings, "stuckOverSecs" | "unsettledSecs">): string | null {
  if (v.coarse === "over" && nowS - v.overAt > s.stuckOverSecs) return `Over for ${Math.round((nowS - v.overAt) / 60)} min and not reset`;
  const old = v.ring.find((r) => r.state === SLOT_DONE && nowS - r.at > s.unsettledSecs);
  if (old) return `result of ${shortKey(old.tesoroMatch)} unsettled for ${Math.round((nowS - old.at) / 3600)} h`;
  return null;
}

/** Can an Assignment be closed: tesoro_core froze its Match (receipt) or the Match account is gone. */
export const assignmentClosable = (matchExists: boolean, receiptExists: boolean) => receiptExists || !matchExists;

// ---- per-process state ---------------------------------------------------------------------------------

export interface GameState {
  lastRecommit: Map<string, number>;
  /** When the keeper first saw a Match with no table (Unix seconds). */
  firstSeen: Map<string, number>;
  lastCleanup: number;
}
export const newGameState = (): GameState => ({ lastRecommit: new Map(), firstSeen: new Map(), lastCleanup: 0 });
const states = new Map<GameId, GameState>();
export const stateOf = (id: GameId) => {
  let s = states.get(id);
  if (!s) states.set(id, (s = newGameState()));
  return s;
};

export interface SchedMatch {
  address: PublicKey;
  inner: any;
  stage: string;
}

export interface Deps {
  gate?: typeof resetMayProceed;
  settings?: SchedulerSettings;
}

const condition = (key: string, on: boolean, title: string, detail: string) => (on ? raise({ key, title, detail }) : clearRaised(key));

/** receipt age in seconds of tesoro_core's settlement receipt for each Match (null: none yet). */
export async function receiptAges(ctx: Ctx, keys: PublicKey[], receiptPda: (m: PublicKey) => PublicKey): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const uniq = [...new Map(keys.map((k) => [k.toBase58(), k])).values()];
  for (const key of uniq) {
    const info = await ctx.conn.getAccountInfo(receiptPda(key)).catch(() => null);
    if (!info) {
      out.set(key.toBase58(), null);
      continue;
    }
    const r: any = ctx.core.coder.accounts.decode("settlementReceipt", info.data);
    out.set(key.toBase58(), ctx.now - Number(r.receipt.at.toString()));
  }
  return out;
}

/** A table with nothing in its ring and no Match needs no reads at all. */
export const quiet = (v: TableView) => v.coarse === "idle" && !v.dirty && !v.ring.some((s) => s.state === SLOT_DONE);

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

async function readRows(ctx: Ctx, a: GameAdapter, generation: number, maxTables: number): Promise<TableRow[]> {
  const addresses = Array.from({ length: maxTables }, (_, i) => a.tableAddress(generation, i));
  const infos: ({ owner: PublicKey } | null)[] = [];
  for (let i = 0; i < addresses.length; i += 100) infos.push(...(await ctx.conn.getMultipleAccountsInfo(addresses.slice(i, i + 100))));
  const rows: TableRow[] = infos.map((info, index) => ({ index, base: baseStateOf(info?.owner ?? null, a.programId), view: null }));
  await pool(
    rows.filter((r) => r.base === "delegated"),
    8,
    async (r) => {
      r.view = await a.read(ctx, { generation, index: r.index }).catch(() => null);
    },
  );
  return rows;
}

/** Runs one Game's scheduler pass. Returns the number of actions taken. */
export async function runGame(ctx: Ctx, a: GameAdapter, set: GameSettings, matches: SchedMatch[], st: GameState = stateOf(a.id), deps: Deps = {}): Promise<number> {
  const sched = deps.settings ?? schedulerSettings();
  const key = (s: string) => `tables:${a.label}:${s}`;
  const cfg = await a.config(ctx).catch(() => null);
  if (!cfg) return 0; // the Game has no TableConfig yet (not deployed with tables)
  const init = { sponsor: set.sponsorInit, fuel: set.fuelInit };
  const operatorOk = cfg.operator.equals(ctx.payer.publicKey);
  condition(key("operator"), !operatorOk, `${a.label} tables: the keeper is not the operator`, `TableConfig.operator of ${a.label} is ${cfg.operator.toBase58()}, not the keeper key ${ctx.payer.publicKey.toBase58()}: no table can be created or assigned until set_config names the keeper.`);
  const here = (what: string) => `table=${a.label}/${cfg.generation}/${what}`;
  let actions = 0;
  const run = async (subject: string, what: string, fn: () => Promise<string>) => {
    const r = await act(ctx, "tables", subject, what, fn);
    actions += +r.ok;
    return r.ok;
  };

  // 1. infrastructure -------------------------------------------------------------------------------------
  const infoOf = async (address: PublicKey) => baseStateOf((await ctx.conn.getAccountInfo(address).catch(() => null))?.owner ?? null, a.programId);
  const sponsorBase = await infoOf(a.sponsorAddress());
  const sponsorReady = sponsorBase === "delegated";
  if (operatorOk && sponsorBase === "missing" && set.sponsorInit > 0n) await run(here("sponsor"), `create_sponsor (${set.sponsorInit} lamports)`, () => a.setup(ctx, { do: "create_sponsor" }, { generation: cfg.generation, index: 0 }, init));
  else if (operatorOk && sponsorBase === "program") await run(here("sponsor"), "delegate_sponsor", () => a.setup(ctx, { do: "delegate_sponsor" }, { generation: cfg.generation, index: 0 }, init));
  condition(key("sponsor-missing"), sponsorBase === "missing" && set.sponsorInit === 0n, `${a.label} tables: no Sponsor`, `The ${a.label} Sponsor account does not exist and KEEPER_${a.env}_SPONSOR_INIT is 0: tables cannot be committed. Run the setup (create_sponsor, delegate_sponsor).`);
  const fuelBase = await infoOf(a.fuelAddress(set.fuel));
  if (operatorOk && fuelBase === "missing" && set.fuelInit > 0n) await run(here(`fuel${set.fuel}`), `create_fuel ${set.fuel}`, () => a.setup(ctx, { do: "create_fuel", n: set.fuel }, { generation: cfg.generation, index: 0 }, init));
  else if (operatorOk && fuelBase === "program") await run(here(`fuel${set.fuel}`), `delegate_fuel ${set.fuel}`, () => a.setup(ctx, { do: "delegate_fuel", n: set.fuel }, { generation: cfg.generation, index: 0 }, init));

  // 2. upkeep ----------------------------------------------------------------------------------------------
  const rows = await readRows(ctx, a, cfg.generation, cfg.maxTables);
  for (const r of rows) {
    const stuck = r.view ? stuckReason(r.view, ctx.now, sched) : null;
    condition(key(`stuck:${r.index}`), !!stuck, `${a.label} table ${r.index} is stuck`, `Table ${a.tableAddress(cfg.generation, r.index).toBase58()} (${a.label}): ${stuck}.`);
  }
  const steps = await pool(
    rows.filter((r) => r.view && !quiet(r.view)),
    6,
    async (r) => {
      const ref = { generation: cfg.generation, index: r.index };
      const subject = here(String(r.index));
      return { r, ref, subject, step: await a.step(ctx, r.view!, ref, st.lastRecommit.get(subject) ?? 0).catch((e) => ({ do: "wait", why: `unreadable: ${String(e?.message ?? e).slice(0, 80)}` }) as UpkeepStep) };
    },
  );
  for (const { r, ref, subject, step } of steps) {
    const view = r.view!;
    if (step.do === "wait") continue;
    const what = `${step.do} (${step.why})`;
    if (step.why.includes("probably lost")) st.lastRecommit.set(subject, ctx.now);
    if (step.do === "release_slot") await run(subject, what, () => a.release(ctx, ref, view, step.slot!.index, new PublicKey(step.slot!.match)));
    else if (step.do === "void_table") await run(subject, what, () => a.void(ctx, ref, view));
    else if (step.do === "commit_table") await run(subject, what, () => a.commit(ctx, ref));
    else if (step.do === "close_seats" || step.do === "wipe_seats") await run(subject, what, () => a.seats(ctx, ref));
    else if (step.do === "reset_table") {
      // The reset wipes the Match's board: its public end state goes to the Match history first, in this same step.
      const held = await a.endState(ctx, ref, view).catch(() => null);
      if (!held) continue; // the end state could not be read: the reset waits for the next pass
      const sinceOver = Math.max(0, Math.floor(ctx.now - view.overAt));
      if (!(await (deps.gate ?? resetMayProceed)(held, sinceOver, undefined, subject))) continue;
      await run(subject, what, () => a.reset(ctx, ref));
    }
  }

  // 3. assignment ------------------------------------------------------------------------------------------
  const mine = matches.filter((m) => m.stage === "active" && m.inner.b && pk(m.inner.game).equals(a.programId));
  const promised: Promised[] = [];
  const waiting: (Waiting & { inner: any })[] = [];
  const expired: ExpiredAssignment[] = [];
  const assignments = await pool(mine, 8, (m) => a.assignmentOf(ctx, m.address).catch(() => undefined));
  mine.forEach((m, i) => {
    const as = assignments[i];
    if (as === undefined) return; // unreadable this pass: leave it alone
    if (as) {
      promised.push({ index: as.index, epoch: as.epoch, startDeadline: as.startDeadline });
      expired.push({ match: m.address, index: as.index, epoch: as.epoch, startDeadline: as.startDeadline });
    } else if (Number(m.inner.deadline.toString()) - ctx.now > 60) waiting.push({ address: m.address, openedAt: Number(m.inner.openedAt.toString()), inner: m.inner });
  });
  const seen = new Set(waiting.map((w) => w.address.toBase58()));
  for (const k of [...st.firstSeen.keys()]) if (!seen.has(k)) st.firstSeen.delete(k);
  for (const k of seen) if (!st.firstSeen.has(k)) st.firstSeen.set(k, ctx.now);

  let assigned = 0;
  const assignedNow = new Set<string>();
  const assignable = waiting.filter((w) => a.id !== "trading-duel" || assetOfIndex(Number(w.inner.meta?.asset)) !== null);
  if (operatorOk && sponsorReady) {
    for (const { match, row } of planAssignments(rows, assignable, promised, ctx.now)) {
      const w = waiting.find((x) => x.address.equals(match.address))!;
      const pick = { generation: cfg.generation, index: row.index, epoch: row.view!.epoch };
      const ok = await run(`match=${matchLabel(matchRefOf(w.inner.id))}`, `assign_match to table ${pick.generation}/${pick.index} epoch ${pick.epoch}`, () => a.assign(ctx, match.address, w.inner, pick));
      if (ok) {
        assigned++;
        assignedNow.add(match.address.toBase58());
        promised.push({ index: pick.index, epoch: pick.epoch, startDeadline: Number.MAX_SAFE_INTEGER });
        st.firstSeen.delete(match.address.toBase58());
      }
    }
  }

  // 3b. fast refunds (ticket 35) -----------------------------------------------------------------------------
  // An Assignment whose Match never began is given up so its Match refunds from a committed result; a joined Match that no
  // table took within TABLE_WAIT_SECS is refunded at once. Both come after assignment: a free table is always tried first.
  if (operatorOk) {
    for (const x of planSkips(rows, expired, ctx.now)) {
      await run(`match=${shortKey(x.match)}`, `skip_epoch (table ${x.index} epoch ${x.epoch}, the Match never began)`, () => a.skip(ctx, x.match));
    }
  }
  const stillWaiting = waiting.filter((w) => !assignedNow.has(w.address.toBase58()));
  let refundedUntabled = 0;
  for (const w of dueForRefund(
    stillWaiting.map((w) => ({ ...w, deadline: Number(w.inner.deadline.toString()), deadlineAbs: Number(w.inner.deadlineAbs?.toString() ?? Number.MAX_SAFE_INTEGER) })),
    ctx.now,
  )) {
    const ok = await run(`match=${matchLabel(matchRefOf(w.inner.id))}`, "refund_untabled (no table within the wait)", () => a.refundUntabled(ctx, w.address));
    if (ok) {
      refundedUntabled++;
      st.firstSeen.delete(w.address.toBase58());
    }
  }

  // 4. growth ----------------------------------------------------------------------------------------------
  const unplaced = waiting.length - assigned - refundedUntabled;
  const demand = assignable.filter((w) => !assignedNow.has(w.address.toBase58()) && st.firstSeen.has(w.address.toBase58())).length;
  const growth = planGrowth({ rows, promised, waiting: demand, cap: set.cap, maxTables: cfg.maxTables, spare: set.spare, min: set.min, createPerPass: sched.createPerPass, preSeated: a.preSeated, now: ctx.now });
  if (operatorOk && sponsorBase !== "missing") {
    for (const s of growth.steps) {
      const ref = { generation: cfg.generation, index: s.index };
      await run(here(String(s.index)), s.do, () => a.setup(ctx, { do: s.do, index: s.index }, ref, init));
    }
  } else if (growth.steps.length) log("tables", a.label, `SKIP ${growth.steps.length} setup step(s): ${operatorOk ? "no Sponsor yet" : "the keeper is not the operator"}`);
  condition(key("cap"), growth.capReached, `${a.label} tables: cap reached`, `${unplaced} ${a.label} Match(es) wait for a table and the Game already has ${growth.existing} of at most ${Math.min(set.cap, cfg.maxTables)} (KEEPER_${a.env}_TABLE_CAP, TableConfig.max_tables). Raise the cap or the Matches will be refunded at their deadline.`);
  const oldest = [...st.firstSeen.values()].reduce((m, t) => Math.min(m, t), Infinity);
  const late = unplaced > 0 && ctx.now - oldest >= sched.tableWaitSecs;
  condition(key("wait"), late, `${a.label}: a Match is waiting for a table`, `${unplaced} joined ${a.label} Match(es) have had no table for ${Math.round((ctx.now - oldest) / 60)} min (limit ${Math.round(sched.tableWaitSecs / 60)} min). the keeper refunds each after ${Math.round(TABLE_WAIT_SECS / 60)} min (refund_untabled) and that did not happen; check the tables, the cap and the keeper's payer.`);

  // 5. the Sponsor's fuel ------------------------------------------------------------------------------------
  if (sponsorReady) {
    const balance = await a.sponsorBalance(ctx).catch(() => null);
    if (balance !== null && balance < set.sponsorFloor) {
      const ok = await run("sponsor", `${a.label} refill_sponsor (balance ${balance} lamports)`, () => a.refill(ctx, set.fuel, set.fuelAmount));
      condition(key("sponsor"), !ok, `${a.label} Sponsor is low`, `The ${a.label} Sponsor holds ${balance} lamports (floor ${set.sponsorFloor}) and refilling it from Fuel ${set.fuel} did not work. Without it no table can be committed. Create more Fuel or top it up.`);
    } else condition(key("sponsor"), false, "", "");
  }

  // 6. clean up Assignments of frozen Matches (rent back to the keeper) -------------------------------------------
  if (ctx.now - st.lastCleanup >= sched.cleanupSecs) {
    st.lastCleanup = ctx.now;
    actions += await cleanAssignments(ctx, a, here, sched.cleanupPerPass);
  }

  const idle = rows.filter((r) => r.view?.coarse === "idle").length;
  log("tables", a.label, `${growth.existing}/${Math.min(set.cap, cfg.maxTables)} tables (${idle} idle, ${rows.filter((r) => r.view && r.view.coarse !== "idle").length} busy, ${growth.settingUp} setting up), ${waiting.length} waiting, ${actions} action(s)`);
  return actions;
}

async function cleanAssignments(ctx: Ctx, a: GameAdapter, here: (s: string) => string, limit: number): Promise<number> {
  const all = await a.assignmentMatches(ctx).catch(() => []);
  if (!all.length) return 0;
  const receipts = await ctx.conn.getMultipleAccountsInfo(all.map((m) => settledPda(m))).catch(() => null);
  const matches = await ctx.conn.getMultipleAccountsInfo(all).catch(() => null);
  if (!receipts || !matches) return 0;
  let n = 0;
  for (let i = 0; i < all.length && n < limit; i++) {
    if (!assignmentClosable(!!matches[i], !!receipts[i])) continue;
    const r = await act(ctx, "tables", here("assign"), `close_assignment ${shortKey(all[i])}`, () => a.closeAssignment(ctx, all[i]));
    n += +r.ok;
  }
  return n;
}

