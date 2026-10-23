import { describe, expect, it } from "vitest";
import type { VanguardChain } from "./chain";

/**
 * The program is typed from the generated IDL (`lib/chain/idl/vanguard.types.ts`, kept in step by scripts/sync-idl.mjs), so a call
 * to an instruction the program no longer has fails `tsc`. If the program were untyped again, the `@ts-expect-error` comments
 * would themselves be errors.
 */
describe("the Vanguard program is typed", () => {
  it("has no per-Match instructions left to call", () => {
    const calls = (c: VanguardChain) => {
      // @ts-expect-error the per-Match Battle setup was replaced by tables
      void c.program.methods.openBattle;
      // @ts-expect-error the Secret account was removed (Secret-less Vanguard)
      void c.program.account.secret;
      void c.program.methods.checkIn;
      void c.program.methods.movePiece;
    };
    expect(calls).toBeTypeOf("function");
  });
});
