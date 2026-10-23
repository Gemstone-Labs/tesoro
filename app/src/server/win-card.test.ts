import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { loadWin, type WinDeps } from "./win-card";

vi.mock("@/server/history/db", () => ({ supabaseRpc: async () => null }));

const A = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 1 : 9)));
const ID = { opener: A.toBase58(), n: 7n };
const profile = { nameLen: 3, name: [...Buffer.from("Ana")], avatar: { animal: [4] } };
const card = { id: `${A.toBase58()}-7`, game: "holdem", entry: 1000, winner: A.toBase58(), gemas: 900 };

const deps = (over: Partial<WinDeps> = {}): WinDeps => ({ card: async () => card, profile: async () => profile, ...over });

describe("loadWin (the Match history's card)", () => {
  it("loads a won, settled Match with the winner's Profile", async () => {
    expect(await loadWin(ID, deps())).toMatchObject({ id: card.id, game: "holdem", entry: 1000, gemas: 900, name: "Ana", avatar: 5 });
  });
  it("asks the history for the Match and the chain for the winner's Profile", async () => {
    const asked: string[] = [];
    const seen: string[] = [];
    await loadWin(ID, deps({ card: async (id) => (seen.push(`${id.opener}-${id.n}`), card), profile: async (k) => (asked.push(k.toBase58()), null) }));
    expect(seen).toEqual([card.id]);
    expect(asked).toEqual([A.toBase58()]);
  });
  it("is null for a Match the history does not know or that has no winner", async () => {
    expect(await loadWin(ID, deps({ card: async () => null }))).toBeNull();
  });
  it("is null when the history is not available", async () => {
    expect(await loadWin(ID, deps({ card: async () => Promise.reject(new Error("db")) }))).toBeNull();
  });
  it("is null for a Game this app does not play", async () => {
    expect(await loadWin(ID, deps({ card: async () => ({ ...card, game: "chess" }) }))).toBeNull();
  });
  it("still shows the card when the Profile cannot be read", async () => {
    const w = await loadWin(ID, deps({ profile: async () => Promise.reject(new Error("rpc")) }));
    expect(w?.name).toContain("…");
  });
});
