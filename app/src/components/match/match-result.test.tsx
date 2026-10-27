import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MatchResult, type MatchResultProps } from "./MatchResult";

const OPP = "6qPLGMP5pY9KXQ8PVr8V8cjiWNdy3tzfKnf85e5wQmoZ";
const base: MatchResultProps = { game: "block-puzzle", outcome: "won", delta: 440, entry: 500, fee: 60, role: "player", backed: false, scores: null, playAgainHref: "/play/queue", opponent: OPP, points: 5, matchId: "7" };
const html = (over: Partial<MatchResultProps> = {}) => renderToStaticMarkup(<MatchResult {...base} {...over} />);

describe("the result screen", () => {
  it("shows the settled gain and Fee, Season tile first", () => {
    const h = html();
    expect(h).toContain("440");
    expect(h).toMatch(/Season · \+5/);
    expect(h.indexOf("Season")).toBeLessThan(h.indexOf("Fee"));
  });
  it("shows the Season tile after a loss: 0 points and Not ranked yet", () => {
    const h = html({ outcome: "lost", delta: -500, points: 0 });
    expect(h).toMatch(/Season · \+0/);
    expect(h).toContain("Not ranked yet");
  });
  it("has exactly Play again and Add friend as actions", () => {
    const h = html();
    expect(h).toContain("Play again");
    expect(h).toContain("Add friend");
    for (const gone of ["Rematch", "Practice free", "Back to games", "Vault", "Share your win", "Losses earn no points", "Entry"]) expect(h).not.toContain(gone);
  });
  it("has no Add friend without a known opponent", () => {
    expect(html({ opponent: null, outcome: "refunded", delta: 0, fee: 0, points: 0 })).not.toContain("Add friend");
  });
});
