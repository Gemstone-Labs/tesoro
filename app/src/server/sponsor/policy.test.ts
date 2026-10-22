import { describe, expect, it } from "vitest";
import { admissionFits, admit, DEFAULT_LIMITS, exitFits, recordCycle, recordFailure, type Limits } from "./policy";
import { key } from "./fixtures";
import type { Plan } from "./rules";
import { MemoryUsageStore } from "./store";

const plan = (over: Partial<Plan> = {}): Plan => ({ kind: "core", names: ["open_match"], class: "admission", spend: { refundable: 10n, sunk: 100n }, cu: 1, obligations: [], pair: null, signers: [], playerSigns: false, funders: [], onboarding: false, invite: false, noGemas: false, ...over });
const limits = (over: Partial<Limits> = {}): Limits => ({ ...DEFAULT_LIMITS, ...over });
const DAY = 24 * 3600 * 1000;
const refusal = (p: Promise<unknown>, code: string) => expect(p).rejects.toMatchObject({ code });

describe("admission limits", () => {
  it("per Account per day, then a new day", async () => {
    const s = new MemoryUsageStore();
    const l = limits({ accountPerDay: 2 });
    await admit(s, l, plan(), "a", 0);
    await admit(s, l, plan(), "a", 1);
    await refusal(admit(s, l, plan(), "a", 2), "account-limit");
    await admit(s, l, plan(), "b", 2);
    await admit(s, l, plan(), "a", DAY + 5);
  });
  it("per pair, whoever opens it", async () => {
    const s = new MemoryUsageStore();
    const l = limits({ pairPerDay: 1 });
    const pair = key();
    await admit(s, l, plan({ pair }), "a", 0);
    await refusal(admit(s, l, plan({ pair }), "b", 1), "pair-limit");
    await admit(s, l, plan({ pair: key() }), "b", 1);
  });
  it("across all Accounts per day", async () => {
    const s = new MemoryUsageStore();
    const l = limits({ globalPerDay: 2 });
    await admit(s, l, plan(), "a", 0);
    await admit(s, l, plan(), "b", 0);
    await refusal(admit(s, l, plan(), "c", 0), "global-limit");
  });
  it("in total: what an Account costs for good, however long ago", async () => {
    const s = new MemoryUsageStore();
    const l = limits({ accountSunkTotal: 250 });
    await admit(s, l, plan(), "a", 0);
    await admit(s, l, plan(), "a", 0);
    await refusal(admit(s, l, plan(), "a", 400 * DAY), "total-limit");
  });
  it("a refusal gives back what the earlier limits took", async () => {
    const s = new MemoryUsageStore();
    const l = limits({ accountPerDay: 5, globalPerDay: 1 });
    await admit(s, l, plan(), "a", 0);
    await refusal(admit(s, l, plan(), "b", 1), "global-limit");
    expect(await s.used("acct:b", DAY, 1)).toBe(0);
  });
  it("undo gives the quota back when the transaction was never sent", async () => {
    const s = new MemoryUsageStore();
    const l = limits({ accountPerDay: 1 });
    const a = await admit(s, l, plan(), "a", 0);
    await a.undo();
    await admit(s, l, plan(), "a", 1);
  });
  it("failures and cancel cycles stop further admissions, not exits", async () => {
    const s = new MemoryUsageStore();
    const l = limits({ failuresPerDay: 2, cyclesPerDay: 1 });
    await recordFailure(s, "a", 0);
    await admit(s, l, plan(), "a", 1);
    await recordFailure(s, "a", 2);
    await refusal(admit(s, l, plan(), "a", 3), "too-many-failures");
    await recordCycle(s, "b", 0);
    await refusal(admit(s, l, plan(), "b", 1), "too-many-cycles");
    await admit(s, l, plan(), "c", 1);
  });
});

describe("the balance", () => {
  const l = limits({ floor: 1_000n });
  it("an admission leaves the floor and every exit hold alone", () => {
    expect(admissionFits(l, { lamports: 10_000n, held: 4_000n }, 4_000n, 1_000n)).toBe(true);
    expect(admissionFits(l, { lamports: 10_000n, held: 4_000n }, 4_001n, 1_000n)).toBe(false);
  });
  it("an exit only needs its fee, even when the holds exceed the balance", () => {
    expect(exitFits({ lamports: 6_000n, held: 90_000n }, 5_000n)).toBe(true);
    expect(exitFits({ lamports: 4_999n, held: 0n }, 5_000n)).toBe(false);
  });
});

describe("the exit hold ledger", () => {
  it("holds once per obligation and frees it", async () => {
    const s = new MemoryUsageStore();
    expect(await s.hold("m1", 300n)).toBe(true);
    expect(await s.hold("m1", 300n)).toBe(false);
    await s.hold("m2", 200n);
    expect(await s.held()).toBe(500n);
    expect(await s.release("m1")).toBe(300n);
    expect(await s.release("m1")).toBe(0n);
    expect(await s.held()).toBe(200n);
  });
});
