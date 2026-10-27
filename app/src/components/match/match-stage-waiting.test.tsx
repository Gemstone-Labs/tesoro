import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MatchStage } from "./MatchStage";
import type { GameId } from "@/lib/mock";

describe("waiting screen copy", () => {
  for (const game of ["block-puzzle", "holdem", "trading-duel", "vanguard"] as GameId[]) {
    it(`${game} keeps the waiting headline without a paragraph`, () => {
      const html = renderToStaticMarkup(<MatchStage game={game} kind="waiting" entry={500} pot={940} me={null} opponent={null} />);
      expect(html).toContain("Waiting for an opponent");
      expect(html).not.toContain('class="stage-line"');
      expect(html).toContain("How this works");
    });
  }
  it("retains important status copy after pairing", () => {
    const html = renderToStaticMarkup(<MatchStage game="block-puzzle" kind="setup" entry={500} pot={940} me={null} opponent={null} />);
    expect(html).toContain('class="stage-line"');
    expect(html).toContain("Your pieces are drawn in secret.");
  });
});
