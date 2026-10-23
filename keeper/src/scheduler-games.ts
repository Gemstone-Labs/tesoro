import anchor from "@coral-xyz/anchor";
import { ComputeBudgetProgram, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { BLOCK_PUZZLE_PROGRAM_ID } from "../../app/src/games/block-puzzle/chain.ts";
import * as burstChain from "../../app/src/games/block-puzzle/live-chain.ts";
import * as holdemChain from "../../app/src/games/holdem/chain.ts";
import * as duelChain from "../../app/src/games/trading-duel/chain.ts";
import * as vanguardChain from "../../app/src/games/vanguard/chain.ts";
import { log, type Ctx } from "./act.ts";
import { burstEndState, duelEndState, holdemEndState, vanguardEndState } from "./end-state.ts";
import { burstTableFacts, burstTableStep } from "./burst.ts";
import { holdemTableFacts, holdemTableStep } from "./holdem.ts";
import { tableFacts, tableStep } from "./tables.ts";
import { vanguardTableFacts } from "./vanguard.ts";
import { scanMatches } from "./matches.ts";
import { keyOf } from "./kit.ts";
import { sendIxs } from "./send.ts";
import { runGame, gameSettings, receiptAges, type GameAdapter, type Init, type GameId, type SetupStep, type TableView, type UpkeepStep } from "./scheduler.ts";

/**
 * The four table Games behind `GameAdapter`. Each adapter only maps its Game's table to the scheduler's view and calls the Game's
 * own client; the decisions are the Games' pure table steps (`tableStep`, `holdemTableStep`, `burstTableStep`), unchanged.
 * `reset` is reachable only through the scheduler, which captures the end state first (guard test in `end-state.test.ts`).
 */

const HOLDEM_PROGRAM = holdemChain.HOLDEM_PROGRAM_ID;
const ring = (t: { ring: { state: number; tesoroMatch: PublicKey; epoch: number; at: number }[] }) => t.ring.map((s) => ({ state: s.state, tesoroMatch: s.tesoroMatch, epoch: s.epoch, at: s.at }));
const hasFree = (t: { ring: { state: number }[] }) => t.ring.some((s) => s.state === 0);

/** Anchor instruction for a setup step, built from the Game's IDL: only the operator (and the validator, to delegate) are given, every PDA resolves from its seeds. */
export async function setupIx(program: any, step: SetupStep, ref: { generation: number; index: number }, operator: PublicKey, validator: PublicKey, fuelPda: (n: number) => PublicKey): Promise<TransactionInstruction> {
  const accounts = { operator, validator };
  switch (step.do) {
    case "create_table":
      return program.methods.createTable(ref.generation, step.index).accountsPartial({ operator }).instruction();
    case "delegate_table":
      return program.methods.delegateTable(ref.generation, step.index).accountsPartial(accounts).instruction();
    case "create_sponsor":
      throw new Error("create_sponsor needs its amount: use createSponsorIx");
    case "delegate_sponsor":
      return program.methods.delegateSponsor().accountsPartial(accounts).instruction();
    case "create_fuel":
      throw new Error("create_fuel needs its amount: use createFuelIx");
    case "delegate_fuel":
      return program.methods.delegateFuel(step.n).accountsPartial({ ...accounts, fuel: fuelPda(step.n) }).instruction();
    default:
      throw new Error(`${step.do} is not a base-layer setup step`);
  }
}

export const createSponsorIx = (program: any, operator: PublicKey, lamports: bigint): Promise<TransactionInstruction> =>
  program.methods.createSponsor(new anchor.BN(lamports.toString())).accountsPartial({ operator }).instruction();
export const createFuelIx = (program: any, operator: PublicKey, n: number, lamports: bigint, fuel: PublicKey): Promise<TransactionInstruction> =>
  program.methods.createFuel(n, new anchor.BN(lamports.toString())).accountsPartial({ operator, fuel }).instruction();

export async function sendSetup(ctx: Ctx, program: any, step: SetupStep, ref: { generation: number; index: number }, validator: PublicKey, init: Init, fuelPda: (n: number) => PublicKey): Promise<string> {
  const operator = ctx.payer.publicKey;
  let ix: TransactionInstruction;
  if (step.do === "create_sponsor") ix = await createSponsorIx(program, operator, init.sponsor);
  else if (step.do === "create_fuel") ix = await createFuelIx(program, operator, step.n, init.fuel, fuelPda(step.n));
  else ix = await setupIx(program, step, ref, operator, validator, fuelPda);
  return sendIxs(ctx.conn, ctx.payer, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix]);
}

