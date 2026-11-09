import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import { RAILCAR_PROGRAM_ID, checkDepartureIx, finalizeIx } from "@/games/railcar/chain";
import { layoutOf, type IdlWithTypes } from "@/lib/chain/idl-layout";
import { joinSeatIx, seatChunkIx, seatMarkPda, seatPagePda } from "@/lib/chain/many-seat";
import { initCkptPageIx } from "@/lib/chain/settle-plan";
import { DEFAULT_LIMITS } from "./policy";
import { CORE_ID, type Ix } from "./rules";
import { Sponsor, accountPda, basketPda, type ChainReads, type WireIx } from "./service";
import { MemoryUsageStore } from "./store";

const SOL = 1_000_000_000n;
const wire = (ixs: Ix[]): { ixs: WireIx[] } => ({
  ixs: ixs.map((i) => ({ program: i.programId.toBase58(), keys: i.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), signer: k.isSigner, writable: k.isWritable })), data: Buffer.from(i.data).toString("base64") })),
});
const key = () => Keypair.generate().publicKey;
const disc = (name: string) => Buffer.from((coreIdl as { accounts: { name: string; discriminator: number[] }[] }).accounts.find((a) => a.name === name)!.discriminator);

/** A sponsor with Railcar Listed, a Player who holds Gemas, and a boarding car. */
function setup() {
  const relayer = Keypair.generate();
  const player = Keypair.generate();
  const accounts = new Map<string, { owner: PublicKey; data: Uint8Array }>();
  const basket = Buffer.alloc(400);
  basket.writeBigUInt64LE(5_000n, 8 + 40);
  accounts.set(basketPda(accountPda(player.publicKey)).toBase58(), { owner: CORE_ID, data: basket });
  accounts.set(accountPda(player.publicKey).toBase58(), { owner: CORE_ID, data: new Uint8Array(10) });
  // The car: a many-seat Match record (its discriminator; the opener and n after the bump, listing epoch and payer).
  const car = key();
  const carData = Buffer.alloc(1127);
  disc("ManySeatMatch").copy(carData, 0);
  key().toBuffer().copy(carData, 45);
  accounts.set(car.toBase58(), { owner: CORE_ID, data: carData });
  const balance = 10n * SOL;
  const chain: ChainReads = {
    getTransaction: async () => null,
    balance: async () => balance,
    rent: async (bytes) => BigInt(bytes + 128) * 6960n,
    account: async (k) => accounts.get(k.toBase58()) ?? null,
    latestBlockhash: async () => "11111111111111111111111111111111",
    // The relayer pays the fee and the receipt's rent: what a Game step is meant to cost.
    simulate: async () => ({ err: null, lamports: balance - 5_000n - 400n - 1_275_080n }),
    send: async (raw) => VersionedTransaction.deserialize(raw) && "sig",
  };
  const sponsor = new Sponsor({
    relayer,
    macKey: Buffer.from("k"),
    store: new MemoryUsageStore(),
    limits: DEFAULT_LIMITS,
    chain,
    isListed: async (p) => p.equals(RAILCAR_PROGRAM_ID),
    lookupTables: async () => [],
    paused: async () => false,
    alertLowBalance: async () => undefined,
    lowBalance: 1n * SOL,
    now: () => 1_000_000,
  });
  return { sponsor, relayer, player, accounts, car };
}

/**
 * The Player's seat in the car: their mark, and a page whose seat names them and their seat key, laid out by the IDL's
 * types (many-seat.layouts.test.ts holds that layout to bytes core wrote). `seatKey` null: a page of another size
 * (the 160-byte seats before seat keys), which names no key.
 */
function seat(s: ReturnType<typeof setup>, seatKey: PublicKey | null) {
  const account = accountPda(s.player.publicKey);
  const idl = coreIdl as unknown as IdlWithTypes;
  const [M, P, S] = [layoutOf(idl, "SeatMark"), layoutOf(idl, "SeatPage"), layoutOf(idl, "Seat")];
  const mark = Buffer.alloc(8 + M.size);
  disc("SeatMark").copy(mark, 0);
  mark[8 + M.at.seat] = 12;
  s.car.toBuffer().copy(mark, 8 + M.at.match_key);
  account.toBuffer().copy(mark, 8 + M.at.account);
  s.accounts.set(seatMarkPda(s.car, account).toBase58(), { owner: CORE_ID, data: mark });
  const page = Buffer.alloc(seatKey ? 8 + P.size : 8 + 72 + 10 * 160);
  disc("SeatPage").copy(page, 0);
  s.car.toBuffer().copy(page, 8 + P.at.match_key);
  page[8 + P.at.index] = 1;
  const at = 8 + P.at.seats + 2 * S.size;
  page[at + S.at.state] = 1;
  account.toBuffer().copy(page, at + S.at.player);
  if (seatKey) seatKey.toBuffer().copy(page, at + S.at.signer);
  s.accounts.set(seatPagePda(s.car, 1).toBase58(), { owner: CORE_ID, data: page });
}

