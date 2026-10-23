import { BN, BorshCoder } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import idl from "./idl/tesoro_core.json";
import bs58 from "bs58";
import { NO_LEADERBOARD, POOL_ACCOUNT, parseEntrySizes, parseLeaderboardTerms, poolTotalOf, seasonPda, seasonRecordOf, winsFromInner } from "./leaderboard";
import { encodeStore, lineOf } from "./basket-fixture";
import { leaderboardBpsFor, setLeaderboardSince } from "./season";

const HEAD = 8 + 1 + 32 + 32 + 2 + 32;

function config(games: number, tail?: { bps: number; pool: PublicKey; since: number }): Buffer {
  const buf = Buffer.alloc(HEAD + 4 + games * 98 + (tail ? 42 : 0) + 20);
  buf.writeUInt32LE(games, HEAD);
  if (tail) {
    const at = HEAD + 4 + games * 98;
    buf.writeUInt16LE(tail.bps, at);
    tail.pool.toBuffer().copy(buf, at + 2);
    buf.writeBigInt64LE(BigInt(tail.since), at + 34);
  }
  return buf;
}

describe("Config leaderboard terms", () => {
  it("reads the fee after the Games list wherever it sits", () => {
    for (const games of [0, 3, 8]) {
      expect(parseLeaderboardTerms(config(games, { bps: 100, pool: POOL_ACCOUNT, since: 1_791_200_000 }))).toEqual({
        bps: 100,
        recipient: POOL_ACCOUNT,
        since: 1_791_200_000,
      });
    }
  });
  it("is off for a Config that predates the Leaderboard or has no pool", () => {
    expect(parseLeaderboardTerms(config(3))).toEqual(NO_LEADERBOARD);
    expect(parseLeaderboardTerms(config(3, { bps: 100, pool: PublicKey.default, since: 0 }).subarray(0, HEAD + 4 + 3 * 98))).toEqual(NO_LEADERBOARD);
  });
});

describe("Config entry sizes", () => {
  const withSizes = (games: number, sizes: number[]) => {
    const base = config(games, { bps: 100, pool: POOL_ACCOUNT, since: 1_791_200_000 });
    const buf = Buffer.concat([base, Buffer.alloc(32)]);
    const at = HEAD + 4 + games * 98 + 42;
    sizes.forEach((n, i) => buf.writeBigUInt64LE(BigInt(n), at + i * 8));
    return buf;
  };
  it("reads the sizes after the Leaderboard fields, wherever the Games list ends", () => {
    for (const games of [0, 3, 8]) expect(parseEntrySizes(withSizes(games, [100, 500, 1000]))).toEqual([100, 500, 1000]);
  });
  it("is null while none is set, and for a Config that predates the field", () => {
    expect(parseEntrySizes(withSizes(3, []))).toBeNull();
    expect(parseEntrySizes(config(3).subarray(0, HEAD + 4 + 3 * 98 + 42))).toBeNull();
  });
});

describe("a Config still in the old layout (app deployed before the upgrade)", () => {
  // The account as created before the Leaderboard: 895 bytes, 3 Games, nothing after them.
  const legacy = () => {
    const buf = config(3);
    const legacyBuf = Buffer.alloc(895);
    buf.copy(legacyBuf, 0, 0, HEAD + 4 + 3 * 98);
    Buffer.from(idl.accounts.find((a) => a.name === "Config")!.discriminator).copy(legacyBuf, 0);
    return legacyBuf;
  };
  it("reads as the leaderboard being off, with no fee shown", () => {
    expect(parseLeaderboardTerms(legacy())).toEqual(NO_LEADERBOARD);
    setLeaderboardSince(parseLeaderboardTerms(legacy()).since);
    expect(leaderboardBpsFor(1_791_300_000_000)).toBe(0);
  });
  it("still decodes with the new IDL (the unused tail is zero)", () => {
    const decoded: any = new BorshCoder(idl as never).accounts.decode("Config", legacy());
    expect(decoded.legacyGames ?? decoded.legacy_games).toHaveLength(3);
    expect(decoded.leaderboard_bps ?? decoded.leaderboardBps).toBe(0);
    expect((decoded.pool_account ?? decoded.poolAccount).equals(PublicKey.default)).toBe(true);
  });
});

