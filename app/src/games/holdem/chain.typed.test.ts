import { describe, expect, it } from "vitest";
import type { HoldemChain } from "./chain";

/**
 * The program is typed from the generated IDL (`lib/chain/idl/holdem.types.ts`, kept in step by scripts/sync-idl.mjs), so a call
 * to an instruction the program no longer has fails `tsc`. If the program were untyped again, the `@ts-expect-error` comments
 * would themselves be errors.
 */
describe("the Hold'em program is typed", () => {
  it("has no per-Match instructions left to call", () => {
    const calls = (c: HoldemChain) => {
      // @ts-expect-error the per-Match Deck and Holdings flow was removed with the tables
      void c.program.methods.openMatchState;
      // @ts-expect-error the Deck account was removed (Deck-less Hold'em)
      void c.program.account.deck;
      void c.program.methods.checkIn;
    };
    expect(calls).toBeTypeOf("function");
  });
});
