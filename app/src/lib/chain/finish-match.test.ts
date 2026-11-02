import { Keypair, TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { finalizeAndFinish, finishMatch, type FinishDeps, type Planned, type Progress } from "./finish-match";

const address = Keypair.generate().publicKey;
const ix = (tag: string) => new TransactionInstruction({ programId: address, keys: [], data: Buffer.from(tag) });

type Snap = Progress | null;

/**
 * A fake chain: `world` is what a fetch sees. `plan` decides the next step from it; `send` applies the step to the world,
 * or throws as the test says. `other` runs between a send and the next fetch, to play another actor.
 */
function chain(start: Snap, o: { steps?: Record<string, Snap>; failOn?: string; actor?: Record<string, Snap> } = {}) {
  let world: Snap = start;
  const sent: string[] = [];
  const deps: FinishDeps = {
    fetch: async () => world,
    plan: async (p): Promise<Planned> => (p.stage === "closed" ? { kind: "close", ix: ix("close") } : { kind: "chunk", ix: ix(`chunk-${p.line}`) }),
    send: async (planned) => {
      const tag = planned.ix.data.toString();
      if (o.actor?.[tag] !== undefined) world = o.actor[tag];
      if (o.failOn === tag) throw new Error(`failed ${tag}`);
      sent.push(tag);
      world = o.steps?.[tag] !== undefined ? o.steps[tag] : world;
      return `sig-${tag}`;
    },
  };
  return { deps, sent, get world() { return world; } };
}

const settling = (line: number): Snap => ({ stage: "settling", phase: 0, line });
const closed: Snap = { stage: "closed", phase: 2, line: 0 };

describe("finishMatch", () => {
  it("runs chunks until the run is done, then closes the Match", async () => {
    const c = chain(settling(0), { steps: { "chunk-0": settling(6), "chunk-6": closed, close: null } });
    const r = await finishMatch(c.deps, address);
    expect(c.sent).toEqual(["chunk-0", "chunk-6", "close"]);
    expect(r).toEqual({ done: true, signatures: ["sig-chunk-0", "sig-chunk-6", "sig-close"] });
  });

  it("does nothing for a Match another actor already closed", async () => {
    const c = chain(null);
    expect(await finishMatch(c.deps, address)).toEqual({ done: true, signatures: [] });
    expect(c.sent).toEqual([]);
  });

  it("leaves an Open or Active Match alone: no result is committed yet", async () => {
    const c = chain({ stage: "active", phase: 0, line: 0 });
    expect(await finishMatch(c.deps, address)).toEqual({ done: false, stage: "active", signatures: [] });
    expect(c.sent).toEqual([]);
  });

  it("moves on without an error when someone else sent the same chunk first", async () => {
    // Our chunk fails because the other actor's chunk landed (the Match is further along).
    const c = chain(settling(0), { failOn: "chunk-0", actor: { "chunk-0": closed }, steps: { close: null } });
    const r = await finishMatch(c.deps, address);
    expect(r.done).toBe(true);
    expect(c.sent).toEqual(["close"]);
  });

  it("moves on without an error when someone else closed the Match first", async () => {
    const c = chain(closed, { failOn: "close", actor: { close: null } });
    expect(await finishMatch(c.deps, address)).toEqual({ done: true, signatures: [] });
  });

  it("throws a failure that changed nothing, so a broken step is not hidden", async () => {
    const c = chain(settling(0), { failOn: "chunk-0" });
    await expect(finishMatch(c.deps, address)).rejects.toThrow("failed chunk-0");
  });

  it("stops with the reason when the planner cannot build the step", async () => {
    const c = chain(settling(0));
    c.deps.plan = async () => ({ kind: "stalled", reason: "missing-book" });
    expect(await finishMatch(c.deps, address)).toEqual({ done: false, stage: "settling", stalled: "missing-book", signatures: [] });
  });

  it("stops when a sent chunk moved nothing, instead of looping", async () => {
    const c = chain(settling(0));
    const r = await finishMatch(c.deps, address);
    expect(r).toMatchObject({ done: false, stalled: "no-progress" });
    expect(c.sent).toEqual(["chunk-0"]);
  });

  it("stops after the step limit", async () => {
    let line = 0;
    const c = chain(settling(0));
    c.deps.send = async (p) => {
      line += 1;
      c.deps.fetch = async () => settling(line);
      return `sig-${p.ix.data.toString()}-${line}`;
    };
    const r = await finishMatch({ ...c.deps, maxSteps: 3 }, address);
    expect(r).toMatchObject({ done: false, stalled: "step-limit" });
    expect(r.signatures).toHaveLength(3);
  });
});

describe("finalizeAndFinish", () => {
  it("finalizes, then finishes the Match", async () => {
    const c = chain(settling(0), { steps: { "chunk-0": closed, close: null } });
    const calls: string[] = [];
    const r = await finalizeAndFinish(c.deps, address, async () => {
      calls.push("finalize");
      return "sig-finalize";
    });
    expect(calls).toEqual(["finalize"]);
    expect(r.signatures).toEqual(["sig-finalize", "sig-chunk-0", "sig-close"]);
  });

  it("goes on without an error when someone else finalized first", async () => {
    const c = chain(settling(0), { steps: { "chunk-0": closed, close: null } });
    const r = await finalizeAndFinish(c.deps, address, async () => {
      throw new Error("the Match is already finalized");
    });
    expect(r.done).toBe(true);
    expect(r.signatures).toEqual(["sig-chunk-0", "sig-close"]);
  });

  it("goes on when the Match is already closed away", async () => {
    const c = chain(null);
    const r = await finalizeAndFinish(c.deps, address, async () => {
      throw new Error("account does not exist");
    });
    expect(r).toEqual({ done: true, signatures: [] });
  });

  it("throws a finalize failure when the Match did not move on", async () => {
    const c = chain({ stage: "active", phase: 0, line: 0 });
    await expect(finalizeAndFinish(c.deps, address, async () => { throw new Error("rpc down"); })).rejects.toThrow("rpc down");
  });
});

