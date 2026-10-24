import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ pool: 1200 as number | null | undefined }));
vi.mock("@/lib/chain/usePool", () => ({ usePool: () => state.pool }));
vi.mock("@/lib/account", () => ({ useAccount: () => ({ auth: { status: "signed-out" }, snapshot: null }) }));
vi.mock("@/lib/chain/useLeaderboard", () => ({ useLeaderboard: () => ({ data: null, forMe: null, error: null }) }));
const { PoolChest, Chest } = await import("./PoolChest");

describe("PoolChest", () => {
  beforeEach(() => { state.pool = 1200; });

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

  it("keeps the standalone SVG Chest export", () => {
    expect(renderToStaticMarkup(<Chest pop={1} />)).toContain('class="chest-lid pop"');
  });
});
