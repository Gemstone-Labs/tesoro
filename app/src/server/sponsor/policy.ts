/**
 * What the relayer is willing to spend, and on whom. Admissions (new Tickets, Matches, growth) are limited per Account,
 * per Account pair, per day and in total, and failed transactions and repeated cycles count against the Account. Exits
 * (settle and refund chunks, Ticket cancel and expiry, close, Redeem) are never limited by any of this: they are
 * authorised by the obligation, and their fees come out of the balance the admissions had to leave untouched.
 *
 * The numbers are starting values; the founder sets the final ones before mainnet (spec "Open", sponsor limits).
 */
import { RuleError, type Plan } from "./rules";
import type { UsageStore } from "./store";

const DAY = 24 * 60 * 60 * 1000;
const LIFETIME = 100 * 365 * DAY;

export interface Limits {
  /** Admissions an Account may start per day. */
  accountPerDay: number;
  /** Matches one pair of Accounts may start per day (join_match). */
  pairPerDay: number;
  /** Admissions across all Accounts per day. */
  globalPerDay: number;
  /** Lamports an Account may cost the relayer for good, over its lifetime. */
  accountSunkTotal: number;
  /** Transactions of an Account that failed, per day, before admissions stop. */
  failuresPerDay: number;
  /** Exits that undo an admission (cancel, refund) per day, before admissions stop. */
  cyclesPerDay: number;
  /** Calls to build a sponsored transaction per Account per day, whatever they are (stops build spam on exits). */
  buildsPerDay: number;
  /** Lamports held per obligation to pay for its exits. */
  completionReserve: bigint;
  /** The balance admissions must leave alone, on top of the exit holds. */
  floor: bigint;
}

export const DEFAULT_LIMITS: Limits = {
  accountPerDay: 60,
  pairPerDay: 10,
  globalPerDay: 20_000,
  accountSunkTotal: 50_000_000,
  failuresPerDay: 20,
  cyclesPerDay: 20,
  buildsPerDay: 2_000,
  completionReserve: 300_000n,
  floor: 500_000_000n,
};

export interface Clock {
  now: number;
}

const k = {
  account: (a: string) => `acct:${a}`,
  pair: (p: string) => `pair:${p}`,
  global: () => "global",
  sunk: (a: string) => `sunk:${a}`,
  fail: (a: string) => `fail:${a}`,
  cycle: (a: string) => `cycle:${a}`,
};

export interface Admission {
  /** Gives back the quota when the transaction was never sent. */
  undo(): Promise<void>;
}

/** Takes the quota for an admission or throws a RuleError that says which limit stopped it. */
export async function admit(store: UsageStore, limits: Limits, plan: Plan, player: string, now: number): Promise<Admission> {
  const taken: [string, number][] = [];
  const undo = async () => {
    for (const [key, cost] of taken) await store.refund(key, cost, now);
  };
  const take = async (key: string, cost: number, max: number, window: number, code: string, msg: string) => {
    if (cost === 0) return;
    if (!(await store.take(key, cost, max, window, now))) {
      await undo();
      throw new RuleError(code, msg);
    }
    taken.push([key, cost]);
  };
  if ((await store.used(k.fail(player), DAY, now)) >= limits.failuresPerDay) throw new RuleError("too-many-failures", "Too many failed transactions today. Try again tomorrow.");
  if ((await store.used(k.cycle(player), DAY, now)) >= limits.cyclesPerDay) throw new RuleError("too-many-cycles", "Too many cancelled entries today. Try again tomorrow.");
  await take(k.account(player), 1, limits.accountPerDay, DAY, "account-limit", "Today's limit for free transactions is used up for this Account.");
  if (plan.pair) await take(k.pair(plan.pair.toBase58()), 1, limits.pairPerDay, DAY, "pair-limit", "These two Accounts have played enough Matches today.");
  await take(k.global(), 1, limits.globalPerDay, DAY, "global-limit", "Free transactions are paused for today.");
  const sunk = Number(plan.spend.sunk);
  await take(k.sunk(player), sunk, limits.accountSunkTotal, LIFETIME, "total-limit", "This Account has used all the free transactions it gets.");
  return { undo };
}

/** A transaction of `player` failed after it was admitted. */
export const recordFailure = (store: UsageStore, player: string, now: number) => store.add(k.fail(player), 1, DAY, now);
/** `player` undid an admission (a cancelled Ticket, a refunded Match). */
export const recordCycle = (store: UsageStore, player: string, now: number) => store.add(k.cycle(player), 1, DAY, now);

export interface Balance {
  /** Spendable lamports in the relayer account. */
  lamports: bigint;
  /** Held for exits right now. */
  held: bigint;
}

/** Whether an admission that can cost `plan.spend` plus `reserve` more may go ahead, keeping the floor and every exit hold. */
export function admissionFits(limits: Limits, b: Balance, fronted: bigint, reserve: bigint): boolean {
  return b.lamports - b.held - limits.floor >= fronted + reserve;
}

/** Exits need only the fee: the floor and the holds exist so that this is always true. */
export function exitFits(b: Balance, fee: bigint): boolean {
  return b.lamports >= fee;
}
