import { describe, expect, it } from "vitest";
import { art, avatarFor } from "@/lib/art";
import { shownIdentity, profileNameError, type Identity } from "./display";

const KEY = "DA9KbqMc6xNYfRy8c1uXwZ1tZP4rD4Xq3sPa7cDqP1bS";
const sol = { name: "ana.sol", avatar: "https://x.test/sol.png" };
const eth = { name: "ana.eth", avatar: "https://x.test/eth.png" };
const hl = { name: "ana.hl", avatar: "https://x.test/hl.png" };

describe("shownIdentity", () => {
  it("falls back to the short key and the derived avatar", () => {
    const s = shownIdentity(KEY);
    expect(s.label).toMatch(/…|\.\.\./);
    expect(s.verified).toBeNull();
    expect(s.named).toBe(false);
    expect(s.avatar).toBe(avatarFor(KEY));
  });

  it("prefers Profile name, then .sol, then .eth, then .hl", () => {
    const profile = { name: "Ana", avatar: { kind: "default" } as const };
    expect(shownIdentity(KEY, { profile, sol, eth, hl }).label).toBe("Ana");
    expect(shownIdentity(KEY, { profile, sol, eth, hl }).verified).toBeNull();
    expect(shownIdentity(KEY, { profile: null, sol, eth, hl })).toMatchObject({ label: "ana.sol", verified: ".sol" });
    expect(shownIdentity(KEY, { profile: null, sol: null, eth, hl })).toMatchObject({ label: "ana.eth", verified: ".eth" });
    expect(shownIdentity(KEY, { profile: null, sol: null, eth: null, hl })).toMatchObject({ label: "ana.hl", verified: ".hl" });
  });

  it("uses the picked animal, and the name-service picture only when picked and present", () => {
    const base: Identity = { profile: { name: "Ana", avatar: { kind: "animal", index: 4 } }, sol, eth, hl };
    expect(shownIdentity(KEY, base).avatar).toBe(art.avatars[4]);
    const ns: Identity = { ...base, profile: { name: "Ana", avatar: { kind: "name-service" } } };
    expect(shownIdentity(KEY, ns)).toMatchObject({ avatar: sol.avatar, remoteAvatar: true });
    expect(shownIdentity(KEY, { ...ns, sol: { name: "ana.sol", avatar: null } }).avatar).toBe(eth.avatar);
    expect(shownIdentity(KEY, { ...ns, sol: null, eth: null })).toMatchObject({ avatar: hl.avatar, remoteAvatar: true });
    expect(shownIdentity(KEY, { ...ns, sol: null, eth: null, hl: null })).toMatchObject({ avatar: avatarFor(KEY), remoteAvatar: false });
    // A name-service picture is never used without the choice.
    expect(shownIdentity(KEY, { profile: null, sol, eth, hl }).avatar).toBe(avatarFor(KEY));
  });
});

describe("profileNameError", () => {
  it("matches the program rule", () => {
    expect(profileNameError("Ana")).toBeNull();
    expect(profileNameError("  Ana Maria  ")).toBeNull();
    expect(profileNameError("ab")).not.toBeNull();
    expect(profileNameError("x".repeat(21))).not.toBeNull();
    expect(profileNameError("a@b")).not.toBeNull();
    expect(profileNameError("ça va")).not.toBeNull();
  });
});
