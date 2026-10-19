import { BN, BorshCoder } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import idl from "./idl/tesoro_core.json";
import { NO_LEADERBOARD, POOL_ACCOUNT, parseEntrySizes, parseLeaderboardTerms, poolTotalOf, seasonPda, winsFromLogs } from "./leaderboard";
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
    expect(decoded.games).toHaveLength(3);
    expect(decoded.leaderboard_bps ?? decoded.leaderboardBps).toBe(0);
    expect((decoded.pool_account ?? decoded.poolAccount).equals(PublicKey.default)).toBe(true);
  });
});

describe("MatchWon events", () => {
  it("are read from the logs of a settlement", () => {
    const player = PublicKey.unique();
    const loser = PublicKey.unique();
    const disc = Buffer.from(idl.events.find((e) => e.name === "MatchWon")!.discriminator);
    const body = new BorshCoder(idl as never).types.encode("MatchWon", {
      match_id: new BN(7),
      game: PublicKey.unique(),
      entry: new BN(1000),
      player,
      funder: player,
      points: new BN(10),
      pool_fee: new BN(20),
      season: 1,
      ts: new BN(1_791_200_100),
      loser,
    });
    const data = Buffer.concat([disc, body]);
    const logs = [`Program ${idl.address} invoke [2]`, `Program data: ${data.toString("base64")}`, `Program ${idl.address} success`];
    expect(winsFromLogs(logs, "sig")).toEqual([{ player: player.toBase58(), points: 10, ts: 1_791_200_100, matchId: "7", loser: loser.toBase58() }]);
    // An event from before the loser was named is the same bytes without it: read, and never capped.
    const old = Buffer.concat([disc, body.subarray(0, body.length - 32)]);
    expect(winsFromLogs([`Program data: ${old.toString("base64")}`], "sig")).toEqual([
      { player: player.toBase58(), points: 10, ts: 1_791_200_100, matchId: "7" },
    ]);
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
  it("sums own and won Gemas of the pool Account", () => {
    const at = 8 + 1 + 32 + 20;
    const bytes = new Uint8Array(at + 32 + 5);
    const d = new DataView(bytes.buffer);
    d.setBigUint64(at, 1_500n, true);
    d.setBigUint64(at + 8, 2n ** 40n, true);
    expect(poolTotalOf(bytes)).toBe(1_500n + 2n ** 40n);
  });
});
