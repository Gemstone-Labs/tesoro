import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ctx } from "./act.ts";
import { scanMatches } from "./matches.ts";

test("a fresh scan reads the Match list again even in the same cluster second; a plain one shares the pass's scan", async () => {
  let reads = 0;
  const ctx = { now: 5, conn: {}, core: { account: { matchState: { all: async () => (reads++, [] as unknown[]) } } } } as unknown as Ctx;
  await scanMatches(ctx);
  await scanMatches(ctx);
  assert.equal(reads, 1, "shared within the second");
  await scanMatches(ctx, { fresh: true });
  assert.equal(reads, 2, "fresh reads again");
  await scanMatches(ctx);
  assert.equal(reads, 2, "and its result is what the others now share");
});
