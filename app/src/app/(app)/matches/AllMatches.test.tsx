import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ matchesLoaded: false }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/account", () => ({
  useAccount: () => ({
    auth: { status: "signed-in" },
    onChain: true,
    snapshot: state.matchesLoaded ? { accountKey: { toBase58: () => "me" }, matchesLoaded: true, matches: [], funded: [] } : null,
    openMatches: [],
  }),
}));
vi.mock("@/lib/chain/ChainDataProvider", () => ({ useChainData: () => ({ error: null, refresh: async () => {} }) }));
vi.mock("@/lib/chain/history-client", () => ({ fetchAllHistory: () => new Promise(() => {}) }));
const { AllMatches } = await import("./AllMatches");

describe("AllMatches while loading", () => {
  beforeEach(() => { state.matchesLoaded = false; });

  it("puts the placeholder cards under the Finished heading, as the loaded page does, in both loading stages", () => {
    for (const loaded of [false, true]) {
      state.matchesLoaded = loaded;
      const html = renderToStaticMarkup(<AllMatches />);
      const heading = html.indexOf("mh-finished-h");
      const cards = html.indexOf("Loading your Matches");
      expect(heading).toBeGreaterThan(-1);
      expect(cards).toBeGreaterThan(heading);
    }
  });
});
