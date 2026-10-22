import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { debtClearedFacts, digestDue, matchFacts, offerFacts, pushDigest, pushEvents, seasonFacts, seasonFactsInput, sendEvents, type MatchFacts, type OfferFacts } from "./notify-events.ts";

const NOW = 1_800_000_000;
const base: MatchFacts = { id: 7n, game: "holdem", status: "active", deadline: NOW + 600, entry: 500, players: ["a", "b"], session: null };

describe("Match refunded and Delayed", () => {
  it("tells both Players of a refund", () => {
    const f = matchFacts({ ...base, status: "refunded" }, NOW);
    assert.deepEqual(f.map((x) => [x.account, x.kind]), [["a", "match-refunded"], ["b", "match-refunded"]]);
    assert.equal((f[0] as any).entry, 500);
  });

  it("a live Match is not Delayed; one past its settle time is, with its refund deadline", () => {
    assert.deepEqual(matchFacts(base, NOW), []);
    const f = matchFacts(base, NOW + 601);
    assert.deepEqual(f[0], { account: "a", kind: "match-delayed", matchId: "7", game: "holdem", refundBy: NOW + 600, refundOpen: true });
  });

  it("uses the Delayed rule of the game: a Trading Duel is Delayed before its refund deadline", () => {
    const duel: MatchFacts = { ...base, game: "trading-duel", deadline: NOW + 3600 };
    const joined = NOW + 3600 - 3600;
    assert.deepEqual(matchFacts(duel, joined + 400), []);
    const late = matchFacts(duel, joined + 600);
    assert.equal(late[0].kind, "match-delayed");
    assert.equal((late[0] as any).refundOpen, false);
  });

  it("a Vanguard Match is Delayed after its play window, not at its 24 h refund deadline, and a refund is told", () => {
    const vg: MatchFacts = { ...base, game: "vanguard", deadline: NOW + 86_400 };
    const joined = NOW + 86_400 - 86_400;
    assert.deepEqual(matchFacts(vg, joined + 600), []);
    const late = matchFacts(vg, joined + 300 + 60 + 900 + 600);
    assert.equal(late[0].kind, "match-delayed");
    assert.equal((late[0] as any).game, "vanguard");
    assert.equal((late[0] as any).refundOpen, false);
    assert.deepEqual(matchFacts({ ...vg, status: "refunded" }, NOW).map((x) => [x.kind, (x as any).game]), [["match-refunded", "vanguard"], ["match-refunded", "vanguard"]]);
  });

  it("a Block Burst Match is Delayed after both Session deadlines plus the grace", () => {
    const bp: MatchFacts = { ...base, game: "block-puzzle", deadline: NOW + 3000, session: { deadline: NOW + 100, openerDeadline: NOW + 50 } };
    assert.deepEqual(matchFacts(bp, NOW + 200), []);
    assert.equal(matchFacts(bp, NOW + 221)[0].kind, "match-delayed");
  });

  it("an open, settled or very old Match says nothing", () => {
    assert.deepEqual(matchFacts({ ...base, status: "open" }, NOW + 9999), []);
    assert.deepEqual(matchFacts({ ...base, status: "settled" }, NOW + 9999), []);
    assert.deepEqual(matchFacts({ ...base, status: "refunded" }, NOW + 600 + 4 * 86400), []);
  });
});


describe("Offers", () => {
  const offer: OfferFacts = { address: "O1", backer: "backer", game: "block-puzzle", entry: 1000, status: "open", expiresAt: NOW + 100, useBy: NOW + 200, request: "R1" };
  const requests = new Map([["R1", "player"]]);
  it("an open Offer on a Request tells the Request's Player", () => {
    assert.deepEqual(offerFacts([offer], requests, NOW), [{ account: "player", kind: "offer-made", offerId: "O1", game: "block-puzzle", entry: 1000 }]);
  });
  it("an accepted Offer tells its Backer", () => {
    assert.deepEqual(offerFacts([{ ...offer, status: "accepted" }], requests, NOW), [{ account: "backer", kind: "offer-accepted", offerId: "O1", game: "block-puzzle", entry: 1000 }]);
  });
  it("skips lapsed and unmatched Offers and ones that are over", () => {
    assert.deepEqual(offerFacts([{ ...offer, expiresAt: NOW - 1 }, { ...offer, request: "R2" }, { ...offer, status: "cancelled" }, { ...offer, status: "accepted", useBy: NOW - 1 }], requests, NOW), []);
  });
});

