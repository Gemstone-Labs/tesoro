import { describe, expect, it } from "vitest";
import { myBackingsView } from "./my-backings-view";

describe("My Backings view", () => {
  it("invites a signed-out visitor to sign in and shows no personal state", () => {
    expect(myBackingsView({ status: "signed-out", accountKnown: false, boardLoaded: true, backings: 0 })).toBe("sign-in");
    expect(myBackingsView({ status: "signed-out", accountKnown: false, boardLoaded: false, backings: 0 })).toBe("sign-in");
  });
  it("is loading, never the empty state, while sign-in, the Account or the board is still loading", () => {
    expect(myBackingsView({ status: "loading", accountKnown: false, boardLoaded: true, backings: 0 })).toBe("loading");
    expect(myBackingsView({ status: "unconfigured", accountKnown: false, boardLoaded: true, backings: 0 })).toBe("loading");
    expect(myBackingsView({ status: "signed-in", accountKnown: false, boardLoaded: true, backings: 0 })).toBe("loading");
    expect(myBackingsView({ status: "signed-in", accountKnown: true, boardLoaded: false, backings: 0 })).toBe("loading");
  });
  it("reserves the empty state for a signed-in Account with no Backings", () => {
    expect(myBackingsView({ status: "signed-in", accountKnown: true, boardLoaded: true, backings: 0 })).toBe("empty");
  });
  it("lists the Backings of a signed-in Account", () => {
    expect(myBackingsView({ status: "signed-in", accountKnown: true, boardLoaded: true, backings: 2 })).toBe("list");
  });
});