describe("MatchWon events", () => {
  const player = PublicKey.unique();
  const loser = PublicKey.unique();
  const opener = PublicKey.unique();
  const core = new PublicKey(idl.address);
  const eventAuthority = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], core)[0];
  const tag = Buffer.from("e445a52e51cb9a1d", "hex");
  const body = (over: Record<string, unknown> = {}) =>
    new BorshCoder(idl as never).types.encode("MatchWon", {
      opener,
      n: new BN(7),
      game: PublicKey.unique(),
      entry: new BN(1000),
      player,
      funder: player,
      points: new BN(10),
      pool_fee: new BN(20),
      season: 1,
      ts: new BN(1_791_200_100),
      loser,
      challenge: false,
      asset: 0,
      opened_at: new BN(1_791_200_000),
      ...over,
    });
  const disc = Buffer.from(idl.events.find((e) => e.name === "MatchWon")!.discriminator);
  const data = () => Buffer.concat([tag, disc, body()]);
  const real = () => ({ programId: core.toBase58(), accounts: [eventAuthority.toBase58()], data: data() });

  it("are read from the event-CPI inner instructions of a settlement, naming the Match by opener and counter", () => {
    expect(winsFromInner([real()])).toEqual([{ player: player.toBase58(), points: 10, ts: 1_791_200_100, matchId: `${opener.toBase58()}-7`, loser: loser.toBase58() }]);
  });

  it("counts only events tesoro_core wrote (a forged win in another program, with the wrong authority, or with another tag is ignored)", () => {
    const fake = PublicKey.unique().toBase58();
    expect(winsFromInner([{ ...real(), programId: fake }])).toEqual([]);
    expect(winsFromInner([{ ...real(), accounts: [PublicKey.unique().toBase58()] }])).toEqual([]);
    expect(winsFromInner([{ ...real(), data: Buffer.concat([Buffer.alloc(8), disc, body()]) }])).toEqual([]);
    expect(winsFromInner([{ ...real(), data: Buffer.from(bs58.encode(data())) }])).toEqual([]);
    // a program log carrying the same bytes is not an instruction at all: nothing to read
    expect(winsFromInner([])).toEqual([]);
    expect(winsFromInner([real(), { ...real(), programId: fake }])).toHaveLength(1);
  });
});

describe("the Pool's Gemas", () => {
  it("is the playable total of its basket and spill (a store that is not there counts 0)", () => {
    const src = PublicKey.unique();
    const basket = encodeStore([lineOf({ source: src, amount: 700n }), lineOf({ source: src, amount: 300n, side: 1, dueAt: 5n })]);
    const spill = encodeStore([lineOf({ source: src, amount: 50n })]);
    expect(poolTotalOf(basket, spill)).toBe(1050n);
    expect(poolTotalOf(basket, null)).toBe(1000n);
    expect(poolTotalOf(null)).toBe(0n);
  });
});

describe("a recorded Season", () => {
  it("reads the frozen budget: prizes are each rank's share of every budget line, paid when the cursor passed all lines", () => {
    const w = (n: number) => Array.from(Buffer.alloc(32, n));
    const line = (amount: number) => ({ side: 1, class: 3, tranche: 0, dueAt: new BN(0), source: w(9), amount: new BN(amount), paid: new BN(0) });
    const rec = seasonRecordOf({
      inner: {
        number: 4,
        window: { number: 4, recordedAt: new BN(1_791_300_000), voidedMask: 0b10 },
        count: 3,
        winners: [w(1), w(2), w(3), ...Array.from({ length: 7 }, () => w(0))],
        points: [30, 20, 10, ...Array.from({ length: 7 }, () => 0)].map((n) => new BN(n)),
        lines: [line(10_000), line(2_000)],
        cursor: [2, 0, 1, 0, 0, 0, 0, 0, 0, 0],
        closed: false,
      },
    });
    expect(rec.number).toBe(4);
    expect(rec.poolTotal).toBe(12_000n);
    expect(rec.amounts).toEqual([3000n, 2160n, 1560n]);
    expect(rec.paidMask).toBe(0b001);
    expect(rec.voidedMask).toBe(0b10);
    expect(rec.recordedAt).toBe(1_791_300_000);
    expect(rec.winners[1]).toBe(new PublicKey(Buffer.alloc(32, 2)).toBase58());
  });
});

describe("fee display", () => {
  it("charges the Leaderboard Fee only to Matches opened after it started", () => {
    expect(leaderboardBpsFor(2_000_000_000_000)).toBe(0);
    setLeaderboardSince(1_791_200_000);
    expect(leaderboardBpsFor(1_791_199_999_000)).toBe(0);
    expect(leaderboardBpsFor(1_791_200_000_000)).toBe(100);
    setLeaderboardSince(0);
  });
  it("derives stable addresses", () => {
    expect(seasonPda(1).equals(seasonPda(2))).toBe(false);
  });
});

describe("decoders on a plain Uint8Array (no Buffer methods)", () => {
  it("reads the fee from a view at a non-zero offset", () => {
    const src = config(3, { bps: 100, pool: POOL_ACCOUNT, since: 1_791_200_000 });
    const padded = new Uint8Array(src.length + 7);
    padded.set(src, 7);
    expect(parseLeaderboardTerms(padded.subarray(7))).toEqual({ bps: 100, recipient: POOL_ACCOUNT, since: 1_791_200_000 });
  });
});
