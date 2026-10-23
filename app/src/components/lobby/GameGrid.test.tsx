import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./useQueue", () => ({ useQueue: () => null }));
vi.mock("@/lib/account", () => ({ useAccount: () => ({ auth: { status: "signed-out" }, snapshot: null }) }));

const { GameGrid } = await import("./GameGrid");

describe("GameGrid", () => {
  it("shows every live Game as a tile that opens its page, with no entry chips or Play buttons on the tile", () => {
    const html = renderToStaticMarkup(<GameGrid />);
    for (const name of ["Vanguard", "Buckshot Hold", "Trading Duel", "Block Burst"]) expect(html).toContain(name);
    expect(html).toContain('href="/play/vanguard"');
    expect(html).not.toMatch(/Play now|Practice free|tile-entry/);
  });
});
