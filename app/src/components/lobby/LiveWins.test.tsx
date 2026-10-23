import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SettledMatch } from "@/lib/chain/settled";

const query = vi.hoisted(() => ({ matches: [] as SettledMatch[], loading: true, error: null as string | null }));
vi.mock("@/lib/chain/useRecentSettled", () => ({ useRecentSettled: () => query }));
vi.mock("@/lib/account", () => ({ useAccount: () => ({ snapshot: null }) }));
vi.mock("@/components/account/Player", () => ({ PlayerAvatar: () => null, PlayerName: () => "Player" }));
const { LiveWins } = await import("./LiveWins");

describe("LiveWins", () => {
  it("reserves the cut strip and shows shimmering items while wins load", () => {
    Object.assign(query, { matches: [], loading: true, error: null });
    const html = renderToStaticMarkup(<LiveWins />);
    expect(html).toContain('class="cut cut-card live-wins"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Live wins");
    expect(html.match(/class="lw-placeholder skel"/g)).toHaveLength(3);
    expect(html).not.toContain('href=');
  });

  it("hides after an empty response or failed initial read", () => {
    Object.assign(query, { matches: [], loading: false, error: null });
    expect(renderToStaticMarkup(<LiveWins />)).toBe("");
    query.error = "Unavailable";
    expect(renderToStaticMarkup(<LiveWins />)).toBe("");
  });

  it("shows wins instead of placeholders when loaded, including during a refresh", () => {
    query.matches = [{ id: "12", winner: "player", game: "holdem", payout: 20, entry: 10, at: Date.now(), scores: null }];
    for (const loading of [false, true]) {
      query.loading = loading;
      const html = renderToStaticMarkup(<LiveWins />);
      expect(html).toContain('href="/play/match/12"');
      expect(html).not.toContain("lw-placeholder");
      expect(html).not.toContain('aria-busy="true"');
    }
  });
});
