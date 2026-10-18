import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PublicKey } from "@solana/web3.js";
import { VANGUARD_PROGRAM_ID } from "../../app/src/games/vanguard/chain.ts";
import { gameOfKey, pushSettled, settledPush, type SettledMatch } from "./notify.ts";

const base: SettledMatch = {
  id: 123n,
  game: "block-puzzle",
  entry: 1000n,
  fees: { platformBps: 300, studioBps: 200 },
  leaderboardBps: 100,
  result: 0,
  sides: [
    { authority: "opener", backedShareBps: null },
    { authority: "joiner", backedShareBps: null },
  ],
};

describe("settled Match event for the app", () => {
  it("tells the winner their Gemas after Fees and the loser the entry", () => {
    const p = settledPush(base);
    assert.equal(p.matchId, "123");
    assert.deepEqual(p.participants, [
      { authority: "opener", result: "won", gemas: 1000 - 120 },
      { authority: "joiner", result: "lost", gemas: 1000 },
    ]);
  });

  it("reads a joiner win and a draw", () => {
    assert.deepEqual(settledPush({ ...base, result: 1 }).participants.map((x) => x.result), ["lost", "won"]);
    const d = settledPush({ ...base, result: 2 });
    assert.deepEqual(d.participants.map((x) => [x.result, x.gemas]), [["draw", 0], ["draw", 0]]);
  });

  it("gives a backed Player only their share, and a backed loss costs them nothing", () => {
    const won = settledPush({ ...base, sides: [{ authority: "opener", backedShareBps: 5000 }, base.sides[1]] });
    assert.equal(won.participants[0].gemas, Math.floor((1000 - 120) / 2));
    const lost = settledPush({ ...base, result: 1, sides: [{ authority: "opener", backedShareBps: 5000 }, base.sides[1]] });
    assert.deepEqual(lost.participants[0], { authority: "opener", result: "lost", gemas: 0 });
  });

  it("an unjoined Match has one Player", () => {
    assert.equal(settledPush({ ...base, sides: [base.sides[0], null] }).participants.length, 1);
  });
});

describe("push to the app", () => {
  it("posts the event with the shared secret and reports whether the server took it", async () => {
    let seen: { url: string; init: any } | undefined;
    const ok = (async (url: string, init: any) => ((seen = { url, init }), new Response("{}", { status: 200 }))) as unknown as typeof fetch;
    assert.equal(await pushSettled("https://x/api/notify/event", "s", settledPush(base), ok), true);
    assert.equal(seen?.init.headers.authorization, "Bearer s");
    assert.equal(JSON.parse(seen?.init.body).matchId, "123");
    const bad = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    assert.equal(await pushSettled("u", "s", settledPush(base), bad), false);
    const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    assert.equal(await pushSettled("u", "s", settledPush(base), down), false);
  });
});

describe("Vanguard settled push", () => {
  it("carries the Game and a draw's result", () => {
    const p = settledPush({ ...base, game: "vanguard", result: 2 });
    assert.equal(p.game, "vanguard");
    assert.ok(p.participants.every((x) => x.result === "draw"));
  });
});

describe("gameOfKey", () => {
  it("knows the Vanguard program and no stranger", () => {
    assert.equal(gameOfKey(VANGUARD_PROGRAM_ID), "vanguard");
    assert.equal(gameOfKey(PublicKey.default), null);
  });
});
