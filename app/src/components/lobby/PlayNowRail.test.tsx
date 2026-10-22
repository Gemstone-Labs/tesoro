import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/shell/SearchContext", () => ({ useSearch: () => ({ query: "", setQuery: () => undefined }), matchesQuery: () => true }));
vi.mock("./useQueue", () => ({ useQueue: () => null }));
vi.mock("@/lib/account", () => ({ useAccount: () => ({ auth: { status: "signed-out" }, snapshot: null }) }));

const { PlayNowRail } = await import("./PlayNowRail");

describe("PlayNowRail", () => {
  it("shows every live Game's tile without a 'Live now' tag (they are all live)", () => {
    const html = renderToStaticMarkup(<PlayNowRail />);
    expect(html).toContain("Vanguard");
    expect(html).toContain("Buckshot Hold");
    expect(html).toContain("Block Burst");
    expect(html).not.toMatch(/live now/i);
  });
});
