import { BN, BorshCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { vi, beforeAll, describe, expect, it } from "vitest";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import { backedSplit, feeGemas } from "@/lib/chain/ledger";
import { historyPage } from "@/lib/chain/history";
import { topScores } from "@/lib/chain/settled";
import { decodeMatchRecords, type InnerInstruction } from "./events";
import { ingestMatchRecords, type IngestContext } from "./ingest";
import { matchKeyOf, parseMatchKey } from "./match-key";
import { accountHistory, matchPage, playerForms, recentWins, seasonWins, winCard } from "./reads";
import { testDb } from "./test-db";
import type { Rpc } from "./rpc";

// A fresh in-process Postgres takes several seconds to start when the machine is busy.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const CORE = (coreIdl as { address: string }).address;
const coder = new BorshCoder(coreIdl as Idl);
const EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], new PublicKey(CORE))[0].toBase58();
const TAG = Buffer.from("e445a52e51cb9a1d", "hex");

const key = (seed: number) => new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? seed : (seed * 7 + i) % 251))).toBase58();
const GAME = { holdem: key(101), bp: key(102), td: key(103), unknown: key(104) };
const gameOf = (p: string) => (p === GAME.holdem ? "holdem" : p === GAME.bp ? "block-puzzle" : p === GAME.td ? "trading-duel" : null);
const [ALICE, BOB, CARL, DANA, ERIN] = [1, 2, 3, 4, 5].map(key);

/** One event-CPI inner instruction exactly as core emits it: tag + discriminator + Borsh body. */
function cpi(name: string, body: Record<string, unknown>, programId = CORE, authority = EVENT_AUTHORITY): InnerInstruction {
  const wire = (v: unknown): unknown => (typeof v === "bigint" ? new BN(v.toString()) : Array.isArray(v) ? v.map(wire) : v);
  const legacy = name === "MatchChunkDone" && !Object.hasOwn(body, "lines");
  const input = legacy ? { ...body, record_version: 1, first_step: 0, lines: [] } : body;
  const encoded = coder.types.encode(name, Object.fromEntries(Object.entries(input).map(([k, v]) => [k, wire(v)])));
  const bytes = legacy ? encoded.subarray(0, 54) : encoded;
  const disc = Buffer.from((coreIdl as any).events.find((e: any) => e.name === name).discriminator);
  return { programId, accounts: [authority], data: Buffer.concat([TAG, disc, bytes]) };
}
const pk = (s: string) => new PublicKey(s);
const bn = (n: number | bigint) => BigInt(n);

interface Seed {
  opener: string;
  n: number;
  game: string;
  entry: number;
  at: number;
  a: [string, string];
  b: [string, string] | null;
  kind?: number;
  winner?: 0 | 1;
  fees?: [number, number, number];
  season?: number;
  points?: number;
  challenge?: boolean;
  asset?: number;
  shares?: [number, number];
}

function instructionsFor(s: Seed): InnerInstruction[] {
  const kind = s.kind ?? 0;
  const fees = s.fees ?? [Math.floor((s.entry * 2 * 200) / 10_000), Math.floor((s.entry * 2 * 300) / 10_000), Math.floor((s.entry * 2 * 100) / 10_000)];
  const zero = PublicKey.default;
  const out = [
    cpi("MatchRunStarted", {
      opener: pk(s.opener), n: bn(s.n), game: pk(s.game), kind, winner: kind === 0 ? s.winner! : 255, entry: bn(s.entry),
      fees: fees.map(bn), a_player: pk(s.a[0]), a_funder: pk(s.a[1]), b_player: s.b ? pk(s.b[0]) : zero, b_funder: s.b ? pk(s.b[1]) : zero,
      challenge: s.challenge ?? false, asset: s.asset ?? 0, opened_at: bn(s.at), ts: bn(s.at + 600),
      a_share_bps: s.shares?.[0] ?? 0, b_share_bps: s.shares?.[1] ?? 0,
    }),
  ];
  if (kind === 0) {
    const w = s.winner === 0 ? s.a : s.b!;
    const l = s.winner === 0 ? s.b! : s.a;
    out.unshift(cpi("MatchWon", {
      opener: pk(s.opener), n: bn(s.n), game: pk(s.game), entry: bn(s.entry), player: pk(w[0]), funder: pk(w[1]), points: bn(s.points ?? 5),
      pool_fee: bn(fees[2]), season: s.season ?? 3, ts: bn(s.at + 600), loser: pk(l[0]), challenge: s.challenge ?? false, asset: s.asset ?? 0, opened_at: bn(s.at),
    }));
  }
  out.push(cpi("MatchChunkDone", { opener: pk(s.opener), n: bn(s.n), chunk_no: 1, steps: 4, done: false, blocked: false }));
  out.push(cpi("MatchChunkDone", { opener: pk(s.opener), n: bn(s.n), chunk_no: 2, steps: 2, done: true, blocked: false }));
  out.push(cpi("MatchSettled", { opener: pk(s.opener), n: bn(s.n), kind, chunks: 2 }));
  return out;
}

