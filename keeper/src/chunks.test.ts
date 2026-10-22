import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair } from "@solana/web3.js";
import { creditedAccounts, phaseOf, runOf, sourcesAhead, type RunFacts } from "./chunks.ts";
import { storeBytes } from "./fixtures.ts";
import { decodeStore } from "./kit.ts";

const src = Array.from({ length: 6 }, () => Keypair.generate().publicKey);
const pot = (amounts: [number, number][]) => decodeStore(storeBytes(amounts.map(([s, a]) => ({ source: src[s], amount: BigInt(a) }))));
const names = (a: { source: { toBase58(): string }; cut: boolean }[]) => a.map((x) => `${src.findIndex((s) => s.toBase58() === x.source.toBase58())}${x.cut ? "c" : ""}`);

describe("phases of a run", () => {
  it("reads the IDL's enum shapes", () => {
    assert.deepEqual(phaseOf({ cuts: [1] }), { kind: "cuts", side: 1 });
    assert.deepEqual(phaseOf({ back: { "0": 0 } }), { kind: "back", side: 0 });
    assert.deepEqual(phaseOf({ surplus: { from: 1, to: 0 } }), { kind: "surplus", from: 1, to: 0 });
    assert.throws(() => phaseOf({ nope: [1] }));
  });
  it("reads a decoded Run, keeping only the phases in use", () => {
    const r = runOf({ phases: [{ cuts: [1] }, { back: [0] }, { back: [0] }, { back: [0] }], nPhases: 2, phaseI: 1, lineI: 3, cutLeft: [[{ toString: () => "0" }], [{ toString: () => "7" }]].map((x) => x) });
    assert.equal(r!.phases.length, 2);
    assert.deepEqual([r!.phaseI, r!.lineI, r!.cutLeft[1][0]], [1, 3, 7n]);
    assert.equal(runOf(null), null);
  });
});

describe("sources ahead", () => {
  const run = (over: Partial<RunFacts>): RunFacts => ({ phases: [], phaseI: 0, lineI: 0, cutLeft: [[0n, 0n, 0n], [0n, 0n, 0n]], ...over });

  it("walks the fee cuts across the lines of the loser's Pot, a partly cut line first", () => {
    // The loser (side 1) owes 12 + 3 of fees; line 0 has 10, so the first cut spans two lines and the second stays on line 1.
    const p1 = pot([[0, 10], [1, 20], [2, 5]]);
    const r = run({ phases: [{ kind: "cuts", side: 1 }, { kind: "back", side: 0 }], cutLeft: [[0n, 0n, 0n], [12n, 3n, 0n]] });
    assert.deepEqual(names(sourcesAhead(r, [null, p1], 10)), ["0c", "1c"]);
    assert.deepEqual(names(sourcesAhead(r, [null, p1], 1)), ["0c"], "only as many steps as asked for");
  });
  it("walks Back and Surplus lines in order, skipping emptied ones, and counts a step per line", () => {
    const p0 = pot([[0, 5], [1, 0], [2, 7], [3, 1]]);
    const r = run({ phases: [{ kind: "back", side: 0 }] });
    assert.deepEqual(names(sourcesAhead(r, [p0, null], 2)), ["0", "2"]);
    assert.deepEqual(names(sourcesAhead(r, [p0, null], 99)), ["0", "2", "3"]);
  });
  it("resumes from the cursor and carries on into the next phase when the pot is done", () => {
    const p0 = pot([[0, 5], [1, 5]]);
    const p1 = pot([[2, 5]]);
    const r = run({ phases: [{ kind: "back", side: 0 }, { kind: "surplus", from: 1, to: 0 }], lineI: 1 });
    assert.deepEqual(names(sourcesAhead(r, [p0, p1], 5)), ["1", "2"]);
  });
  it("lists a Source once, cut if any step cuts from it", () => {
    const p1 = pot([[0, 4], [0, 4], [1, 4]]);
    const r = run({ phases: [{ kind: "cuts", side: 1 }, { kind: "back", side: 1 }], cutLeft: [[0n, 0n, 0n], [5n, 0n, 0n]] });
    assert.deepEqual(names(sourcesAhead(r, [null, p1], 10)), ["0c", "1"]);
  });
  it("stops at a cut it cannot finish with the steps left, and does nothing for a finished run", () => {
    const p1 = pot([[0, 100]]);
    const r = run({ phases: [{ kind: "cuts", side: 1 }, { kind: "back", side: 0 }], cutLeft: [[0n, 0n, 0n], [10n, 0n, 0n]] });
    assert.deepEqual(names(sourcesAhead(r, [pot([[4, 1]]), p1], 3)), ["0c", "4"], "the cut takes one step, then the Back phase starts");
    assert.deepEqual(names(sourcesAhead(r, [pot([[4, 1]]), p1], 1)), ["0c"]);
    const slow = run({ phases: [{ kind: "cuts", side: 1 }, { kind: "back", side: 0 }], cutLeft: [[0n, 0n, 0n], [150n, 0n, 0n]] });
    assert.deepEqual(names(sourcesAhead(slow, [pot([[4, 1]]), p1], 3)), ["0c"], "the cut is not finished: nothing after it");
    assert.deepEqual(sourcesAhead(run({ phases: [], phaseI: 0 }), [null, null], 5), []);
  });
});

describe("credited Accounts", () => {
  it("lists each Player, Backer and outside Studio once", () => {
    const [a, b, c, d] = [0, 1, 2, 3].map(() => Keypair.generate().publicKey);
    const rec = { a: { player: a, funder: b }, b: { player: c, funder: c }, terms: { studioOwner: d } };
    assert.deepEqual(creditedAccounts(rec, (x) => x).map((k) => k.toBase58()), [a, b, c, d].map((k) => k.toBase58()));
    assert.equal(creditedAccounts({ a: { player: a, funder: a }, b: null, terms: {} }, (x) => x).length, 1);
  });
});
