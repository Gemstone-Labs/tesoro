import { renderToStaticMarkup } from "react-dom/server";
import type { HistoryRow } from "@/lib/chain/history";
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
vi.stubEnv("NEXT_PUBLIC_SHOW_RAILCAR", "1");
const { AllMatches, MatchesView } = await import("./AllMatches");

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

const NOW = 1_762_300_000_000;
const row = (id: string, o: Partial<HistoryRow>): HistoryRow => ({ id, game: "holdem", entry: 100, role: "player", result: "won", delta: 90, backing: null, scores: null, opp: null, at: NOW - 3_600_000, asset: null, ...o });
const HISTORY: HistoryRow[] = [
  row("Opener1-7", { game: "railcar", ride: { seated: 5, kind: "place", place: 1, jumpMs: 99_000 } }),
  row("Opener1-8", { game: "railcar", result: "lost", delta: -100, ride: { seated: 5, kind: "aboard" } }),
  row("duel-1", { game: "trading-duel" }),
  row("hand-1", { game: "holdem", result: "lost", delta: -100 }),
];
const snapshot = { accountKey: { toBase58: () => "me" }, matchesLoaded: true, matches: [], funded: [] } as never;
const page = (query: string, history: HistoryRow[] | null = HISTORY) =>
  renderToStaticMarkup(<MatchesView auth={{ status: "signed-in" } as never} snapshot={snapshot} openMatches={[]} history={history} error={null} refresh={async () => {}} params={new URLSearchParams(query)} now={NOW} />);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const banners = (html: string) => (html.match(/href="\/play\/[^"]+"/g) ?? []).filter((h) => /ride|match/.test(h));
const nav = (html: string, label: string) => html.match(new RegExp(`<nav[^>]*aria-label="${label}"[\\s\\S]*?</nav>`))?.[0] ?? "";

describe("the Matches game filter", () => {
  it("offers Railcar beside every other Game, and a chip links to its own filter", () => {
    const tabs = text(nav(page(""), "Game")).replace(/&#x27;/g, "'");
    for (const name of ["All", "Vanguard", "Hold'em", "Trading Duel", "Block Burst", "Railcar"]) expect(tabs).toContain(name);
    expect(nav(page(""), "Game")).toMatch(/href="\/matches\?game=railcar["&]/);
  });

  it("All lists the rides and the other Games together", () => {
    const html = page("");
    expect(banners(html)).toHaveLength(4);
    expect(html).toContain("/play/railcar/ride/Opener1-7");
    expect(html).toContain("/play/match/duel-1");
  });

  it("Railcar lists only rides; the result counts and the page line follow the filtered list", () => {
    const html = page("game=railcar");
    expect(banners(html)).toHaveLength(2);
    expect(html).not.toContain("/play/match/");
    expect(html).toContain('aria-label="Railcar Matches, page 1 of 1"');
    expect(text(nav(html, "Results shown"))).toMatch(/Won 1/);
    expect(text(nav(html, "Results shown"))).toMatch(/Lost 1/);
  });

  it("a Game with no finished Matches says so in plain words and offers to play it", () => {
    const html = page("game=railcar", HISTORY.filter((r) => r.game !== "railcar"));
    expect(text(html)).toContain("No finished Railcar Matches yet. They appear here when they finish.");
    expect(html).toContain('href="/play/railcar"');
    expect(banners(html)).toHaveLength(0);
  });

  it("results that hide every ride say so and link back to all results", () => {
    const html = page("game=railcar&result=draw");
    expect(text(html)).toContain("No Railcar Matches with these results.");
    expect(html).toContain("Show all results");
  });
});
