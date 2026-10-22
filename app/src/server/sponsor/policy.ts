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
  /**
   * Failed transactions per day after which an Account's exits are no longer sponsored (it pays its own fee). Exits have
   * no other quota, so this is what stops someone from burning the relayer's SOL on exits that fail on chain; it is far
   * above what a Player who is not attacking ever reaches.
   */
  exitFailuresPerDay: number;
  /** Exits that undo an admission (cancel, refund) per day, before admissions stop. */
  cyclesPerDay: number;
  /** Calls to build a sponsored transaction per Account per day, whatever they are (stops build spam on exits). */
  buildsPerDay: number;
  /** Lamports held per obligation to pay for its exits. */
  completionReserve: bigint;
  /** The balance admissions must leave alone, on top of the exit holds. */
  floor: bigint;
  /** Sponsored new Accounts per signed-in user (Privy user id), ever (ticket 18c; the founder may change the gate). */
  onboardPerUser: number;
  /** Sponsored new Accounts across all users per day. */
  onboardPerDay: number;
  /** The day's count at which the relayer's operators are mailed (once a day). */
  onboardAlertAt: number;
}

export const DEFAULT_LIMITS: Limits = {
  accountPerDay: 60,
  pairPerDay: 10,
  globalPerDay: 20_000,
  accountSunkTotal: 50_000_000,
  failuresPerDay: 20,
  exitFailuresPerDay: 50,
  cyclesPerDay: 20,
  buildsPerDay: 2_000,
  completionReserve: 300_000n,
  floor: 500_000_000n,
  onboardPerUser: 1,
  onboardPerDay: 500,
  onboardAlertAt: 400,
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
  /** One sponsored Account per user: the Privy user id, or the address where there is no Privy (local dev). */
  onboardUser: (u: string) => `onboard-user:${u}`,
  onboardDay: () => "onboard-day",
  onboardAlert: () => "onboard-alert",
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

export const onboardUserOf = (sub: string | null, address: string) => k.onboardUser(sub ?? `addr:${address}`);

/** Refuses (before anything is built) a user who already had a sponsored Account, or a day past the cap. Takes nothing. */
export async function checkOnboarding(store: UsageStore, limits: Limits, userKey: string, now: number): Promise<void> {
  if ((await store.used(userKey, LIFETIME, now)) >= limits.onboardPerUser) throw new RuleError("account-limit", "You already got a free Account. Add some SOL to create another.");
  if ((await store.used(k.onboardDay(), DAY, now)) >= limits.onboardPerDay) throw new RuleError("global-limit", "New free Accounts are paused for today.");
}

/** Takes the user's slot and the day's, at submit time so a build that is never sent costs nothing. Returns what to give back. */
export async function takeOnboarding(store: UsageStore, limits: Limits, userKey: string, now: number): Promise<() => Promise<void>> {
  if (!(await store.take(userKey, 1, limits.onboardPerUser, LIFETIME, now))) throw new RuleError("account-limit", "You already got a free Account. Add some SOL to create another.");
  if (!(await store.take(k.onboardDay(), 1, limits.onboardPerDay, DAY, now))) {
    await store.refund(userKey, 1, now);
    throw new RuleError("global-limit", "New free Accounts are paused for today.");
  }
  return async () => {
    await store.refund(userKey, 1, now);
    await store.refund(k.onboardDay(), 1, now);
  };
}

/** True once per day, when the day's sponsored Accounts reach the alert level. */
export async function onboardingAlertDue(store: UsageStore, limits: Limits, now: number): Promise<number | null> {
  const used = await store.used(k.onboardDay(), DAY, now);
  if (used < limits.onboardAlertAt) return null;
  return (await store.take(k.onboardAlert(), 1, 1, DAY, now)) ? used : null;
}

/** Whether `player` has failed too many transactions today to be sponsored on exits. */
export async function exitsBlocked(store: UsageStore, limits: Limits, player: string, now: number): Promise<boolean> {
  return (await store.used(k.fail(player), DAY, now)) >= limits.exitFailuresPerDay;
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
