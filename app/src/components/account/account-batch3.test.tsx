import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { breakRowText, entryRowText } from "./Protections";
import { RECENT } from "./RecentMatches";
import { closesIn } from "@/lib/chain/useBackingBoard";
import { GAME_SHORT } from "@/lib/friends/words";
import { GAME_LIST } from "@/lib/games";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));

describe("Protections rows", () => {
  it("say Off when nothing is set", () => {
    expect(entryRowText({ limit: null, pending: null, used: 0, remaining: null, resetsAt: null })).toBe("Off");
    expect(breakRowText({ kind: null, until: null, breakUntil: null, selfExclusionUntil: null })).toBe("Off");
  });
  it("show what is left of an Entry Limit", () => {
    expect(entryRowText({ limit: 1000, pending: null, used: 400, remaining: 600, resetsAt: 1 })).toBe("600 left of 1,000");
  });
  it("name a Break and a Self-Exclusion", () => {
    const base = { breakUntil: null, selfExclusionUntil: null };
    expect(breakRowText({ ...base, kind: "break", until: 2_000_000_000 })).toMatch(/^Until /);
    expect(breakRowText({ ...base, kind: "self-exclusion", until: 2_000_000_000 })).toMatch(/^Self-Excluded until /);
  });
});

describe("Account page", () => {
  it("lists three recent Matches", () => expect(RECENT).toBe(3));
});

describe("Request card clock", () => {
  it("reads like the Backing mockup", () => {
    const now = 1_000_000_000_000;
    expect(closesIn(now / 1000 + 11 * 3600 + 60, now)).toBe("11h left");
    expect(closesIn(now / 1000 + 3 * 86400, now)).toBe("3d left");
  });
});

describe("Friend chips", () => {
  it("have a short name for every Game", () => {
    for (const g of GAME_LIST) expect(GAME_SHORT[g]).toBeTruthy();
  });
});

describe("FriendLinkButton", () => {
  it("renders a Friend link button", async () => {
    vi.doMock("@/lib/account", () => ({ useAccount: () => ({ auth: { gate: (_: string, f: () => void) => f() } }) }));
    vi.doMock("@/lib/friends/FriendsProvider", () => ({ useFriends: () => ({ act: async () => ({ code: "abc" }) }) }));
    const { FriendLinkButton } = await import("@/components/friends/FriendLinkButton");
    expect(renderToStaticMarkup(<FriendLinkButton />)).toContain("Friend link");
  });
});