const tableConfigOf = async (program: any, address: PublicKey) => {
  const c: any = await program.account.tableConfig.fetch(address).catch(() => null);
  return c ? { generation: c.generation as number, maxTables: c.maxTables as number, operator: c.operator as PublicKey } : null;
};

// ---- Trading Duel --------------------------------------------------------------------------------------------

const duelView = (t: duelChain.Table): TableView => ({
  index: t.index,
  epoch: t.epoch,
  coarse: t.phase === duelChain.PHASE.idle ? "idle" : t.phase === duelChain.PHASE.over ? "over" : "match",
  seatsCreated: true,
  seatsOpen: t.seatsOpen,
  dirty: t.dirty,
  overAt: t.overAt,
  tesoroMatch: t.tesoroMatch,
  ring: ring(t),
  raw: t,
});

export const duelAdapter: GameAdapter = {
  id: "trading-duel",
  label: "trading-duel",
  env: "DUEL",
  programId: duelChain.TRADING_DUEL_PROGRAM_ID,
  preSeated: false,
  config: (ctx) => tableConfigOf(ctx.duel.program, duelChain.configPda()),
  tableAddress: duelChain.tablePda,
  sponsorAddress: duelChain.sponsorPda,
  fuelAddress: duelChain.fuelPda,
  read: async (ctx, ref) => {
    const t = await ctx.duel.readTable(ctx.hsigner, ref);
    return t ? duelView(t) : null;
  },
  step: async (ctx, v, ref, lastRecommit): Promise<UpkeepStep> => {
    const t = v.raw as duelChain.Table;
    const ages = await receiptAges(ctx, [t.tesoroMatch, ...t.ring.filter((s) => s.state === duelChain.SLOT.done).map((s) => s.tesoroMatch)], holdemChain.settledPda);
    const base = await ctx.duel.readTableOnBase(ref).catch(() => null);
    return tableStep(tableFacts(t, ctx.now, (m) => ages.get(m.toBase58()) ?? null, base, lastRecommit));
  },
  commit: (ctx, ref) => ctx.duel.commitTable(ctx.hsigner, ref),
  seats: (ctx, ref) => ctx.duel.closeSeats(ctx.hsigner, ref),
  reset: (ctx, ref) => ctx.duel.resetTable(ctx.hsigner, duelChain.tablePda(ref.generation, ref.index)),
  release: (ctx, ref, _v, slot, match) => ctx.duel.releaseSlot(ctx.hsigner, duelChain.tablePda(ref.generation, ref.index), slot, match),
  void: (ctx, ref, v) => ctx.duel.voidTable(ctx.hsigner, duelChain.tablePda(ref.generation, ref.index), v.tesoroMatch),
  endState: async (_ctx, _ref, v) => ({ tesoroMatch: v.tesoroMatch, epoch: v.epoch, fn: duelEndState, table: v.raw }),
  assignmentOf: (ctx, m) => ctx.duel.readAssignment(m),
  assign: async (ctx, m, inner, pick) => {
    const [a, b]: any[] = await Promise.all([ctx.core.account.tesoroAccount.fetch(keyOf(inner.a.player)), ctx.core.account.tesoroAccount.fetch(keyOf(inner.b.player))]);
    return ctx.duel.assignMatch(ctx.hsigner, m, a.authority, b.authority, pick.generation, pick.index, pick.epoch);
  },
  setup: (ctx, step, ref, init) => sendSetup(ctx, ctx.duel.program, step, ref, holdemChain.TEE_VALIDATOR, init, duelChain.fuelPda),
  sponsorBalance: async (ctx) => (await (await ctx.duel.teeConnection(ctx.hsigner)).getBalance(duelChain.sponsorPda()).catch(() => null)),
  refill: (ctx, fuel, amount) => ctx.duel.refillSponsor(ctx.hsigner, fuel, amount),
  assignmentMatches: async (ctx) => ((await (ctx.duel.program.account as any).assignment.all()) as any[]).map((x) => x.account.tesoroMatch as PublicKey),
  refundUntabled: (ctx, m) => ctx.duel.refundUntabled(ctx.hsigner, m),
  skip: async (ctx, m) => {
    const a = await ctx.duel.readAssignment(m);
    return a ? ctx.duel.skipEpoch(ctx.hsigner, a) : "";
  },
  closeAssignment: async (ctx, m) => {
    const a = await ctx.duel.readAssignment(m);
    if (!a) return "";
    return ctx.duel.closeAssignment(ctx.hsigner, a);
  },
};

