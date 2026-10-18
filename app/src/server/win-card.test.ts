import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { BLOCK_PUZZLE_PROGRAM_ID } from "@/games/block-puzzle/chain";
import { HOLDEM_PROGRAM_ID } from "@/games/holdem/chain";
import { VANGUARD_PROGRAM_ID } from "@/games/vanguard/chain";
import { loadWin, type WinDeps } from "./win-card";

const key = (n: number) => new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : 9)));
const bytes = (k: PublicKey) => Array.from(k.toBytes());
const side = (p: PublicKey) => ({ player: bytes(p), funder: bytes(p), shareBps: 0 });
const A = key(1);
const B = key(2);

const state = (status: string, game = BLOCK_PUZZLE_PROGRAM_ID) => ({
  id: new BN(7),
  inner: { game: bytes(game), entry: new BN(1000), fees: { platformBps: 500, studioBps: 500 }, status: { [status]: {} }, a: side(A), b: side(B), deadline: new BN(0) },
});
const session = (result: number, settled = true) => ({ settled, joined: true, result, scores: [3, 1], seed: new BN(0), openerDeadline: new BN(0), deadline: new BN(0) });
const profile = { nameLen: 3, name: [...Buffer.from("Ana")], avatar: { animal: [4] } };

const deps = (over: Partial<WinDeps> = {}): WinDeps => ({
  matchState: async () => state("settled"),
  gameAccount: async () => session(0),
  profile: async () => profile,
  ...over,
});

describe("loadWin", () => {
  it("loads a won, settled Block Puzzle Match with the winner's Profile", async () => {
    expect(await loadWin(7n, deps())).toMatchObject({ id: "7", game: "block-puzzle", entry: 1000, name: "Ana", avatar: 5 });
  });
  it("takes the winner of the second seat", async () => {
    const asked: string[] = [];
    const w = await loadWin(7n, deps({ gameAccount: async () => session(1), profile: async (k) => (asked.push(k.toBase58()), null) }));
    expect(asked).toEqual([B.toBase58()]);
    expect(w?.name).toContain("…");
  });
  it("loads a settled Hold'em table by its winner seat", async () => {
    const w = await loadWin(7n, deps({ matchState: async () => state("settled", HOLDEM_PROGRAM_ID), gameAccount: async () => ({ winner: 0 }) }));
    expect(w?.game).toBe("holdem");
  });
  it("loads a settled Vanguard Battle by its winning seat, and not a Battle with no winner", async () => {
    const vanguard = (winner: number) => deps({ matchState: async () => state("settled", VANGUARD_PROGRAM_ID), gameAccount: async () => ({ winner }) });
    expect(await loadWin(7n, vanguard(1))).toMatchObject({ game: "vanguard", entry: 1000 });
    expect(await loadWin(7n, vanguard(255))).toBeNull();
  });
  it("is null for a Match that does not exist", async () => {
    expect(await loadWin(7n, deps({ matchState: async () => null }))).toBeNull();
  });
  it.each(["open", "active", "refunded"])("is null for a %s Match", async (status) => {
    expect(await loadWin(7n, deps({ matchState: async () => state(status) }))).toBeNull();
  });
  it("is null for a draw and for a Session that has not settled", async () => {
    expect(await loadWin(7n, deps({ gameAccount: async () => session(2) }))).toBeNull();
    expect(await loadWin(7n, deps({ gameAccount: async () => session(0, false) }))).toBeNull();
    expect(await loadWin(7n, deps({ gameAccount: async () => null }))).toBeNull();
  });
  it("is null for a Game this app does not play", async () => {
    expect(await loadWin(7n, deps({ matchState: async () => state("settled", key(77)) }))).toBeNull();
  });
  it("still shows the card when the Profile cannot be read", async () => {
    const w = await loadWin(7n, deps({ profile: async () => Promise.reject(new Error("rpc")) }));
    expect(w?.name).toContain("…");
  });
});
