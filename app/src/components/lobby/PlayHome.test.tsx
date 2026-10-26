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
const memory = vi.hoisted(() => ({ had: false }));
vi.mock("@/components/lobby/continue-memory", async (orig) => ({ ...(await orig<typeof import("@/components/lobby/continue-memory")>()), readHadContinue: () => memory.had, writeHadContinue: () => {} }));
vi.mock("@/lib/chain/account-key", () => ({ accountKeyOf: (w: string) => `acct-${w}` }));
const { continueMotion, continuePlaceholder } = await import("@/components/lobby/continue-memory");
const { ContinueSkeleton } = await import("@/components/lobby/ContinueRail");
const ContinueSlotForTest = () => <div className="continue-slot"><ContinueSkeleton /></div>;
const { PlayHome } = await import("@/app/(app)/play/PlayHome");

describe("Play Continue loading", () => {
  beforeEach(() => {
    memory.had = false;
    Object.assign(state.account, { auth: { status: "signed-in", addresses: { solana: "W1" } }, openMatches: [], snapshot: null, error: null });
    state.friends.status = "ready";
  });

  it("shows nothing for Continue while loading by default: no heading, no skeleton", () => {
    for (const snapshot of [null, { matchesLoaded: false }]) {
      state.account.snapshot = snapshot;
      const html = renderToStaticMarkup(<PlayHome />);
      expect(html).not.toContain("Continue");
      expect(html).not.toContain("continue-card skel");
      expect(html).toContain("Games");
    }
    state.account.snapshot = { matchesLoaded: true };
    for (const status of ["loading", "locked"]) {
      state.friends.status = status;
      expect(renderToStaticMarkup(<PlayHome />)).not.toContain("Loading your open Matches…");
    }
  });

  it("keeps a same-height skeleton while loading only when the last read had open Matches", () => {
    const loading = { items: false, pending: true, signedIn: true };
    expect(continuePlaceholder({ ...loading, likely: true })).toBe(true);
    expect(continuePlaceholder({ ...loading, likely: false })).toBe(false);
  });

  it("renders that skeleton in place of Continue, above Games", () => {
    const html = renderToStaticMarkup(
      <ContinueSlotForTest />,
    );
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("continue-card skel");
  });

  it("drops the skeleton once the read finishes empty, fails, or the Player is signed out", () => {
    const base = { items: false, signedIn: true, likely: true };
    expect(continuePlaceholder({ ...base, pending: false })).toBe(false);
    expect(continuePlaceholder({ ...base, pending: false, signedIn: false })).toBe(false);
    expect(continuePlaceholder({ ...base, pending: true, signedIn: false })).toBe(false);
    expect(continuePlaceholder({ ...base, pending: true, items: true })).toBe(false);
  });
});

describe("continueMotion", () => {
  const none = { items: false, placeholder: false };
  const skel = { items: false, placeholder: true };
  const some = { items: true, placeholder: false };
  it("reveals when items arrive from nothing", () => expect(continueMotion(none, some)).toBe("reveal"));
  it("swaps in place when items replace the placeholder", () => expect(continueMotion(skel, some)).toBe("none"));
  it("folds away when the placeholder finds nothing", () => expect(continueMotion(skel, none)).toBe("collapse"));
  it("does nothing when nothing changes shape", () => {
    expect(continueMotion(none, none)).toBe("none");
    expect(continueMotion(some, none)).toBe("none");
  });
});

describe("Play Continue edge cases", () => {
  beforeEach(() => {
    memory.had = false;
    Object.assign(state.account, { auth: { status: "signed-in", addresses: { solana: "W1" } }, openMatches: [], snapshot: null, error: null });
    state.friends.status = "ready";
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
