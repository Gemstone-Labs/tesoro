import { BN, BorshCoder } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import idl from "./idl/tesoro_core.json";
import { NO_LEADERBOARD, POOL_ACCOUNT, parseLeaderboardTerms, seasonPda, winsFromLogs } from "./leaderboard";
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

describe("MatchWon events", () => {
  it("are read from the logs of a settlement", () => {
    const player = PublicKey.unique();
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
    });
    const data = Buffer.concat([disc, body]);
    const logs = [`Program ${idl.address} invoke [2]`, `Program data: ${data.toString("base64")}`, `Program ${idl.address} success`];
    expect(winsFromLogs(logs, "sig")).toEqual([{ player: player.toBase58(), points: 10, ts: 1_791_200_100, matchId: "7" }]);
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