// ---- Hold'em -------------------------------------------------------------------------------------------------

const holdemView = (t: holdemChain.Table): TableView => ({
  index: t.index,
  epoch: t.epoch,
  coarse: t.tablePhase === holdemChain.TABLE_PHASE.idle ? "idle" : t.tablePhase === holdemChain.TABLE_PHASE.over ? "over" : "match",
  seatsCreated: t.seatsCreated,
  seatsOpen: t.seatsOpen,
  dirty: t.dirty,
  overAt: t.overAt,
  tesoroMatch: t.tesoroMatch,
  ring: ring(t),
  raw: t,
});

export const holdemAdapter: GameAdapter = {
  id: "holdem",
  label: "holdem",
  env: "HOLDEM",
  programId: HOLDEM_PROGRAM,
  preSeated: true,
  config: (ctx) => tableConfigOf(ctx.holdem.program, holdemChain.configPda()),
  tableAddress: holdemChain.tablePda,
  sponsorAddress: holdemChain.sponsorPda,
  fuelAddress: holdemChain.fuelPda,
  read: async (ctx, ref) => {
    const t = await ctx.holdem.readTable(ctx.hsigner, ref);
    return t ? holdemView(t) : null;
  },
  step: async (ctx, v, ref, lastRecommit): Promise<UpkeepStep> => {
    const t = v.raw as holdemChain.Table;
    const ages = await receiptAges(ctx, [t.tesoroMatch, ...t.ring.filter((s) => s.state === holdemChain.SLOT.done).map((s) => s.tesoroMatch)], holdemChain.settledPda);
    const base = await ctx.holdem.readTableOnBase(ref).catch(() => null);
    return holdemTableStep(holdemTableFacts(t, ctx.now, (m) => ages.get(m.toBase58()) ?? null, base, lastRecommit));
  },
  commit: (ctx, ref) => ctx.holdem.commitTable(ctx.hsigner, ref),
  seats: (ctx, ref) => ctx.holdem.wipeSeats(ctx.hsigner, ref),
  reset: (ctx, ref) => ctx.holdem.resetTable(ctx.hsigner, holdemChain.tablePda(ref.generation, ref.index)),
  release: (ctx, ref, _v, slot, match) => ctx.holdem.releaseSlot(ctx.hsigner, holdemChain.tablePda(ref.generation, ref.index), slot, match),
  void: (ctx, ref, v) => ctx.holdem.voidTable(ctx.hsigner, holdemChain.tablePda(ref.generation, ref.index), v.tesoroMatch),
  endState: async (_ctx, _ref, v) => ({ tesoroMatch: v.tesoroMatch, epoch: v.epoch, fn: holdemEndState, table: v.raw }),
  assignmentOf: (ctx, m) => ctx.holdem.readAssignment(m),
  assign: async (ctx, m, inner, pick) => {
    const [a, b]: any[] = await Promise.all([ctx.core.account.tesoroAccount.fetch(keyOf(inner.a.player)), ctx.core.account.tesoroAccount.fetch(keyOf(inner.b.player))]);
    return ctx.holdem.assignMatch(ctx.hsigner, m, a.authority, b.authority, pick.generation, pick.index, pick.epoch);
  },
  setup: (ctx, step, ref, init) => (step.do === "init_seats" ? ctx.holdem.initSeats(ctx.hsigner, { generation: ref.generation, index: step.index }) : sendSetup(ctx, ctx.holdem.program, step, ref, holdemChain.TEE_VALIDATOR, init, holdemChain.fuelPda)),
  sponsorBalance: async (ctx) => (await (await ctx.holdem.teeConnection(ctx.hsigner)).getBalance(holdemChain.sponsorPda()).catch(() => null)),
  refill: (ctx, fuel, amount) => ctx.holdem.refillSponsor(ctx.hsigner, fuel, amount),
  assignmentMatches: async (ctx) => ((await (ctx.holdem.program.account as any).assignment.all()) as any[]).map((x) => x.account.tesoroMatch as PublicKey),
  refundUntabled: (ctx, m) => ctx.holdem.refundUntabled(ctx.hsigner, m),
  skip: async (ctx, m) => {
    const a = await ctx.holdem.readAssignment(m);
    return a ? ctx.holdem.skipEpoch(ctx.hsigner, a) : "";
  },
  closeAssignment: async (ctx, m) => {
    const a = await ctx.holdem.readAssignment(m);
    return a ? ctx.holdem.closeAssignment(ctx.hsigner, a) : "";
  },
};

