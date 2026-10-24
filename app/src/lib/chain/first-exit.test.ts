import { Keypair, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { beforeEach, expect, it, vi } from "vitest";
import { bookPda } from "./basket";
import { encodeBook, freshClass } from "./basket-fixture";
import { fp } from "./book";

const mocks = vi.hoisted(() => ({
  send: vi.fn(async (signer: unknown, ixs: TransactionInstruction[]) => { void signer; void ixs; return "own"; }),
  sponsored: vi.fn(async (signer: unknown, token: unknown, ixs: TransactionInstruction[]) => { void signer; void token; void ixs; return "free"; }),
  stores: new Map<string, Buffer>(), relayer: "",
}));
vi.mock("./client", () => ({ getChain: () => ({
  base: { getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => {
    const data = mocks.stores.get(k.toBase58()); return data ? { data } : null;
  }) }, sendBase: mocks.send,
}) }));
vi.mock("./sponsor-client", async (orig) => ({
  ...await orig<typeof import("./sponsor-client")>(),
  sponsorStatus: async () => ({ relayer: mocks.relayer, paused: false }), sponsoredSend: mocks.sponsored,
}));
import { redeemLine } from "./redeem";
import { TESORO_CORE_ID } from "./native";
import { SponsorError } from "./sponsor-client";
import { requestInstantRedeem } from "./instant-order";
const me = Keypair.generate().publicKey, relayer = Keypair.generate().publicKey, source = Keypair.generate().publicKey;
const signer = { publicKey: me, signSerialized: vi.fn() } as unknown as Parameters<typeof redeemLine>[0];
const holding = { line: { side: 1, dueAt: 9n, class: 3, tranche: 0 }, accounts: [] as PublicKey[], source, position: Keypair.generate().publicKey, stakeMint: null, eth: null, native: true };
beforeEach(() => {
  mocks.send.mockClear(); mocks.sponsored.mockReset(); mocks.sponsored.mockResolvedValue("free"); mocks.stores.clear(); mocks.relayer = relayer.toBase58();
  mocks.stores.set(bookPda(source).toBase58(), encodeBook([freshClass(), freshClass(), freshClass(), { ...freshClass(), uncovered: fp(10n), w: fp(10n) }]));
});

it("sponsors the first native Redeem including its missing ATA and checkpoint page", async () => {
  expect(await redeemLine(signer, async () => null, holding, 1n)).toBe("free");
  expect(mocks.send).not.toHaveBeenCalled();
  const ixs = mocks.sponsored.mock.calls[0][2] as TransactionInstruction[];
  expect(ixs).toHaveLength(3);
  expect(ixs.slice(0, -1).every((ix) => ix.keys[0].pubkey.equals(relayer))).toBe(true);
  expect(ixs.at(-1)!.keys[0].pubkey.equals(me)).toBe(true);
});

it("sponsors a first Instant Redeem request with the same missing preparation", async () => {
  expect(await requestInstantRedeem(signer, async () => null, holding, 1n)).toBe("free");
  expect(mocks.send).not.toHaveBeenCalled();
  const ixs = mocks.sponsored.mock.calls[0][2] as TransactionInstruction[];
  expect(ixs).toHaveLength(3);
  expect(ixs.slice(0, -1).every((ix) => ix.keys[0].pubkey.equals(relayer))).toBe(true);
});

it.each(["sponsor-empty", "sponsor-paused", "setup-already-funded"])("self-pays an Instant request with only the Player's signature after %s", async (code) => {
  mocks.sponsored.mockRejectedValueOnce(new SponsorError("Unavailable", code, 503));
  expect(await requestInstantRedeem(signer, async () => null, holding, 1n)).toBe("own");
  const ixs = mocks.send.mock.calls[0][1] as TransactionInstruction[];
  expect(ixs.every((ix) => ix.keys[0].pubkey.equals(me))).toBe(true);
  expect(ixs.at(-1)!.keys[8].pubkey.equals(TESORO_CORE_ID)).toBe(true);
  expect(ixs.flatMap((ix) => ix.keys.filter((k) => k.isSigner)).every((k) => k.pubkey.equals(me))).toBe(true);
});
