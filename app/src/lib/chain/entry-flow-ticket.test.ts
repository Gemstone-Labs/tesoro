import { Keypair, PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountOfSigner, type ChainSigner } from "@/games/block-puzzle/chain";
import { SeatKeyManager, memorySeatKeyStore, setSeatKeysForTest } from "@/lib/seat/seat-key";
import { decodeStore, matchPda, ticketPda } from "./basket";
import { encodeStore } from "./basket-fixture";
import { matchKeyOf } from "./match-id";
import coreIdl from "./idl/tesoro_core.json";
import { GAME_IDS } from "./games";
import { SponsorError } from "./sponsor-client";
import { joinTargetTag, openTargetTag } from "./ticket-target";

// Seat-keys ticket 14: Ana's 20-line entry is staged in an Entry Ticket bound to her Match; the seat key alone sends the entry.
type Sent = { signer: ChainSigner; ixs: { keys: { pubkey: PublicKey; isSigner: boolean }[] }[]; opts: Record<string, unknown> };
const sent: Sent[] = [];
const relayer = Keypair.generate().publicKey;
const prepared: { targetTag?: bigint }[] = [];
let refuseSeatAlone = false;
const stores = (account: PublicKey) => ({ account, basket: decodeStore(encodeStore([])), spill: decodeStore(encodeStore([])), nextMatch: 5n });

vi.mock("./client", () => ({ getChain: () => ({ base: {} }) }));
vi.mock("./game-listing", () => ({ assertGameListed: async () => undefined }));
vi.mock("./sponsor-client", async (orig) => ({ ...(await orig<typeof import("./sponsor-client")>()), requestTable: async () => true }));
vi.mock("./ticket", async (orig) => ({
  ...(await orig<typeof import("./ticket")>()),
  prepareEntryTicket: async (a: { signer: ChainSigner; targetTag?: bigint }) => {
    prepared.push({ targetTag: a.targetTag });
    const account = accountOfSigner(a.signer);
    return { address: ticketPda(account, 3n), kind: "entry", nonce: 3n, lineCap: 22, targetTag: a.targetTag ?? 0n, expiresAt: Math.floor(Date.now() / 1000) + 3600 - 60 };
  },
}));
vi.mock("./entry", async (orig) => {
  const real = await orig<typeof import("./entry")>();
  return {
    ...real,
    readEntryStores: async (a: PublicKey) => stores(a),
    previewEntry: () => ({ needsTicket: true, potLines: 2, plan: { steps: [] }, ticketLines: 22 }),
    drawRemaining: async () => [],
    relayerKey: async () => relayer,
    readMatchState: async () => ({ inner: { game: Array.from(GAME_IDS.holdem.toBytes()), a: { player: Array.from(opener.toBytes()), funder: Array.from(opener.toBytes()) }, potLines: [2], terms: {} }, room: [] }),
    sendEntryTx: async (signer: ChainSigner, _t: unknown, build: (p: PublicKey, s: boolean) => Promise<Sent["ixs"]>, opts: Record<string, unknown> = {}) => {
      const ixs = await build(relayer, true);
      sent.push({ signer, ixs, opts });
      const walletOut = !ixs.some((i) => i.keys.some((k) => k.isSigner && k.pubkey.equals(walletKp.publicKey)));
      if (refuseSeatAlone && walletOut) throw new SponsorError("This entry needs your wallet.", "wallet-signs", 403);
      return { sig: "sig", sponsored: true, table: false };
    },
  };
});

import { joinEntry, openEntry } from "./entry-flow";

const opener = Keypair.generate().publicKey;
const walletKp = Keypair.generate();
const wallet: ChainSigner = { publicKey: walletKp.publicKey, signTransaction: async (t) => t, signMessage: async () => new Uint8Array(64) };
const at = (ix: string, name: string) => (coreIdl.instructions as { name: string; accounts: { name: string }[] }[]).find((i) => i.name === ix)!.accounts.findIndex((a) => a.name === name);
let manager: SeatKeyManager;

beforeEach(() => {
  sent.length = 0;
  prepared.length = 0;
  refuseSeatAlone = false;
  manager = new SeatKeyManager({ store: memorySeatKeyStore() });
  setSeatKeysForTest(manager);
});

describe("an entry staged in an Entry Ticket", () => {
  it("binds the Ticket to the Match Ana opens and sends open_match with the seat key alone", async () => {
    const out = await openEntry({ signer: wallet, getToken: async () => null, game: "holdem", entry: 500, challenge: false });
    const me = accountOfSigner(wallet);
    expect(prepared[0].targetTag).toBe(await openTargetTag(matchPda(me, 5n), false, 0));
    const seat = (await manager.find(out.key, walletKp.publicKey))!;
    const ix = sent.at(-1)!.ixs[0];
    expect(ix.keys[at("open_match", "player_authority")]).toMatchObject({ pubkey: walletKp.publicKey, isSigner: false });
    expect(ix.keys[at("open_match", "seat_signer")]).toMatchObject({ pubkey: seat.publicKey, isSigner: true });
    // the signer is the seat key; the wallet with the seat key pays when the relayer cannot
    expect(sent.at(-1)!.signer.publicKey.equals(seat.publicKey)).toBe(true);
    expect((sent.at(-1)!.opts.selfPay as ChainSigner).publicKey.equals(walletKp.publicKey)).toBe(true);
  });

  it("binds a join to the Match Ana joins", async () => {
    const key = matchKeyOf({ opener: opener.toBase58(), n: 9n });
    await joinEntry({ signer: wallet, getToken: async () => null, game: "holdem", entry: 500, key });
    expect(prepared[0].targetTag).toBe(await joinTargetTag(matchPda(opener, 9n)));
    const join = sent.at(-1)!.ixs.at(-1)!;
    expect(join.keys[at("join_match", "player_authority")].isSigner).toBe(false);
  });

  it("asks the wallet after all when the sponsor wants it", async () => {
    refuseSeatAlone = true;
    await openEntry({ signer: wallet, getToken: async () => null, game: "holdem", entry: 500, challenge: false });
    const last = sent.at(-1)!;
    expect(last.ixs[0].keys[at("open_match", "player_authority")]).toMatchObject({ pubkey: walletKp.publicKey, isSigner: true });
    expect(last.signer.publicKey.equals(walletKp.publicKey)).toBe(true);
  });
});
