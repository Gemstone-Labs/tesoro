import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchBackingBoard } from "./backing";
import { GAME_IDS } from "./games";

const key = (n: number) => Array.from(new PublicKey(Uint8Array.from({ length: 32 }, () => n)).toBytes());
const backer = key(1);
const player = key(2);
const opener = key(2);
const game = Array.from(GAME_IDS["block-puzzle"].toBytes());
const bn = (n: number) => ({ toString: () => String(n) });
const NOW = 2_000_000_000;

const offer = (status: string) => ({
  publicKey: new PublicKey(Uint8Array.from({ length: 32 }, () => 9)),
  account: { nonce: bn(1), inner: { backer, game, entry: bn(500), playerShareBps: 5000, status: { [status]: {} }, expiresAt: bn(NOW), useBy: bn(NOW), player, request: key(7), ticketOpen: false } },
});
const match = (stage: string, deadline: number, joined: boolean) => ({
  publicKey: new PublicKey(Uint8Array.from({ length: 32 }, () => 8)),
  account: {
    inner: {
      id: { opener, n: bn(3) },
      game,
      entry: bn(500),
      stage: { [stage]: {} },
      deadline: bn(deadline),
      openedAt: bn(NOW - 1000),
      a: { player, funder: backer, shareBps: 0 },
      b: joined ? { player: key(5), funder: key(5), shareBps: 0 } : null,
    },
  },
});

const rows = { matches: [] as any[], requests: [] as any[], offers: [] as any[] };
vi.mock("./client", () => {
  const chain = {
    core: { account: { matchState: { all: async () => rows.matches }, requestState: { all: async () => rows.requests }, offerState: { all: async () => rows.offers } } },
  };
  return { getChain: () => chain };
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
  rows.requests = [];
  rows.offers = [offer("consumed")];
});

describe("the Backer's refund of a Match nobody joined", () => {
  it("is offered once the Match is open and past its deadline", async () => {
    rows.matches = [match("open", NOW - 10, false)];
    const [o] = (await fetchBackingBoard()).offers;
    expect(o.refundableMatchId).toBe(o.matchId);
    expect(o.refundableMatchId).not.toBeNull();
  });

  it("waits for the deadline", async () => {
    rows.matches = [match("open", NOW + 600, false)];
    expect((await fetchBackingBoard()).offers[0].refundableMatchId).toBeNull();
  });

  it("is not offered for a Match that someone joined", async () => {
    rows.matches = [match("active", NOW - 10, true)];
    expect((await fetchBackingBoard()).offers[0].refundableMatchId).toBeNull();
  });

  it("is not offered once the Match is already refunding", async () => {
    rows.matches = [match("refunding", NOW - 10, false)];
    expect((await fetchBackingBoard()).offers[0].refundableMatchId).toBeNull();
  });
});