// ---- Block Burst Live ----------------------------------------------------------------------------------------

const burstView = (t: burstChain.Table): TableView => ({
  index: t.index,
  epoch: t.epoch,
  coarse: t.phase === burstChain.TABLE_PHASE.idle ? "idle" : t.phase === burstChain.TABLE_PHASE.closed ? "over" : "match",
  seatsCreated: t.seatsCreated,
  seatsOpen: t.seatsOpen,
  dirty: t.dirty,
  overAt: t.overAt,
  tesoroMatch: t.tesoroMatch,
  ring: ring(t),
  raw: t,
});

export const burstAdapter: GameAdapter = {
  id: "block-burst",
  label: "block-burst",
  env: "BURST",
  programId: BLOCK_PUZZLE_PROGRAM_ID,
  preSeated: true,
  config: (ctx) => tableConfigOf(ctx.burst.program, burstChain.configPda()),
  tableAddress: burstChain.tablePda,
  sponsorAddress: burstChain.sponsorPda,
  fuelAddress: burstChain.fuelPda,
  read: async (ctx, ref) => {
    const t = await ctx.burst.readTable(ctx.hsigner, ref);
    return t ? burstView(t) : null;
  },
  step: async (ctx, v, ref, lastRecommit): Promise<UpkeepStep> => {
    const t = v.raw as burstChain.Table;
    const ages = await receiptAges(ctx, [t.tesoroMatch, ...t.ring.filter((s) => s.state === burstChain.SLOT.done).map((s) => s.tesoroMatch)], burstChain.settledPda);
    const base = await ctx.burst.readTableOnBase(ref).catch(() => null);
    return burstTableStep(burstTableFacts(t, ctx.now, (m) => ages.get(m.toBase58()) ?? null, base, lastRecommit));
  },
  commit: (ctx, ref) => ctx.burst.commitTable(ctx.hsigner, ref),
  seats: (ctx, ref) => ctx.burst.wipeSeats(ctx.hsigner, ref),
  reset: (ctx, ref) => ctx.burst.resetTable(ctx.hsigner, burstChain.tablePda(ref.generation, ref.index)),
  release: (ctx, ref, _v, slot, match) => ctx.burst.releaseSlot(ctx.hsigner, burstChain.tablePda(ref.generation, ref.index), slot, match),
  void: (ctx, ref, v) => ctx.burst.voidTable(ctx.hsigner, burstChain.tablePda(ref.generation, ref.index), v.tesoroMatch),
  endState: async (_ctx, _ref, v) => ({ tesoroMatch: v.tesoroMatch, epoch: v.epoch, fn: burstEndState, table: v.raw }),
  assignmentOf: (ctx, m) => ctx.burst.readAssignment(m),
  assign: async (ctx, m, inner, pick) => {
    const [a, b]: any[] = await Promise.all([ctx.core.account.tesoroAccount.fetch(keyOf(inner.a.player)), ctx.core.account.tesoroAccount.fetch(keyOf(inner.b.player))]);
    return ctx.burst.assignMatch(ctx.hsigner, m, a.authority, b.authority, pick.generation, pick.index, pick.epoch);
  },
  setup: (ctx, step, ref, init) => (step.do === "init_seats" ? ctx.burst.initSeats(ctx.hsigner, { generation: ref.generation, index: step.index }) : sendSetup(ctx, ctx.burst.program, step, ref, burstChain.TEE_VALIDATOR, init, burstChain.fuelPda)),
  sponsorBalance: async (ctx) => (await (await ctx.burst.teeConnection(ctx.hsigner)).getBalance(burstChain.sponsorPda()).catch(() => null)),
  refill: (ctx, fuel, amount) => ctx.burst.refillSponsor(ctx.hsigner, fuel, amount),
  assignmentMatches: async (ctx) => ((await (ctx.burst.program.account as any).assignment.all()) as any[]).map((x) => x.account.tesoroMatch as PublicKey),
  refundUntabled: (ctx, m) => ctx.burst.refundUntabled(ctx.hsigner, m),
  skip: async (ctx, m) => {
    const a = await ctx.burst.readAssignment(m);
    return a ? ctx.burst.skipEpoch(ctx.hsigner, a) : "";
  },
  closeAssignment: async (ctx, m) => {
    const a = await ctx.burst.readAssignment(m);
    return a ? ctx.burst.closeAssignment(ctx.hsigner, a) : "";
  },
};

