import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
const lb = vi.hoisted(() => ({ value: { data: null, forMe: false, error: false } as { data: unknown; forMe: boolean; error: boolean } }));
vi.mock("@/lib/chain/useLeaderboard", () => ({ useLeaderboard: () => ({ ...lb.value, retry: () => undefined }) }));
vi.mock("@/lib/account", async (orig) => ({ ...(await orig<typeof import("@/lib/account")>()), useAccount: () => ({ auth: { status: "signed-in", addresses: { solana: "6qPLGMP5pY9KXQ8PVr8V8cjiWNdy3tzfKnf85e5wQmoZ" } }, snapshot: null }) }));
import { MatchResult, type MatchResultProps } from "./MatchResult";

const OPP = "6qPLGMP5pY9KXQ8PVr8V8cjiWNdy3tzfKnf85e5wQmoZ";
const base: MatchResultProps = { game: "block-puzzle", outcome: "won", delta: 440, entry: 500, fee: 60, role: "player", backed: false, playAgainHref: "/play/queue", opponent: OPP, points: 5, matchId: "7" };
const html = (over: Partial<MatchResultProps> = {}) => renderToStaticMarkup(<MatchResult {...base} {...over} />);

describe("the result screen", () => {
  it("shows no scores, even when a caller still passes them (founder 2026-10-29)", () => {
    const old = { ...base, scores: ["171", "55"] };
    const h = renderToStaticMarkup(<MatchResult {...old} />);
    expect(h).not.toContain(">Opponent<");
    expect(h).not.toContain(">You<");
    expect(h).not.toContain("171");
  });
  it("says nothing under a loss beyond the result itself", () => {
    expect(html({ outcome: "lost", delta: -500, points: 0 })).not.toContain("Your entry went to the winner");
  });
  it("shows the settled gain and Fee, Season tile first", () => {
    const h = html();
    expect(h).toContain("440");
    expect(h).toMatch(/Season · \+5/);
    expect(h.indexOf("Season")).toBeLessThan(h.indexOf("Fee"));
  });
  it("shows the Season tile after a loss: 0 points and Not ranked yet once the Leaderboard is read", () => {
    lb.value = { data: { feeBps: 0, rows: [] }, forMe: true, error: false };
    const h = html({ outcome: "lost", delta: -500, points: 0 });
    expect(h).toMatch(/Season · \+0/);
    expect(h).toContain("Not ranked yet");
    lb.value = { data: null, forMe: false, error: false };
  });
  it("keeps the rank blank while the Leaderboard loads, never Not ranked yet", () => {
    const h = html({ outcome: "lost", delta: -500, points: 0 });
    expect(h).not.toContain("Not ranked yet");
    expect(h).toContain("aria-busy");
  });
  it("shows no Season points after a win until the history has them, instead of a guess the cap may change", () => {
    const h = html({ points: undefined });
    expect(h).not.toMatch(/Season · \+/);
    expect(h).toContain("Season");
  });
  it("shows no Fee tile when the Fee is unknown (a draw or refund without the settled amount)", () => {
    const h = html({ outcome: "refunded", delta: 0, fee: null, points: 0 });
    expect(h).not.toContain(">Fee<");
    expect(html()).toContain(">Fee<");
  });
  it("has exactly Play again and Add friend as actions", () => {
    const h = html();
    expect(h).toContain("Play again");
    expect(h).toContain("Add friend");
    for (const gone of ["Rematch", "Practice free", "Back to games", "Vault", "Losses earn no points", "Entry"]) expect(h).not.toContain(gone);
  });
  it("has no Add friend without a known opponent", () => {
    expect(html({ opponent: null, outcome: "refunded", delta: 0, fee: null, points: 0 })).not.toContain("Add friend");
  });
});
