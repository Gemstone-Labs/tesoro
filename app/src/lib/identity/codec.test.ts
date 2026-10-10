import { describe, expect, it } from "vitest";
import { avatarArg, avatarFromChain, profileFromChain } from "./codec";

const name = (s: string) => [...Buffer.from(s), ...Array(20 - s.length).fill(0)];

describe("avatar codec", () => {
  it("encodes picks the way the Anchor client names the variants", () => {
    expect(avatarArg({ kind: "default" })).toEqual({ default: {} });
    expect(avatarArg({ kind: "name-service" })).toEqual({ nameService: {} });
    expect(avatarArg({ kind: "animal", index: 3 })).toEqual({ animal: [3] });
  });

  it("decodes what the client returns", () => {
    expect(avatarFromChain({ default: {} })).toEqual({ kind: "default" });
    expect(avatarFromChain({ nameService: {} })).toEqual({ kind: "name-service" });
    expect(avatarFromChain({ animal: [5] })).toEqual({ kind: "animal", index: 5 });
    expect(avatarFromChain({ animal: { "0": 7 } })).toEqual({ kind: "animal", index: 7 });
    expect(avatarFromChain(undefined)).toEqual({ kind: "default" });
    expect(avatarFromChain({ animal: [-1] })).toEqual({ kind: "default" });
  });
});

describe("profileFromChain", () => {
  it("reads the name by its length", () => {
    expect(profileFromChain({ nameLen: 3, name: name("Ana"), avatar: { animal: [2] } })).toEqual({ name: "Ana", avatar: { kind: "animal", index: 2 } });
  });

  it("is nothing for an account that only attached a wallet", () => {
    expect(profileFromChain({ nameLen: 0, name: name(""), avatar: { default: {} } })).toBeNull();
    expect(profileFromChain(null)).toBeNull();
  });
});
