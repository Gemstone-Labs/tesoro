import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { AnchorProvider, BN, Program, type Idl } from "@coral-xyz/anchor";
import { Connection } from "@solana/web3.js";
import idl from "../../lib/chain/idl/trading_duel.json";
import { ASSETS, DRAW, NO_WINNER, STATUS, decodeBook, decodeDuel, type Book, type Duel } from "./chain";
import { NO_PICK, newTrack, record } from "./grid";
import { gridInputs, mergePicks, pickOpen, settlePending } from "./matchView";

const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const blank = () => Array.from({ length: 12 }, () => NO_PICK);
const row = (over: Record<number, number>) => blank().map((v, c) => over[c] ?? v);

const duel = (over: Partial<Duel> = {}): Duel => ({
  address: key(1),
  matchId: 1n,
  tesoroMatch: key(2),
  players: [key(3), key(4)],
  asset: ASSETS[0],
  status: STATUS.live,
  finalized: false,
  winner: NO_WINNER,
  startDeadline: 0,
  startsAt: 1000,
  gridAt: 1030,
  endsAt: 1150,
  anchor: 142_50000000n,
  step: 35_62500n,
  lastTick: 1000,
  track: record(newTrack(), 0, 142_50000000n),
  revealed: [blank(), blank()],
  scores: [0, 0],
  ...over,
});
const book = (seat: 0 | 1, picks: number[]): Book => ({ address: key(9), duel: key(1), player: key(3 + seat), seat, picks, pickCount: picks.filter((p) => p !== NO_PICK).length });

describe("your picks", () => {
  it("come from your Book with unconfirmed picks laid over them", () => {
    const b = book(0, row({ 2: 5, 3: 4 }));
    expect(mergePicks(b, null, { 3: 6, 4: 1 })).toEqual(row({ 2: 5, 3: 6, 4: 1 }));
  });

  it("show a pending clear as no pick", () => {
    expect(mergePicks(book(0, row({ 2: 5 })), null, { 2: NO_PICK })).toEqual(blank());
  });

  it("fall back to what the Duel revealed when the Book cannot be read", () => {
    expect(mergePicks(null, row({ 0: 3 }), { 5: 2 })).toEqual(row({ 0: 3, 5: 2 }));
    expect(mergePicks(null, null, {})).toEqual(blank());
  });

  it("stop being pending once the Book shows them", () => {
    const b = book(1, row({ 3: 6 }));
    expect(settlePending({ 3: 6, 4: 1 }, b)).toEqual({ 4: 1 });
    expect(settlePending({ 3: 6 }, null)).toEqual({ 3: 6 });
  });
});

describe("the grid inputs by seat", () => {
  const d = duel({ revealed: [row({ 0: 4, 1: 5 }), row({ 0: 2, 1: 7 })], scores: [100, 300] });

  it("map the opponent to the other seat", () => {
    expect(gridInputs(d, 0, book(0, row({ 0: 4 })), {}).theirs).toEqual(row({ 0: 2, 1: 7 }));
    expect(gridInputs(d, 1, book(1, row({ 0: 2 })), {}).theirs).toEqual(row({ 0: 4, 1: 5 }));
  });

  it("have no result until the Match is over, then points you versus them", () => {
    expect(gridInputs(d, 1, null, {}).final).toBeNull();
    const over = duel({ ...d, status: STATUS.over, winner: 1 });
    expect(gridInputs(over, 1, null, {}).final).toEqual({ you: 300, them: 100 });
    expect(gridInputs(over, 0, null, {}).final).toEqual({ you: 100, them: 300 });
  });

  it("ignore unconfirmed picks once the Match is over", () => {
    const over = duel({ ...d, status: STATUS.over, winner: DRAW });
    expect(gridInputs(over, 0, null, { 9: 3 }).mine).toEqual(row({ 0: 4, 1: 5 }));
  });
});

describe("decoding accounts with the program IDL", () => {
  // The same construction as the app client, so field names come out as the app reads them.
  const coder = new Program(idl as unknown as Idl, new AnchorProvider(new Connection("http://localhost:8899"), {} as never, {})).coder.accounts;
  const bn = (n: number | bigint) => new BN(n.toString());
  const raw = {
    bump: 255, authorityBump: 254, matchId: bn(5), tesoroMatch: key(2), players: [key(3), key(4)], asset: 1, status: 1, finalized: false, winner: 255,
    startDeadline: bn(1), startsAt: bn(1000), gridAt: bn(1030), endsAt: bn(1150), anchor: bn(300000000000n), step: bn(60000000n), lastTick: bn(1001),
    track: { lo: Array.from({ length: 12 }, (_, c) => bn(c)), hi: Array.from({ length: 12 }, (_, c) => bn(c + 1)), seen: 0b101, last: bn(0), lastCol: -1 },
    revealed: [row({ 0: 3 }), row({ 0: 5 })], scores: [0, 100],
  };

  it("reads the Duel: bitmask to Track, no price yet, revealed picks by seat", async () => {
    const d = decodeDuel(key(1), coder.decode("duel", await coder.encode("duel", raw)));
    expect(d.asset.symbol).toBe("ETH");
    expect(d.startsAt).toBe(1000);
    expect(d.anchor).toBe(300000000000n);
    expect(d.track.seen.slice(0, 4)).toEqual([true, false, true, false]);
    expect(d.track.last).toBeNull();
    expect(d.track.lastCol).toBe(-1);
    expect(d.track.lo[3]).toBe(3n);
    expect(d.revealed[1][0]).toBe(5);
    expect(d.scores).toEqual([0, 100]);
  });

  it("reads a Book", async () => {
    const b = decodeBook(key(9), coder.decode("book", await coder.encode("book", { bump: 1, duel: key(1), player: key(3), seat: 1, picks: row({ 2: 6 }), pickCount: 1 })));
    expect(b.seat).toBe(1);
    expect(b.picks).toEqual(row({ 2: 6 }));
    expect(b.pickCount).toBe(1);
  });
});

describe("pick window", () => {
  it("closes ten seconds before the column starts, by the rollup clock", () => {
    const d = duel({ startsAt: 1000 });
    expect(pickOpen(d, 0, 1019_900)).toBe(true);
    expect(pickOpen(d, 0, 1020_000)).toBe(false);
    expect(pickOpen(d, 1, 1020_000)).toBe(true);
  });
});
