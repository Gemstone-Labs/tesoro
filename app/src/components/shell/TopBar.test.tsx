import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ mode: "simple" as "simple" | "advanced", path: "/play", requestDeposit: vi.fn(), requestGetGemas: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => state.path }));
vi.mock("@/lib/account", () => ({
  useAccount: () => ({ gemas: { total: 5000 }, auth: { status: "signed-in", openSignIn: () => {} }, ready: true, error: null }),
}));
vi.mock("@/lib/deposit/use-view-mode", () => ({ useViewMode: () => ({ mode: state.mode }) }));
vi.mock("@/lib/deposit/bus", () => ({ requestDeposit: state.requestDeposit }));
vi.mock("@/lib/get-gemas", () => ({ requestGetGemas: state.requestGetGemas }));
vi.mock("./PoolChest", () => ({ PoolChest: () => null }));
vi.mock("./AccountMenu", () => ({ AccountMenu: () => null }));
vi.mock("./Sidebar", () => ({ Wordmark: () => null }));
const { TopBar } = await import("./TopBar");

describe("the Gemas pill", () => {
  beforeEach(() => { state.mode = "simple"; state.path = "/play"; });

  it.each([
    ["simple", "/play"],
    ["advanced", "/play"],
    ["advanced", "/vault"],
    ["simple", "/vault"],
  ] as const)("is a button that opens Buy Gemas, never a link to the Vault (%s view on %s)", (mode, path) => {
    state.mode = mode;
    state.path = path;
    const html = renderToStaticMarkup(<TopBar onMenu={() => {}} />);
    const pill = html.match(/<(\w+)[^>]*gpill[^>]*>/)?.[0] ?? "";
    expect(pill).toMatch(/^<button/);
    expect(pill).not.toContain("href");
    expect(pill).toContain('aria-label="Your Gemas, buy Gemas"');
    expect(html).not.toContain("/vault");
  });
});