// ---- Vanguard ------------------------------------------------------------------------------------------------

const vanguardView = (t: vanguardChain.TableState): TableView => ({
  index: t.index,
  epoch: t.epoch,
  coarse: t.phase === vanguardChain.TABLE_PHASE.idle ? "idle" : t.phase === vanguardChain.TABLE_PHASE.over ? "over" : "match",
  seatsCreated: t.seatsCreated,
  seatsOpen: t.seatsOpen,
  dirty: t.dirty,
  overAt: t.overAt,
  tesoroMatch: t.tesoroMatch,
  ring: ring(t),
  raw: t,
});

export const vanguardAdapter: GameAdapter = {
  id: "vanguard",
  label: "vanguard",
  env: "VANGUARD",
  programId: vanguardChain.VANGUARD_PROGRAM_ID,
  preSeated: true,
  config: (ctx) => tableConfigOf(ctx.vanguard.program, vanguardChain.tablesPda()),
  tableAddress: vanguardChain.tablePda,
  sponsorAddress: vanguardChain.sponsorPda,
  fuelAddress: vanguardChain.fuelPda,
  read: async (ctx, ref) => {
    const t = await ctx.vanguard.readTable(ctx.hsigner, ref);
    return t ? vanguardView(t) : null;
  },
  step: async (ctx, v, ref, lastRecommit): Promise<UpkeepStep> => {
    const t = v.raw as vanguardChain.TableState;
    const ages = await receiptAges(ctx, [t.tesoroMatch, ...t.ring.filter((s) => s.state === vanguardChain.SLOT.done).map((s) => s.tesoroMatch)], holdemChain.settledPda);
    const base = await ctx.vanguard.readTableOnBase(ref).catch(() => null);
    return holdemTableStep(vanguardTableFacts(t, ctx.now, (m) => ages.get(m.toBase58()) ?? null, base, lastRecommit));
  },
  commit: (ctx, ref) => ctx.vanguard.commitTable(ctx.hsigner, ref),
  seats: (ctx, ref) => ctx.vanguard.wipeSeats(ctx.hsigner, ref),
  reset: (ctx, ref) => ctx.vanguard.resetTable(ctx.hsigner, ref),
  release: (ctx, ref, _v, slot, match) => ctx.vanguard.releaseSlot(ctx.hsigner, vanguardChain.tablePda(ref.generation, ref.index), slot, match),
  void: (ctx, ref, v) => ctx.vanguard.voidTable(ctx.hsigner, ref, v.tesoroMatch),
  endState: async (ctx, ref, v) => {
    // The reset zeroes the Battle: its end board goes to the Match history first. A Battle of another Match has no board to keep.
    const b = await ctx.vanguard.readBattle(ctx.hsigner, ref).catch(() => null);
    const board = b && b.tesoroMatch.equals(v.tesoroMatch) ? b : null;
    return { tesoroMatch: v.tesoroMatch, epoch: v.epoch, fn: board ? vanguardEndState : () => null, table: board as never };
  },
  assignmentOf: (ctx, m) => ctx.vanguard.readAssignment(m),
  assign: async (ctx, m, inner, pick) => {
    const [a, b]: any[] = await Promise.all([ctx.core.account.tesoroAccount.fetch(keyOf(inner.a.player)), ctx.core.account.tesoroAccount.fetch(keyOf(inner.b.player))]);
    return ctx.vanguard.assignMatch(ctx.hsigner, m, a.authority, b.authority, pick.generation, pick.index, pick.epoch);
  },
  setup: async (ctx, step, ref, init) =>
    step.do === "init_seats"
      ? ctx.vanguard.initSeats(ctx.hsigner, { generation: ref.generation, index: step.index })
      : sendSetup(ctx, ctx.vanguard.program, step, ref, (await ctx.vanguard.readConfig()).teeValidator, init, vanguardChain.fuelPda),
  sponsorBalance: async (ctx) => (await (await ctx.vanguard.teeConnection(ctx.hsigner)).getBalance(vanguardChain.sponsorPda()).catch(() => null)),
  refill: (ctx, fuel, amount) => ctx.vanguard.refillSponsor(ctx.hsigner, fuel, amount),
  assignmentMatches: async (ctx) => ((await (ctx.vanguard.program.account as any).assignment.all()) as any[]).map((x) => x.account.tesoroMatch as PublicKey),
  refundUntabled: (ctx, m) => ctx.vanguard.refundUntabled(ctx.hsigner, m),
  skip: async (ctx, m) => {
    const a = await ctx.vanguard.readAssignment(m);
    return a ? ctx.vanguard.skipEpoch(ctx.hsigner, a) : "";
  },
  closeAssignment: async (ctx, m) => {
    const a = await ctx.vanguard.readAssignment(m);
    return a ? ctx.vanguard.closeAssignment(ctx.hsigner, a) : "";
  },
};

export const ADAPTERS: GameAdapter[] = [duelAdapter, holdemAdapter, burstAdapter, vanguardAdapter];

/**
 * The table scheduler job: one pass for every table Game. Independent of the Match job (it shares that job's scan of the Matches
 * when both run in one pass). `--once --dry-run` prints every step it would send.
 */
export async function tablesJob(ctx: Ctx, adapters: GameAdapter[] = ADAPTERS): Promise<number> {
  const matches = await scanMatches(ctx);
  let actions = 0;
  for (const a of adapters) {
    try {
      actions += await runGame(ctx, a, gameSettings(a.id as GameId, a.env), matches);
    } catch (e) {
      log("tables", a.label, `ERROR ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`);
    }
  }
  return actions;
}
