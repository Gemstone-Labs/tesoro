import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CANCELLING_NOTE } from "@/lib/chain/match-status";
import { MatchResult, type MatchResultProps } from "./MatchResult";
import { MatchStage } from "./MatchStage";

const result: MatchResultProps = { game: "block-puzzle", outcome: "refunded", delta: 0, entry: 500, role: "player", backed: false, playAgainHref: "/play/queue", opponent: null };

describe("refunded result reason", () => {
  it("says the Player cancelled when this page sent the cancel", () => {
    expect(renderToStaticMarkup(<MatchResult {...result} cancelled />)).toContain("You cancelled before anyone joined");
  });
  it("says nobody joined for an unpaired Match this page did not cancel", () => {
    const html = renderToStaticMarkup(<MatchResult {...result} />);
    expect(html).toContain("Nobody joined, so your entry is back");
    expect(html).not.toContain("without a result");
  });
  it("keeps the neutral line for a paired Match", () => {
    expect(renderToStaticMarkup(<MatchResult {...result} opponent="Opp" />)).toContain("ended without a result");
  });
});

describe("cancelling stage", () => {
  it("never reads as an opponent or a table", () => {
    const html = renderToStaticMarkup(<MatchStage game="block-puzzle" kind="setup" step={CANCELLING_NOTE} entry={500} pot={990} me="Me" opponent={null} />);
    expect(html).toContain("Cancelling");
    expect(html).toContain("500 Gemas are on their way back");
    expect(html).not.toMatch(/opponent found|Waiting for a table|No table opened/i);
  });
});