describe("Debt reached 0", () => {
  const pos = (over: object = {}) => ({ address: "P1", owner: "o", locked: true, openAdvance: 0 as number | null, asset: "SOL", ...over });
  it("announces a Position whose Debt went away since the last pass, once", () => {
    const first = debtClearedFacts(null, [pos()]);
    assert.deepEqual(first.facts, []);
    const second = debtClearedFacts(first.after, [pos({ openAdvance: null })]);
    assert.deepEqual(second.facts, [{ account: "o", kind: "debt-cleared", positionId: "P1", advance: 0, asset: "SOL" }]);
    assert.deepEqual(debtClearedFacts(second.after, [pos({ openAdvance: null })]).facts, []);
  });
  it("a Position that was unlocked is not announced, and a still-owing one is not", () => {
    const before = new Map([["P1", 0]]);
    assert.deepEqual(debtClearedFacts(before, [pos({ locked: false, openAdvance: null })]).facts, []);
    assert.deepEqual(debtClearedFacts(before, [pos()]).facts, []);
  });
});

describe("Season placed", () => {
  it("tells each paid rank with its place and Gemas", () => {
    const f = seasonFacts({ number: 2, count: 3, winners: ["a", "b", "c"], gemas: [900n, 500n, 100n], paid: [true, false, true] });
    assert.deepEqual(f, [
      { account: "a", kind: "season-placed", season: 2, rank: 1, gemas: 900 },
      { account: "c", kind: "season-placed", season: 2, rank: 3, gemas: 100 },
    ]);
  });
});

describe("Season placed from a recorded Season", () => {
  it("counts a rank as paid once all its budget lines are, and tells its total", () => {
    const k = (n: number) => ({ toBase58: () => `k${n}` }) as any;
    const rec = { number: 2, count: 2, winners: [k(1), k(2)], points: [9n, 4n], lines: [{ source: k(0), amount: 1000n, paid: 0n }, { source: k(0), amount: 400n, paid: 0n }], cursor: [2, 1, 0, 0, 0, 0, 0, 0, 0, 0], recordedAt: 1, voidedMask: 0, closed: false };
    assert.deepEqual(seasonFacts(seasonFactsInput(rec)), [{ account: "k1", kind: "season-placed", season: 2, rank: 1, gemas: 350 }]);
  });
});

describe("daily digest call and push", () => {
  it("is due once per UTC day from the set hour", () => {
    const at = (iso: string) => Date.parse(iso);
    assert.equal(digestDue(at("2026-10-15T07:59:00Z"), null, 8), false);
    assert.equal(digestDue(at("2026-10-15T08:00:00Z"), null, 8), true);
    assert.equal(digestDue(at("2026-10-15T20:00:00Z"), "2026-10-15", 8), false);
    assert.equal(digestDue(at("2026-10-16T08:01:00Z"), "2026-10-15", 8), true);
  });
  it("posts events and the digest with the shared secret and reports whether the server took them", async () => {
    const seen: any[] = [];
    const ok = (async (url: string, init: any) => (seen.push({ url, init }), new Response("{}", { status: 200 }))) as unknown as typeof fetch;
    assert.equal(await pushEvents("https://x/api/notify/events", "s", [{ kind: "x" }], ok), "sent");
    assert.equal(await pushDigest("https://x/api/notify/digest", "s", ok), true);
    assert.equal(seen[0].init.headers.authorization, "Bearer s");
    assert.deepEqual(JSON.parse(seen[0].init.body), { events: [{ kind: "x" }] });
    const bad = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    assert.equal(await pushDigest("u", "s", bad), false);
    const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    assert.equal(await pushEvents("u", "s", [], down), "failed");
    const malformed = (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch;
    assert.equal(await pushEvents("u", "s", [{ kind: "x" }], malformed), "rejected");
  });
});

describe("sending events to an app that does not take every Game", () => {
  // the live app answers 400 to any batch with a Game it does not list (staging's keeper sees Vanguard first)
  const app = (calls: string[][]) =>
    (async (_url: string, init: any) => {
      const games = (JSON.parse(init.body).events as { game: string }[]).map((e) => e.game);
      calls.push(games);
      return new Response("{}", { status: games.includes("vanguard") ? 400 : 200 });
    }) as unknown as typeof fetch;
  const ev = (key: string, game: string) => ({ key, body: { kind: "match-refunded", game } });

  it("still delivers the other Games' events and drops only the ones the app refuses, without asking again", async () => {
    const told = new Set<string>();
    const calls: string[][] = [];
    const events = [ev("a", "holdem"), ev("b", "vanguard"), ev("c", "block-puzzle")];
    assert.equal(await sendEvents("u", "s", events, told, app(calls)), 2);
    assert.deepEqual([...told].sort(), ["a", "b", "c"]);
    assert.deepEqual(calls, [["holdem", "vanguard", "block-puzzle"], ["holdem"], ["vanguard"], ["block-puzzle"]]);
  });

  it("keeps events for the next pass when the app is down", async () => {
    const told = new Set<string>();
    const down = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    assert.equal(await sendEvents("u", "s", [ev("a", "holdem")], told, down), 0);
    assert.equal(told.size, 0);
  });
});
