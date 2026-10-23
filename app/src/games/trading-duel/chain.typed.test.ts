import { describe, expect, it } from "vitest";
import type { TradingDuelChain } from "./chain";

/**
 * The program is typed from the generated IDL (`lib/chain/idl/trading_duel.types.ts`, kept in step by scripts/sync-idl.mjs), so a
 * call to an instruction the program no longer has fails `tsc`. If the program were untyped again, the `@ts-expect-error`
 * comments would themselves be errors.
 */
describe("the Trading Duel program is typed", () => {
  it("has no per-Match Duel instructions left to call", () => {
    const calls = (c: TradingDuelChain) => {
      // @ts-expect-error the per-Match Duel was replaced by tables
      void c.program.methods.createDuel;
      // @ts-expect-error the per-Match Duel account no longer exists
      void c.program.account.duelMatch;
      void c.program.methods.checkIn;
    };
    expect(calls).toBeTypeOf("function");
  });
});
