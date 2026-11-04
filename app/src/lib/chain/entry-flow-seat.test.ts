import { Keypair, PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountOfSigner, type ChainSigner } from "@/games/block-puzzle/chain";
import { SeatKeyManager, memorySeatKeyStore, setSeatKeysForTest } from "@/lib/seat/seat-key";
import { decodeStore, matchPda } from "./basket";
import { encodeStore } from "./basket-fixture";
import { matchKeyOf } from "./match-id";
import coreIdl from "./idl/tesoro_core.json";
import { GAME_IDS } from "./games";

const sent: { signer: ChainSigner; ixs: { keys: { pubkey: PublicKey; isSigner: boolean }[] }[]; opts: Record<string, unknown> }[] = [];
const requestTable = vi.fn(async () => true);
let tableNeeded = false;
let matchState: unknown = null;
const stores = (account: PublicKey) => ({ account, basket: decodeStore(encodeStore([])), spill: decodeStore(encodeStore([])), nextMatch: 5n });

vi.mock("./client", () => ({ getChain: () => ({ base: {} }) }));
vi.mock("./game-listing", () => ({ assertGameListed: async () => undefined }));
vi.mock("./sponsor-client", async (orig) => ({ ...(await orig<typeof import("./sponsor-client")>()), requestTable: (...a: unknown[]) => requestTable(...(a as [])) }));
vi.mock("./entry", async (orig) => {
  const real = await orig<typeof import("./entry")>();
  return {
    ...real,
    readEntryStores: async (a: PublicKey) => stores(a),
    previewEntry: () => ({ needsTicket: false, potLines: 2, plan: { steps: [] }, ticketLines: 3 }),
    drawRemaining: async () => [],
    freshPotNow: async (f: PublicKey, lines: number) => real.freshPot(f, lines, 0n),
    relayerKey: async () => null,
    readMatchState: async () => matchState,
    sendEntryTx: async (signer: ChainSigner, _t: unknown, build: (p: PublicKey, s: boolean) => Promise<{ keys: { pubkey: PublicKey; isSigner: boolean }[] }[]>, opts: Record<string, unknown> = {}) => {
      sent.push({ signer, ixs: await build(signer.publicKey, false), opts });
      return { sig: "sig", sponsored: false, table: tableNeeded };
    },
  };
});

import { joinEntry, openEntry } from "./entry-flow";

const walletKp = Keypair.generate();
const wallet: ChainSigner = { publicKey: walletKp.publicKey, signTransaction: async (t) => t, signMessage: async () => new Uint8Array(64) };
const seatAt = (name: string) => (coreIdl.instructions as { name: string; accounts: { name: string }[] }[]).find((i) => i.name === name)!.accounts.findIndex((a) => a.name === "seat_signer");
let manager: SeatKeyManager;

beforeEach(() => {
  sent.length = 0;
  requestTable.mockClear();
  tableNeeded = false;
  manager = new SeatKeyManager({ store: memorySeatKeyStore() });
  setSeatKeysForTest(manager);
});

describe("opening a Match", () => {
  it("makes the key before the Match exists, under the Match's key, and names it in open_match with the wallet", async () => {
    const out = await openEntry({ signer: wallet, getToken: async () => null, game: "holdem", entry: 500, challenge: false });
    const me = accountOfSigner(wallet);
    expect(out.key).toBe(matchKeyOf({ opener: me.toBase58(), n: 5n }));
    const seat = (await manager.find(out.key, walletKp.publicKey))!;
    expect(seat).not.toBeNull();
    const ix = sent[0].ixs[0];
    expect(ix.keys[seatAt("open_match")].pubkey.equals(seat.publicKey)).toBe(true);
    expect(ix.keys[seatAt("open_match")].isSigner).toBe(true);
    // the entry is sent by a signer that signs as the wallet and adds the seat key
    expect(sent[0].signer.publicKey.equals(walletKp.publicKey)).toBe(true);
    expect((sent[0].signer as unknown as { seatKey: PublicKey }).seatKey.equals(seat.publicKey)).toBe(true);
    void GAME_IDS;
    void matchPda;
  });

  it("reuses the key when the page reloads before the Match lands (same n, same key)", async () => {
    const a = await openEntry({ signer: wallet, getToken: async () => null, game: "holdem", entry: 500, challenge: false });
    const first = (await manager.find(a.key, walletKp.publicKey))!;
    setSeatKeysForTest(new SeatKeyManager({ store: (manager as unknown as { store: ReturnType<typeof memorySeatKeyStore> }).store }));
    await openEntry({ signer: wallet, getToken: async () => null, game: "holdem", entry: 500, challenge: false });
    expect(sent[1].ixs[0].keys[seatAt("open_match")].pubkey.equals(first.publicKey)).toBe(true);
  });

  it("refuses to be handed a seat key as the wallet", async () => {
    const seat = await manager.forMatch(`${Keypair.generate().publicKey.toBase58()}-1`, walletKp.publicKey);
    await expect(openEntry({ signer: seat, getToken: async () => null, game: "holdem", entry: 500, challenge: false })).rejects.toThrow("An entry is signed by the wallet.");
  });
});

describe("joining a Match", () => {
  const opener = Keypair.generate().publicKey;
  const bytes = (k: PublicKey) => Array.from(k.toBytes());
  beforeEach(() => {
    matchState = { inner: { game: bytes(GAME_IDS.holdem), a: { player: bytes(opener), funder: bytes(opener) }, potLines: [2], terms: {} }, room: [] };
  });

  it("names a fresh key for that Match in join_match, and asks for the table when the join went out without one", async () => {
    tableNeeded = true;
    const key = matchKeyOf({ opener: opener.toBase58(), n: 9n });
    await joinEntry({ signer: wallet, getToken: async () => null, game: "holdem", entry: 500, key });
    const seat = (await manager.find(key, walletKp.publicKey))!;
    const ix = sent.at(-1)!.ixs[0];
    expect(ix.keys[seatAt("join_match")].pubkey.equals(seat.publicKey)).toBe(true);
    expect(requestTable).toHaveBeenCalledTimes(1);
    const [signer, , match] = requestTable.mock.calls[0] as unknown as [ChainSigner, unknown, PublicKey];
    expect(signer.publicKey.equals(seat.publicKey)).toBe(true);
    expect(match.equals(matchPda(opener, 9n))).toBe(true);
  });

  it("does not ask for a table when the join carried its own", async () => {
    await joinEntry({ signer: wallet, getToken: async () => null, game: "holdem", entry: 500, key: matchKeyOf({ opener: opener.toBase58(), n: 10n }) });
    expect(requestTable).not.toHaveBeenCalled();
  });
});
