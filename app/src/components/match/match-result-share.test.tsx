import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MatchResult, type MatchResultProps } from "./MatchResult";

const base: MatchResultProps = { game: "block-puzzle", outcome: "won", delta: 780, entry: 1000, fee: 220, role: "player", backed: false, scores: ["171", "55"], playAgainHref: "/play/queue", matchId: "7", opponent: "6qPLGMP5pY9KXQ8PVr8V8cjiWNdy3tzfKnf85e5wQmoZ" };
const html = (over: Partial<MatchResultProps> = {}) => renderToStaticMarkup(<MatchResult {...base} {...over} />);

describe("Share your win", () => {
  it("is offered to the winner, inside the outcome card", () => {
    const h = html();
    const poster = h.slice(h.indexOf("mr-poster"), h.indexOf("mr-tiles"));
    expect(poster).toContain("Share your win");
  });
  it("is not in the actions row, which stays Play again and Add friend", () => {
    const h = html();
    const actions = h.slice(h.indexOf("mr-actions"));
    expect(actions).not.toContain("Share your win");
    expect(actions).toContain("Play again");
    expect(actions).toContain("Add friend");
  });
  it("is not offered after a loss, a draw, a refund, to a Backer, or without a Match id", () => {
    for (const over of [{ outcome: "lost" as const, delta: -1000 }, { outcome: "draw" as const, delta: 0 }, { outcome: "refunded" as const, delta: 0 }, { role: "backer" as const }, { matchId: undefined }]) {
      expect(html(over)).not.toContain("Share your win");
    }
  });
});