const seatAuth = (signer: PublicKey, match: PublicKey) => ({ kind: "seat", signer, match }) as const;

describe("Railcar on the sponsor", () => {
  it("builds a boarding vouched for by the login alone: the relayer pays, the wallet signs only the transaction", async () => {
    const s = setup();
    const join = joinSeatIx({ payer: s.relayer.publicKey, player: s.player.publicKey, car: s.car, game: RAILCAR_PROGRAM_ID, page: 0, pot: { address: key(), nonce: 1n, lines: 2 } });
    await expect(s.sponsor.build(s.player.publicKey, wire([join, checkDepartureIx(3n, s.car)]), "user-1", { kind: "token" })).resolves.toMatchObject({ class: "admission" });
  });

  it("refuses a departure check alone on the login: outside boarding it is a finish step for the seat key", async () => {
    const s = setup();
    await expect(s.sponsor.build(s.player.publicKey, wire([checkDepartureIx(3n, s.car)]), "user-1", { kind: "token" })).rejects.toMatchObject({ code: "wallet-only" });
  });

  it("builds the finish for the seat key the car names in the Player's seat: chunks and finalize, no wallet", async () => {
    const s = setup();
    const ana = key();
    seat(s, ana);
    const chunk = seatChunkIx(s.relayer.publicKey, s.car, 7, []);
    await expect(s.sponsor.build(s.player.publicKey, wire([chunk]), null, seatAuth(ana, s.car))).resolves.toMatchObject({ class: "exit" });
    const fin = finalizeIx(s.relayer.publicKey, { carNo: 3n, table: 1, tesoroMatch: s.car, payer: key() }, 2);
    await expect(s.sponsor.build(s.player.publicKey, wire([fin]), null, seatAuth(ana, s.car))).resolves.toMatchObject({ class: "exit" });
    await expect(s.sponsor.build(s.player.publicKey, wire([checkDepartureIx(3n, s.car)]), null, seatAuth(ana, s.car))).resolves.toMatchObject({ class: "exit" });
  });

  it("refuses another key, a stranger's request, and a seat of the layout before seat keys", async () => {
    const s = setup();
    seat(s, key());
    const chunk = seatChunkIx(s.relayer.publicKey, s.car, 7, []);
    await expect(s.sponsor.build(s.player.publicKey, wire([chunk]), null, seatAuth(key(), s.car))).rejects.toMatchObject({ code: "not-your-seat-key" });
    const old = setup();
    const k = key();
    seat(old, null);
    await expect(old.sponsor.build(old.player.publicKey, wire([seatChunkIx(old.relayer.publicKey, old.car, 7, [])]), null, seatAuth(k, old.car))).rejects.toMatchObject({ code: "not-your-seat-key" });
  });

  it("a seat key may ask for the checkpoint pages a chunk's fee cut needs: they name a book, not the car, and only the key the car names may ask", async () => {
    const s = setup();
    const ana = key();
    seat(s, ana);
    const pages = [initCkptPageIx(s.relayer.publicKey, key(), 1, 0), initCkptPageIx(s.relayer.publicKey, key(), 3, 0)];
    await expect(s.sponsor.build(s.player.publicKey, wire(pages), null, seatAuth(key(), s.car))).rejects.toMatchObject({ code: "not-your-seat-key" });
    // Ana's key passes; then the chain decides whether the pages are the book's and missing (here there is no book).
    await expect(s.sponsor.build(s.player.publicKey, wire(pages), null, seatAuth(ana, s.car))).rejects.toThrow(/book is invalid/);
  });

  it("a seat key may not ask for an entry, and finalize is only for the car's riders", async () => {
    const s = setup();
    const ana = key();
    seat(s, ana);
    const join = joinSeatIx({ payer: s.relayer.publicKey, player: s.player.publicKey, car: s.car, game: RAILCAR_PROGRAM_ID, page: 0, pot: { address: key(), nonce: 1n, lines: 2 } });
    await expect(s.sponsor.build(s.player.publicKey, wire([join, checkDepartureIx(3n, s.car)]), null, seatAuth(ana, s.car))).rejects.toMatchObject({ code: "wallet-only" });
    const stranger = setup();
    stranger.accounts.set(s.car.toBase58(), s.accounts.get(s.car.toBase58())!);
    const fin = finalizeIx(stranger.relayer.publicKey, { carNo: 3n, table: 1, tesoroMatch: s.car, payer: key() }, 2);
    await expect(stranger.sponsor.build(stranger.player.publicKey, wire([fin]))).rejects.toMatchObject({ code: "not-your-match" });
  });
});
