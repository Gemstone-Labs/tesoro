import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const stranger = Array.from(new PublicKey("11111111111111111111111111111112").toBytes());
const player = Array.from(new PublicKey("SysvarC1ock11111111111111111111111111111111").toBytes());
const side = { player, funder: player, shareBps: 0 };
const fees = { platformBps: 200, studioBps: 300 };
const bn = (n: number) => ({ toString: () => String(n) });
const match = (id: number, game: number[]) => ({
  publicKey: new PublicKey("SysvarRent111111111111111111111111111111111"),
  account: { id: bn(id), inner: { game, a: side, b: { ...side }, status: { settled: {} }, entry: bn(500), deadline: bn(0), fees } },
});
const request = (game: number[]) => ({ publicKey: new PublicKey("SysvarRent111111111111111111111111111111111"), account: { inner: { game, player, status: { open: {} }, entry: bn(500), expiresAt: bn(1) } } });

const rows = { matches: [] as any[], requests: [] as any[], offers: [] as any[] };

vi.mock("./client", () => {
  const chain = {
    base: { getMultipleAccountsInfo: async (keys: unknown[]) => keys.map(() => null) },
    core: {
      provider: { connection: {} },
      account: {
        matchState: { all: async () => rows.matches },
        requestState: { all: async () => rows.requests },
        offerState: { all: async () => rows.offers },
      },
    },
    bp: { coder: { accounts: { decode: () => null } } },
  };
  return {
    getChain: () => chain,
    getHoldem: () => ({ program: { coder: { accounts: { decode: () => null } } } }),
    getTradingDuel: () => ({ program: { coder: { accounts: { decode: () => null } } } }),
    getVanguard: () => ({}),
  };
});
vi.mock("./leaderboard", () => ({ fetchLeaderboardTerms: async () => undefined }));

beforeEach(() => {
  rows.matches = [match(2, stranger)];
  rows.requests = [request(stranger)];
  rows.offers = [];
});

describe("a Match of a program this app does not play", () => {
  it("is left out of an Account's Matches instead of breaking the read", async () => {
    const { fetchAccountMatches } = await import("./read");
    const out = await fetchAccountMatches(new PublicKey(Uint8Array.from(player)));
    expect(out).toEqual({ played: [], funded: [] });
  });

  it("is left out of the settled list", async () => {
    const { fetchSettled } = await import("./recent");
    expect(await fetchSettled({ limit: 5 })).toEqual([]);
  });

  it("is left out of the Backing board", async () => {
    const { fetchBackingBoard } = await import("./backing");
    const board = await fetchBackingBoard();
    expect(board.requests).toEqual([]);
  });
});
