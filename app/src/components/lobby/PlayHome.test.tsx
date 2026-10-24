import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  account: { auth: { status: "signed-in" }, openMatches: [] as { id: string }[], snapshot: null as { matchesLoaded: boolean } | null, error: null as string | null },
  friends: { status: "ready", view: { challenges: [] } },
}));
vi.mock("@/lib/account", () => ({ useAccount: () => state.account }));
vi.mock("@/lib/friends/FriendsProvider", () => ({ useFriends: () => state.friends }));
vi.mock("@/components/lobby/GameGrid", () => ({ GameGrid: () => <div>Games</div> }));
vi.mock("@/components/lobby/LiveWins", () => ({ LiveWins: () => <div>Wins</div> }));
const { PlayHome } = await import("@/app/(app)/play/PlayHome");

describe("Play Continue loading", () => {
  beforeEach(() => {
    Object.assign(state.account, { auth: { status: "signed-in" }, openMatches: [], snapshot: null, error: null });
    state.friends.status = "ready";
  });

  it("reserves the Continue card until Matches finish loading, including the early balance snapshot", () => {
    for (const snapshot of [null, { matchesLoaded: false }]) {
      state.account.snapshot = snapshot;
      const html = renderToStaticMarkup(<PlayHome />);
      expect(html).toContain('aria-busy="true"');
      expect(html).toContain("Loading your open Matches…");
      expect(html).toContain("continue-card skel");
      expect(html.indexOf("Continue")).toBeLessThan(html.indexOf("Games"));
    }
  });

  it("also waits for Friends challenges when Matches have already loaded", () => {
    state.account.snapshot = { matchesLoaded: true };
    for (const status of ["loading", "locked"]) {
      state.friends.status = status;
      expect(renderToStaticMarkup(<PlayHome />)).toContain("Loading your open Matches…");
    }
  });

  it("hides the empty row after data arrives, after an initial failure, and when signed out", () => {
    state.account.snapshot = { matchesLoaded: true };
    expect(renderToStaticMarkup(<PlayHome />)).not.toContain("Continue");
    state.account.snapshot = null;
    state.account.error = "Unavailable";
    expect(renderToStaticMarkup(<PlayHome />)).not.toContain("Continue");
    state.account.error = null;
    state.account.auth.status = "signed-out";
    state.friends.status = "loading";
    expect(renderToStaticMarkup(<PlayHome />)).not.toContain("Continue");
    state.account.auth.status = "unconfigured";
    expect(renderToStaticMarkup(<PlayHome />)).not.toContain("Continue");
  });
});
