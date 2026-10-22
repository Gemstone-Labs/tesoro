import type { Duel } from "@/games/trading-duel/chain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FinishedDuel } from "./DuelSpectate";
import { EndStateLine } from "./EndStateNote";

const duel = { scores: [7, 3], revealed: [[1, 2, 255], [255, 255, 255]] };
const sides: [string, string] = ["AAAA…aaaa", "BBBB…bbbb"];
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const none = { status: "none" } as const;
const loading = { status: "loading" } as const;

describe("a finished Match's board", () => {
  it("shows the table's copy while it still holds the Match", () => {
    expect(html(<FinishedDuel symbol="SOL" sides={sides} duel={duel as unknown as Duel} chainDone end={loading} />)).toContain("7 points");
  });
  it("falls back to the history once the table moved on", () => {
    const state = { game: "trading-duel" as const, track: { lo: [], hi: [], seen: [] }, picks: [[1, 255], [4, 5]] as [number[], number[]], scores: [2, 9] as [number, number], winner: 1 };
    expect(html(<FinishedDuel symbol="SOL" sides={sides} duel={null} chainDone end={{ status: "found", state }} />)).toContain("9 points");
  });
  it("loads only while a read is in flight, then says the board is gone", () => {
    expect(html(<FinishedDuel symbol="SOL" sides={sides} duel={null} chainDone={false} end={loading} />)).toContain("Loading the result");
    const done = html(<FinishedDuel symbol="SOL" sides={sides} duel={null} chainDone end={none} />);
    expect(done).not.toContain("Loading");
    expect(done).toContain("no longer available");
  });
  it("Hold'em and Block Burst lines end the same way", () => {
    expect(html(<EndStateLine end={none} />)).toContain("no longer available");
    expect(html(<EndStateLine end={{ status: "found", state: { game: "block-puzzle", scores: [10, 20], moves: [3, 4], reason: 1, log: null } }} />)).toContain("10 (3 moves) against 20");
    expect(html(<EndStateLine end={{ status: "found", state: { game: "holdem", handNo: 4, result: 1, pot: "100", board: [0, 1, 2], shown: null, stacks: ["1", "2"], winner: 1 } }} />)).toContain("Nobody showed their hand");
  });
});
