import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ pool: 1200 as number | null | undefined, me: null as string | null }));
const row = (rank: number, points: number) => ({ rank, account: `p${rank}`, points, wins: 1 });
const board = { now: 0, season: { number: 4, start: 0, end: 1 }, poolGemas: 237, feeBps: 100, standings: [row(1, 20), row(2, 15), row(3, 10)], players: 3, last: null, settling: null, me: null };
vi.mock("@/lib/chain/usePool", () => ({ usePool: () => state.pool }));
vi.mock("@/lib/account", () => ({
  useAccount: () => (state.me ? { auth: { status: "signed-in", addresses: {} }, snapshot: { accountKey: { toBase58: () => state.me } } } : { auth: { status: "signed-out" }, snapshot: null }),
}));
vi.mock("@/lib/chain/useLeaderboard", () => ({ useLeaderboard: () => (state.me ? { data: board, forMe: state.me, error: null } : { data: null, forMe: null, error: null }) }));
const { PoolChest, Chest } = await import("./PoolChest");

describe("PoolChest", () => {
  beforeEach(() => { state.pool = 1200; state.me = null; });

  it("uses the Leaderboard chest art in the top bar and keeps its accessible link", () => {
    const html = renderToStaticMarkup(<PoolChest />);
    expect(html).toContain("pool-chest-cut.webp");
    expect(html).toContain('class="pc-chest-image"');
    expect(html).toContain('alt=""');
    expect(html).toContain('href="/leaderboard"');
    expect(html).toContain('aria-label="Leaderboard Pool:');
    expect(html).toContain("Open Leaderboard");
    expect(html).not.toContain('class="chest"');
  });

  it("keeps the loading skeleton and hides an unavailable Pool", () => {
    state.pool = undefined;
    expect(renderToStaticMarkup(<PoolChest />)).toContain('class="cut cut-card pchest skel"');
    state.pool = null;
    expect(renderToStaticMarkup(<PoolChest />)).toBe("");
  });

  it("shows your rank and points with no line under them, at any rank", () => {
    for (const me of ["p1", "p3"]) {
      state.me = me;
      const you = renderToStaticMarkup(<PoolChest />).split('class="pc-you-txt"')[1].split("</div>")[0];
      expect(you).toMatch(/pts<\/small><\/strong>$/);
    }
  });

  it("keeps the standalone SVG Chest export", () => {
    expect(renderToStaticMarkup(<Chest pop={1} />)).toContain('class="chest-lid pop"');
  });
});