const T0 = 1_760_000_000;
const ctx = (extra: Partial<IngestContext> = {}): IngestContext => ({ gameOf, signature: "sig", slot: 9, ...extra });

describe("Match history from core events", () => {
  let rpc: Rpc;
  const keyOf = (opener: string, n: number) => matchKeyOf({ opener, n: BigInt(n) });

  // 25 Matches for ALICE (opener or joiner), a backed one, a Block Burst one with scores, a draw, a refund.
  const seeds: Seed[] = [];
  const detail: Record<string, { scores?: [number, number] }> = {};

  beforeAll(async () => {
    ({ rpc } = await testDb());
    for (let i = 0; i < 25; i++) {
      const aliceOpens = i % 2 === 0;
      const aliceWins = i % 3 !== 0;
      seeds.push({
        opener: aliceOpens ? ALICE : BOB, n: i + 1, game: i % 5 === 0 ? GAME.bp : GAME.holdem, entry: 500, at: T0 + i * 1000,
        a: aliceOpens ? [ALICE, ALICE] : [BOB, BOB], b: aliceOpens ? [BOB, BOB] : [ALICE, ALICE],
        winner: (aliceOpens === aliceWins ? 0 : 1) as 0 | 1, season: 3, points: 5,
      });
    }
    // Backed: CARL plays with ERIN's Gemas at a 40% share, wins against ALICE; and loses to DANA.
    seeds.push({ opener: CARL, n: 1, game: GAME.holdem, entry: 1000, at: T0 + 30_000, a: [CARL, ERIN], b: [ALICE, ALICE], winner: 0, shares: [4000, 0] });
    seeds.push({ opener: DANA, n: 1, game: GAME.holdem, entry: 1000, at: T0 + 31_000, a: [DANA, DANA], b: [CARL, ERIN], winner: 0, shares: [0, 4000] });
    // Trading Duel with an asset, Block Burst with scores, a draw and a cancelled (never joined) Match.
    seeds.push({ opener: ALICE, n: 100, game: GAME.td, entry: 500, at: T0 + 32_000, a: [ALICE, ALICE], b: [BOB, BOB], winner: 0, asset: 2, challenge: true });
    seeds.push({ opener: BOB, n: 101, game: GAME.bp, entry: 500, at: T0 + 33_000, a: [BOB, BOB], b: [ALICE, ALICE], winner: 1 });
    detail[keyOf(BOB, 101)] = { scores: [310, 480] };
    seeds.push({ opener: ALICE, n: 102, game: GAME.holdem, entry: 500, at: T0 + 34_000, a: [ALICE, ALICE], b: [BOB, BOB], kind: 2 });
    seeds.push({ opener: ALICE, n: 103, game: GAME.holdem, entry: 500, at: T0 + 35_000, a: [ALICE, ALICE], b: null, kind: 3 });
    // An unfinished run: started, never settled.
    seeds.push({ opener: ALICE, n: 104, game: GAME.holdem, entry: 500, at: T0 + 36_000, a: [ALICE, ALICE], b: [BOB, BOB], winner: 0 });

    for (const s of seeds) {
      let recs = decodeMatchRecords(instructionsFor(s));
      if (s.n === 104 && s.opener === ALICE) recs = recs.filter((r) => r.type !== "settled");
      await ingestMatchRecords(rpc, recs, ctx({ detail: (k) => detail[k] }));
    }
  }, 120_000);

  it("decodes only events core itself emitted", () => {
    const forged = [
      cpi("MatchWon", { opener: pk(ALICE), n: 1n, game: pk(GAME.holdem), entry: 1n, player: pk(ALICE), funder: pk(ALICE), points: 9n, pool_fee: 1n, season: 3, ts: 1n, loser: pk(BOB), challenge: false, asset: 0, opened_at: 1n }, key(77)),
      cpi("MatchWon", { opener: pk(ALICE), n: 1n, game: pk(GAME.holdem), entry: 1n, player: pk(ALICE), funder: pk(ALICE), points: 9n, pool_fee: 1n, season: 3, ts: 1n, loser: pk(BOB), challenge: false, asset: 0, opened_at: 1n }, CORE, key(78)),
    ];
    expect(decodeMatchRecords(forged)).toEqual([]);
    expect(decodeMatchRecords(instructionsFor(seeds[0])).map((r) => r.type)).toEqual(["won", "start", "chunk", "chunk", "settled"]);
  });

  it("returns the same history pages as the chain rows would (paging, order, results, deltas)", async () => {
    const page1 = await accountHistory(rpc, ALICE, 1);
    expect(page1.total).toBe(25 + 1 + 1 + 1 + 1 + 1); // 104 is unfinished; the cancelled Match (no joiner) is a refund
    // Expected rows from the same pure ledger rules the chain reads use, newest first.
    const expected = seeds
      .filter((s) => !(s.opener === ALICE && s.n === 104) && (s.opener === ALICE || s.b?.[0] === ALICE))
      .map((s) => {
        const seat = s.a[0] === ALICE ? 0 : 1;
        const fee = Number(feeGemas(BigInt(s.entry), 200, 300, 100));
        const won = s.kind === 3 || s.kind === 2 ? null : s.winner === seat;
        return { id: keyOf(s.opener, s.n), at: (s.at) * 1000, result: s.kind === 2 ? "draw" : s.kind === 3 ? "refunded" : won ? "won" : "lost", delta: won === null ? 0 : won ? s.entry - fee : -s.entry };
      })
      .sort((a, b) => b.at - a.at);
    const paged = historyPage(expected, 1);
    expect(page1.pages).toBe(paged.pages);
    expect(page1.rows.map((r) => ({ id: r.id, at: r.at, result: r.result, delta: r.delta }))).toEqual(paged.rows);
    const last = await accountHistory(rpc, ALICE, 99);
    expect(last.page).toBe(last.pages);
    expect(last.rows.map((r) => r.id)).toEqual(historyPage(expected, 99).rows.map((r) => r.id));
  });

  it("scores flip to the viewer's side, asset shows for Trading Duel only, and the opponent is named", async () => {
    const all = (await accountHistory(rpc, ALICE, 1, 100)).rows;
    const bp = all.find((r) => r.id === keyOf(BOB, 101))!;
    expect(bp.scores).toEqual([480, 310]); // ALICE was side 1 and won
    expect(bp.opp).toBe(BOB);
    expect(bp.result).toBe("won");
    expect(all.find((r) => r.id === keyOf(ALICE, 100))!.asset).toBe(2);
    expect(all.find((r) => r.id === keyOf(ALICE, 1))!.asset).toBeNull();
  });

  it("splits a Backing by the backedSplit rule for the Player and the Backer", async () => {
    const split = backedSplit({ entry: 1000, platformBps: 200, studioBps: 300, leaderboardBps: 100, shareBps: 4000, won: true });
    const player = (await accountHistory(rpc, CARL, 1, 100)).rows.find((r) => r.id === keyOf(CARL, 1))!;
    const backer = (await accountHistory(rpc, ERIN, 1, 100)).rows.find((r) => r.id === keyOf(CARL, 1))!;
    expect(player).toMatchObject({ role: "player", result: "won", delta: split.playerNet, backing: { other: ERIN, shareBps: 4000 } });
    expect(backer).toMatchObject({ role: "backer", result: "won", delta: split.backerNet, backing: { other: CARL, shareBps: 4000 } });
    // The backed loss: Player 0, Backer -entry.
    const lostPlayer = (await accountHistory(rpc, CARL, 1, 100)).rows.find((r) => r.id === keyOf(DANA, 1))!;
    const lostBacker = (await accountHistory(rpc, ERIN, 1, 100)).rows.find((r) => r.id === keyOf(DANA, 1))!;
    expect(lostPlayer).toMatchObject({ result: "lost", delta: 0 });
    expect(lostBacker).toMatchObject({ result: "lost", delta: -1000 });
  });

  it("is idempotent and order independent", async () => {
    const { rpc: fresh } = await testDb();
    const s = seeds[1];
    const recs = decodeMatchRecords(instructionsFor(s));
    expect(await ingestMatchRecords(fresh, [...recs].reverse(), ctx())).toBe(recs.length);
    expect(await ingestMatchRecords(fresh, recs, ctx())).toBe(0);
    const id = parseMatchKey(keyOf(s.opener, s.n))!;
    const page = await matchPage(fresh, id);
    expect(page).toMatchObject({ status: "settled", kind: 0, chunks: 2, winner: (s.winner === 0 ? s.a : s.b!)[0], season: 3 });
    // The settle record alone, before the start, never makes a Match visible.
    const only = decodeMatchRecords(instructionsFor(seeds[2])).filter((r) => r.type === "settled");
    await ingestMatchRecords(fresh, only, ctx());
    expect(await matchPage(fresh, parseMatchKey(keyOf(seeds[2].opener, seeds[2].n))!)).toBeNull();
  });

  it("serves the Match page, with unfinished runs shown as settling", async () => {
    const done = await matchPage(rpc, { opener: BOB, n: 101n });
    expect(done).toMatchObject({ id: keyOf(BOB, 101), game: "block-puzzle", entry: 500, status: "settled", scores: [310, 480], winnerSide: 1, openedAt: (T0 + 33_000) * 1000 });
    expect(done!.sides[1]).toEqual({ player: ALICE, funder: ALICE });
    expect(done!.parties.map((p) => p.account)).toEqual([BOB, ALICE]);
    const running = await matchPage(rpc, { opener: ALICE, n: 104n });
    expect(running).toMatchObject({ status: "settling", chunks: 2 });
    expect(await matchPage(rpc, { opener: ALICE, n: 99999n })).toBeNull();
  });

  it("serves the win card only for a settled Match with a winner", async () => {
    expect(await winCard(rpc, { opener: ALICE, n: 100n })).toEqual({ id: keyOf(ALICE, 100), game: "trading-duel", entry: 500, winner: ALICE, gemas: 500 - 20 - 30 - 10 });
    // Backed Player: the winner's gain is their share only.
    const split = backedSplit({ entry: 1000, platformBps: 200, studioBps: 300, leaderboardBps: 100, shareBps: 4000, won: true });
    expect((await winCard(rpc, { opener: CARL, n: 1n }))!.gemas).toBe(split.playerNet);
    expect(await winCard(rpc, { opener: ALICE, n: 102n })).toBeNull(); // draw
    expect(await winCard(rpc, { opener: ALICE, n: 103n })).toBeNull(); // cancelled
    expect(await winCard(rpc, { opener: ALICE, n: 104n })).toBeNull(); // not settled
  });

  it("serves recent wins like the Lobby ticker (winner, payout, scores of the winner first)", async () => {
    const wins = await recentWins(rpc, { limit: 3 });
    expect(wins.map((w) => w.id)).toEqual([keyOf(BOB, 101), keyOf(ALICE, 100), keyOf(DANA, 1)]);
    expect(wins[0]).toMatchObject({ winner: ALICE, payout: 1000 - 60, scores: [480, 310], game: "block-puzzle", at: (T0 + 33_000) * 1000 });
    const bp = await recentWins(rpc, { game: "block-puzzle", limit: 50 });
    expect(bp.every((w) => w.game === "block-puzzle")).toBe(true);
    expect(topScores(bp.map((w) => ({ ...w, id: "x-0", game: "block-puzzle" as const })), 1)).toEqual([[ALICE, 480]]);
    const recent = await recentWins(rpc, { since: (T0 + 31_000) * 1000, limit: 50 });
    expect(recent.map((w) => w.id).sort()).toEqual([keyOf(DANA, 1), keyOf(BOB, 101), keyOf(ALICE, 100)].sort());
    expect(recent.every((w) => w.at >= (T0 + 31_000) * 1000)).toBe(true);
  });

  it("charges each side the Platform Fee of a no-show, to the Backer when the entry is backed", async () => {
    const { rpc: fresh } = await testDb();
    const fee = 10; // 200 bps of a 500 entry, per side
    const seed: Seed = { opener: ALICE, n: 7, game: GAME.holdem, entry: 500, at: T0, a: [ALICE, ALICE], b: [CARL, ERIN], kind: 1, fees: [2 * fee, 0, 0], shares: [0, 4000] };
    await ingestMatchRecords(fresh, decodeMatchRecords(instructionsFor(seed)), ctx());
    const alice = (await accountHistory(fresh, ALICE, 1, 10)).rows[0];
    const carl = (await accountHistory(fresh, CARL, 1, 10)).rows[0];
    const erin = (await accountHistory(fresh, ERIN, 1, 10)).rows[0];
    expect(alice).toMatchObject({ result: "no-show", delta: -fee });
    expect(carl).toMatchObject({ role: "player", delta: 0 });
    expect(erin).toMatchObject({ role: "backer", delta: -fee });
  });

  it("takes Backing shares from the start record, not from the keeper", async () => {
    const recs = decodeMatchRecords(instructionsFor({ opener: CARL, n: 9, game: GAME.holdem, entry: 1000, at: T0, a: [CARL, ERIN], b: [ALICE, ALICE], winner: 0, shares: [4000, 0] }));
    expect(recs.find((r) => r.type === "start")).toMatchObject({ aShareBps: 4000, bShareBps: 0 });
  });

  it("serves each Player's record for the Backing board", async () => {
    const forms = await playerForms(rpc, [ALICE, ERIN, key(99)]);
    const mine = seeds.filter((s) => s.kind === undefined && !(s.opener === ALICE && s.n === 104) && (s.a[0] === ALICE || s.b?.[0] === ALICE));
    const wins = mine.filter((s) => (s.a[0] === ALICE ? 0 : 1) === s.winner).length;
    expect(forms.get(ALICE)).toMatchObject({ matches: mine.length, wins });
    expect(forms.get(ALICE)!.pnl).toHaveLength(mine.length);
    expect(forms.has(ERIN)).toBe(false); // a Backer is not a Player
    expect(forms.has(key(99))).toBe(false);
    expect(await playerForms(rpc, [])).toEqual(new Map());
  });

  it("serves a Season's wins for the Leaderboard, one per MatchWon", async () => {
    const wins = await seasonWins(rpc, 3);
    expect(wins).toHaveLength(seeds.filter((s) => (s.kind ?? 0) === 0).length);
    expect(wins[0]).toMatchObject({ points: 5, ts: T0 + 600, loser: expect.any(String) });
    expect(await seasonWins(rpc, 4)).toEqual([]);
  });
});

describe("Match keys", () => {
  it("round-trips and refuses malformed ids", () => {
    const k = { opener: ALICE, n: 18446744073709551615n };
    expect(parseMatchKey(matchKeyOf(k))).toEqual(k);
    for (const bad of ["", "7", `${ALICE}-`, `${ALICE}-01`, `${ALICE}-18446744073709551616`, `0${ALICE.slice(1)}-1`, `${ALICE}-1x`, `short-1`]) expect(parseMatchKey(bad)).toBeNull();
  });
});

describe("Access", () => {
  it("keeps the tables and functions away from the public roles", async () => {
    const { sql } = await testDb();
    await sql.exec("set role anon");
    await expect(sql.query("select * from public.match_history")).rejects.toThrow(/permission denied/);
    await expect(sql.query("select public.recent_wins(null, null, 5)")).rejects.toThrow(/permission denied/);
    await sql.exec("reset role");
  });
});
