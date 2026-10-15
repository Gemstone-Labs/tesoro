import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MatchResult, type MatchResultProps } from "./MatchResult";

const base: MatchResultProps = { game: "block-puzzle", outcome: "won", delta: 780, entry: 1000, fee: 220, role: "player", backed: false, scores: ["171", "55"], playAgainHref: "/play/queue", matchId: "7" };
const html = (over: Partial<MatchResultProps> = {}) => renderToStaticMarkup(<MatchResult {...base} {...over} />);

describe("Share your win", () => {
  it("is offered to the winner", () => {
    expect(html()).toContain("Share your win");
  });
  it("is not offered after a loss, a draw, a refund, to a Backer, or without a Match id", () => {
    for (const over of [{ outcome: "lost" as const, delta: -1000 }, { outcome: "draw" as const, delta: 0 }, { outcome: "refunded" as const, delta: 0 }, { role: "backer" as const }, { matchId: undefined }]) {
      expect(html(over)).not.toContain("Share your win");
    }
  });
});
