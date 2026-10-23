import { describe, expect, it } from "vitest";
import type { BlockBurstChain } from "./live-chain";

/**
 * The program is typed from the generated IDL (`lib/chain/idl/block_puzzle.types.ts`, kept in step by scripts/sync-idl.mjs),
 * so a call to an instruction the program no longer has fails `tsc`. These lines are that check: if the program were untyped
 * again, the `@ts-expect-error` comments would themselves be errors.
 */
describe("the Block Burst program is typed", () => {
  it("has no per-Match session instructions left to call", () => {
    const calls = (c: BlockBurstChain) => {
      // @ts-expect-error open_session was removed with the per-Match Session
      void c.program.methods.openSession;
      // @ts-expect-error join_session was removed with the per-Match Session
      void c.program.methods.joinSession;
      // @ts-expect-error begin_run is now `begin`, on the table
      void c.program.methods.beginRun;
      // @ts-expect-error the Session account no longer exists
      void c.program.account.session;
      void c.program.methods.checkIn;
    };
    expect(calls).toBeTypeOf("function");
  });
});
