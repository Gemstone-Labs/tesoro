import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const me = "6qPLGMP5pY9KXQ8PVr8V8cjiWNdy3tzfKnf85e5wQmoZ";
// The QA lobby row of 2026-11-25: car 16's 203-Gema win opened "Match not found" (the head-to-head route).
const rows = [
  { id: "G36aGv8D-16", game: "railcar", entry: 100, winner: me, payout: 203, scores: null, at: Date.now() - 60_000 },
  { id: "3CypGMXD-4", game: "block-puzzle", entry: 500, winner: me, payout: 940, scores: [410, 200], at: Date.now() - 120_000 },
];
vi.mock("@/lib/chain/useRecentSettled", () => ({ useRecentSettled: () => ({ matches: rows, loading: false, error: null }) }));
vi.mock("@/lib/account", () => ({ useAccount: () => ({ snapshot: null }) }));
vi.mock("@/components/account/Player", () => ({ PlayerAvatar: () => null, PlayerName: () => "Player" }));

describe("Live wins rows", () => {
  it("open a Railcar ride on its ride page and a head-to-head Match on the Match page", async () => {
    const { LiveWins } = await import("./LiveWins");
    const html = renderToStaticMarkup(<LiveWins />);
    expect(html).toContain('href="/play/railcar/ride/G36aGv8D-16"');
    expect(html).not.toContain('href="/play/match/G36aGv8D-16"');
    expect(html).toContain('href="/play/match/3CypGMXD-4"');
    expect(html).toContain("Railcar");
  });
});
