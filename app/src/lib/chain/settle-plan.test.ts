import { describe, expect, it } from "vitest";
import { Keypair, TransactionInstruction } from "@solana/web3.js";
import { CHUNK_CU_TARGET, sizeByCompute, unitsOf } from "./settle-plan";

const ix = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.alloc(0) });

/** A chunk whose compute is `base` to load plus `perStep` a step (the shape the LiteSVM measurements show). */
function chunks(base: number, perStep: number, most: number) {
  const tried: number[] = [];
  const plan = async (steps: number) => {
    tried.push(steps);
    return { ix, steps: Math.min(steps, most), units: base + perStep * Math.min(steps, most) };
  };
  return { tried, plan, units: (steps: number) => base + perStep * steps };
}

describe("sizing a chunk to the compute target", () => {
  it("a 7-step many-seat chunk of staking-token fee cuts (247k) takes fewer steps until it is under 125k", async () => {
    // Railcar ticket 19, 100 seats with jitoSOL Positions: about 40k to load and 30k a step.
    const c = chunks(40_000, 30_000, 7);
    const log: string[] = [];
    const sized = await sizeByCompute(7, c.plan, async () => c.units(c.tried.at(-1)!), (m) => log.push(m));
    expect(sized!.steps).toBe(2);
    expect(c.units(sized!.steps)).toBeLessThanOrEqual(CHUNK_CU_TARGET);
    expect(c.tried).toEqual([7, 3, 2]);
    expect(log).toHaveLength(2);
  });

  it("a chunk under the target goes as planned, simulated once", async () => {
    const c = chunks(40_000, 10_000, 7);
    let simulated = 0;
    const sized = await sizeByCompute(7, c.plan, async () => (simulated++, c.units(7)));
    expect([sized!.steps, simulated]).toEqual([7, 1]);
  });

  it("without a simulator, or when it cannot measure, the chunk goes as planned", async () => {
    expect((await sizeByCompute(7, chunks(40_000, 30_000, 7).plan))!.steps).toBe(7);
    expect((await sizeByCompute(7, chunks(40_000, 30_000, 7).plan, async () => null))!.steps).toBe(7);
  });

  it("one step over the target still goes: nothing smaller exists", async () => {
    const log: string[] = [];
    const sized = await sizeByCompute(7, chunks(40_000, 200_000, 7).plan, async () => 900_000, (m) => log.push(m));
    expect(sized!.steps).toBe(1);
    expect(log.at(-1)).toMatch(/^WARN a one-step chunk/);
  });

  it("nothing left to plan: no chunk", async () => {
    expect(await sizeByCompute(7, async () => null, async () => 1)).toBeNull();
  });
});

describe("the compute a simulation reports", () => {
  it("is unknown when the simulation failed: a chunk that fails early uses little and must not look small", () => {
    expect(unitsOf({ err: { InstructionError: [0, { Custom: 6402 }] }, unitsConsumed: 3_100 })).toBeNull();
    expect(unitsOf({ err: null, unitsConsumed: 118_400 })).toBe(118_400);
    expect(unitsOf({ err: null })).toBeNull();
  });
});
