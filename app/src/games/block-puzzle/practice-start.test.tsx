import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BlockPuzzleGame, type MatchRun } from "./BlockPuzzleGame";

describe("Block Burst practice", () => {
  it("opens on the board with no rules card or Start button (it counts 3-2-1 by itself)", () => {
    const html = renderToStaticMarkup(<BlockPuzzleGame />);
    expect(html).toContain("bpx");
    expect(html).not.toContain("Start practice");
    expect(html).not.toContain("bp-rules");
  });

  it("retains the main Match caller contract and footer without an Account provider", () => {
    const reported: string[] = [];
    const run: MatchRun = {
      seed: 22n,
      startedAt: 1000,
      entry: 25,
      onMove: () => { reported.push("move"); },
      onEnd: () => { reported.push("end"); },
    };
    const html = renderToStaticMarkup(<BlockPuzzleGame run={run} matchPanel={<span>Waiting for opponent</span>} />);
    expect(html).toContain("Waiting for opponent");
    expect(html).toContain('Entry <b class="tnum">25</b>');
    expect(html).toContain('Pot <b class="tnum">50</b>');
    expect(html).toContain('class="mono bpx-seed"');
    expect(html).toContain('class="bp-ready-grid"');
    expect(html).toContain('class="bp-clear-grid"');
    expect(html).not.toContain("Test vibration");
    expect(reported).toEqual([]);
  });
});
