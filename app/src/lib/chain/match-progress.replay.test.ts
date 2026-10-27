import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { matchProgress, stageRank } from "./match-progress";

type Step = { stage: string; note?: string };
type Sequence = { source: "recorded" | "synthetic"; note: string; game: string; steps: Step[]; /** false: the recording never proposed a step back (the default is true: the sequence is a test of the hold). */ stepsBack?: boolean };

const DIR = join(__dirname, "match-sequences");
const sequences = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ file: f, seq: JSON.parse(readFileSync(join(DIR, f), "utf8")) as Sequence }));

const rankOf = (s: Step) => stageRank(s.stage, s.note) ?? 0;

describe("a Match page replaying the stages its reads proposed", () => {
  it("covers every game", () => {
    expect(new Set(sequences.map((s) => s.seq.game))).toEqual(new Set(["block-puzzle", "holdem", "trading-duel", "vanguard"]));
  });

  for (const { file, seq } of sequences) {
    describe(`${file} (${seq.source})`, () => {
      const p = matchProgress<object, string>("m");
      const shown = seq.steps.map((s) => p.stage(s.stage, s.note));

      it("says truly whether it proposed a step back (most do, so the hold is exercised)", () => {
        const ranks = seq.steps.map(rankOf);
        expect(ranks.some((r, i) => i > 0 && r < Math.max(...ranks.slice(0, i)))).toBe(seq.stepsBack ?? true);
      });

      it("never shows an earlier stage than one already shown", () => {
        const ranks = shown.map((s) => stageRank(s.stage, s.note) ?? 0);
        expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      });

      it("never shows 'not found' once the Match was seen", () => {
        const first = shown.findIndex((s) => s.stage !== "notfound" && stageRank(s.stage, s.note) !== null);
        expect(shown.slice(first).some((s) => s.stage === "notfound")).toBe(false);
      });

      it("ends on the result", () => {
        expect(shown.at(-1)?.stage).toBe("settled");
      });
    });
  }
});
