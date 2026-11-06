import { Keypair, TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { createFinisher, finalizeAndFinish, finishMatch, type FinishDeps, type Planned, type Progress } from "./finish-match";

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

const settling = (line: number): Progress => ({ stage: "settling", phase: 0, line });
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
    const deps: FinishDeps = {
      fetch: async () => settling(line),
      plan: async (p) => ({ kind: "chunk", ix: ix(`chunk-${p.line}`) }),
      send: async (p) => {
        line += 1;
        return `sig-${p.ix.data.toString()}`;
      },
      maxSteps: 3,
    };
    const r = await finishMatch(deps, address);
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


describe("createFinisher", () => {
  const ok = { done: true, signatures: [] };

  it("does not run again once the Match is finished", async () => {
    let calls = 0;
    const finish = createFinisher(async () => (calls++, ok));
    await finish();
    await finish();
    expect(calls).toBe(1);
  });

  it("runs one call at a time", async () => {
    let calls = 0;
    let release!: () => void;
    const finish = createFinisher(() => (calls++, new Promise((r) => (release = () => r(ok)))));
    const first = finish();
    expect(await finish()).toBeNull();
    release();
    await first;
    expect(calls).toBe(1);
  });

  it("retries a failure with a growing wait, up to the limit, then leaves it to the sweep", async () => {
    let calls = 0;
    let t = 0;
    const finish = createFinisher(
      async () => {
        calls++;
        throw new Error("rpc");
      },
      { maxAttempts: 3, now: () => t },
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await finish();
    await finish(); // too soon: still waiting out the first backoff
    expect(calls).toBe(1);
    for (let i = 0; i < 6; i++) {
      t += 60_000;
      await finish();
    }
    expect(calls).toBe(3);
  });

  it("keeps going after a step limit; a stall is retried after a wait and the reason is logged", async () => {
    const results = [{ done: false, stalled: "step-limit", signatures: [] }, { done: false, stalled: "no-run", signatures: [] }, ok];
    let calls = 0;
    let t = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const finish = createFinisher(async () => results[calls++], { now: () => t });
    await finish();
    await finish();
    await finish(); // inside the wait after the stall
    expect(calls).toBe(2);
    expect(warn.mock.calls.some((c) => String(c[1]).includes("no-run"))).toBe(true);
    t += 60_000;
    await finish();
    await finish();
    expect(calls).toBe(3);
  });

  it("gives up for good only after the attempt limit of stalls", async () => {
    let calls = 0;
    let t = 0;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const finish = createFinisher(async () => (calls++, { done: false, stalled: "no-run", signatures: [] }), { maxAttempts: 4, now: () => t });
    for (let i = 0; i < 10; i++) {
      t += 60_000;
      await finish();
    }
    expect(calls).toBe(4);
  });
});

describe("finishMatch with checkpoint pages", () => {
  it("creates the pages a chunk needs, then sends the chunk", async () => {
    const c = chain(settling(0), { steps: { "chunk-0": closed, close: null } });
    const pages = [ix("page-a"), ix("page-b")];
    let made = false;
    c.deps.plan = async (p): Promise<Planned> => (p.stage === "closed" ? { kind: "close", ix: ix("close") } : made ? { kind: "chunk", ix: ix("chunk-0") } : { kind: "pages", ixs: pages });
    c.deps.createPages = async (ixs) => {
      made = true;
      c.sent.push(ixs.map((i) => i.data.toString()).join("+"));
      return "sig-pages";
    };
    const r = await finishMatch(c.deps, address);
    expect(c.sent).toEqual(["page-a+page-b", "chunk-0", "close"]);
    expect(r).toEqual({ done: true, signatures: ["sig-pages", "sig-chunk-0", "sig-close"] });
  });

  it("stalls as needs-page when nobody can pay for pages", async () => {
    const c = chain(settling(0));
    c.deps.plan = async () => ({ kind: "pages", ixs: [ix("page-a")] });
    expect(await finishMatch(c.deps, address)).toEqual({ done: false, stage: "settling", stalled: "needs-page", signatures: [] });
  });

  it("does not loop forever when pages keep being asked for", async () => {
    const c = chain(settling(0));
    c.deps.plan = async () => ({ kind: "pages", ixs: [ix("page-a")] });
    c.deps.createPages = async () => "sig";
    c.deps.maxSteps = 3;
    expect(await finishMatch(c.deps, address)).toMatchObject({ done: false, stalled: "step-limit" });
  });
});
