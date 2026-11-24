import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { TableView } from "./chain";
import { checkPendingSkips, type PendingSkip } from "./finish";
import { StepRetry } from "./step-retry";

const key = () => Keypair.generate().publicKey;
const table = (o: Partial<TableView>): TableView => ({ phase: "idle", carNo: 0n, nextCar: 0n, ...o }) as TableView;

/** Two cars this page refunded, one on each Table. */
function page(tables: Record<number, TableView | null | Error>, receipts: Set<string>) {
  const pending = new Map<string, PendingSkip>();
  const cars = [
    { carNo: 2n, table: 0, match: key() },
    { carNo: 3n, table: 1, match: key() },
  ];
  for (const c of cars) pending.set(c.carNo.toString(), c);
  const reads = { table: 0, receipt: 0 };
  const skipped: bigint[] = [];
  const retry = new StepRetry();
  let now = 1_000_000;
  const deps = {
    pending,
    table: async (i: number) => {
      reads.table++;
      const t = tables[i];
      if (t instanceof Error) throw t;
      return t;
    },
    receipt: async (m: PublicKey) => (reads.receipt++, receipts.has(m.toBase58())),
    skip: async (p: PendingSkip) => void skipped.push(p.carNo),
    retry,
    now: () => now,
  };
  return { cars, pending, reads, skipped, deps, tick: (ms: number) => (now += ms) };
}

describe("the page's pending skips", () => {
  it("keeps one entry per car and clears each when its own Table has moved past it", async () => {
    const p = page({ 0: table({ phase: "over", carNo: 0n, nextCar: 2n }), 1: table({ phase: "idle", carNo: 1n, nextCar: 5n }) }, new Set());
    const receipts = new Set([p.cars[0].match.toBase58()]);
    p.deps.receipt = async (m) => (p.reads.receipt++, receipts.has(m.toBase58()));
    expect(await checkPendingSkips(p.deps)).toEqual({ "2": "skip", "3": "done" });
    expect([p.skipped, [...p.pending.keys()]]).toEqual([[2n], ["2"]]);
  });

  it("reads the receipt only while the Table waits for the car, and a wait is neither a success nor a failure: the next poll looks again", async () => {
    const p = page({ 0: table({ phase: "over", carNo: 0n, nextCar: 2n }), 1: null }, new Set());
    for (let i = 0; i < 4; i++) {
      expect(await checkPendingSkips(p.deps)).toEqual({ "2": "wait", "3": "wait" });
      p.tick(250);
    }
    // four polls: car 2's Table waits (four receipt reads, none landed), car 3's Table is unreadable (no receipt read at all)
    expect(p.reads).toEqual({ table: 8, receipt: 4 });
    expect(p.skipped).toEqual([]);
  });

  it("a car whose read fails waits its backoff (1 s, 2 s ...) while the other car goes on", async () => {
    const p = page({ 0: new Error("rollup down"), 1: table({ phase: "over", carNo: 1n, nextCar: 3n }) }, new Set());
    expect(await checkPendingSkips(p.deps)).toEqual({ "3": "wait" });
    p.tick(250);
    expect(await checkPendingSkips(p.deps)).toEqual({ "3": "wait" });
    expect(p.reads.table).toBe(3);
    p.tick(1_000);
    await checkPendingSkips(p.deps);
    expect(p.reads.table).toBe(5);
  });
});
