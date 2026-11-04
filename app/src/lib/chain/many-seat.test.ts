import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import idl from "./idl/tesoro_core.json";
import { closeCarIx, closeSeatIx, decodeCar, decodeSeatMark, decodeSeatPage, joinPage, joinSeatIx, seatMarkPda, seatPagePda, stepOffIx, type SeatView } from "./many-seat";
import { TESORO_CORE, matchPda } from "./basket";

const accounts = new BorshAccountsCoder(idl as unknown as Idl);
/** The IDL's own Borsh layout of an account (the same bytes as in place: every field is a byte array), with its discriminator. */
const coder = {
  async encode(name: string, value: unknown): Promise<Buffer> {
    const layout = (accounts as unknown as { accountLayouts: Map<string, { layout: { encode(v: unknown, b: Buffer): number } }> }).accountLayouts.get(name)!.layout;
    const body = Buffer.alloc(4096);
    const len = layout.encode(value, body);
    return Buffer.concat([Buffer.from(accounts.accountDiscriminator(name)), body.subarray(0, len)]);
  },
};
const le = (n: bigint | number, len: number) => {
  const out: number[] = [];
  let v = BigInt(n);
  for (let i = 0; i < len; i++) {
    out.push(Number(v & 0xffn));
    v >>= 8n;
  }
  return out;
};
const key = () => Keypair.generate().publicKey;
const bytes = (k: PublicKey) => Array.from(k.toBytes());
const zeros = (n: number) => new Array(n).fill(0);

const blankPlace = () => ({ seat: 0, share_bps: zeros(2), player_share_bps: zeros(2), won: zeros(8), player: zeros(32), funder: zeros(32) });
const blankRun = () => ({
  kind: 0,
  phase: 0,
  n_places: 0,
  place_i: 0,
  seat_i: 0,
  in_seat: 0,
  visited: 0,
  fees_capped: 0,
  line_i: zeros(4),
  seat_left: zeros(8),
  won_left: zeros(8),
  player_left: zeros(8),
  fees: [zeros(8), zeros(8), zeros(8)],
  cut_left: [zeros(8), zeros(8), zeros(8)],
  chunks: zeros(4),
  steps: zeros(4),
  places: Array.from({ length: 10 }, blankPlace),
});

describe("many-seat account decoders read what the program writes", () => {
  it("a car: id, entry, seat bounds, countdown times, stage and the frozen run", async () => {
    const opener = key();
    const studio = key();
    const payer = key();
    const dee = key();
    const run = blankRun();
    run.kind = 0;
    run.phase = 1;
    run.n_places = 3;
    run.seat_i = 4;
    run.line_i = le(2, 4);
    run.seat_left = le(150, 8);
    run.cut_left = [le(44, 8), le(64, 8), le(21, 8)];
    run.fees = [le(44, 8), le(64, 8), le(21, 8)];
    run.places[0] = { seat: 3, share_bps: le(6000, 2), player_share_bps: le(4000, 2), won: le(313, 8), player: bytes(dee), funder: bytes(payer) };
    const data = await coder.encode("ManySeatMatch", {
      bump: 254,
      listing_epoch: le(2, 4),
      payer: bytes(payer),
      inner: {
        opener: bytes(opener),
        n: le(7, 8),
        game: zeros(32),
        settle_authority: zeros(32),
        studio_owner: bytes(studio),
        deploy_slot: le(99, 8),
        entry: le(500, 8),
        opened_at: le(1_000, 8),
        deadline_abs: le(605_800, 8),
        min_since: le(1_050, 8),
        first_min_at: le(1_040, 8),
        departed_at: le(1_070, 8),
        platform_bps: le(200, 2),
        studio_bps: le(300, 2),
        has_studio_owner: 1,
        studio_priority: 0,
        challenge: 0,
        asset: 0,
        listed: 1,
        min_seats: 5,
        max_seats: 100,
        seated: 5,
        pages: 1,
        stage: 3,
        reserved: zeros(6),
        refund_after: le(87_470, 8),
        run,
      },
    });
    const address = matchPda(opener, 7n);
    const car = decodeCar(address, data);
    expect(car.address.equals(address)).toBe(true);
    expect(car.opener.equals(opener)).toBe(true);
    expect(car.n).toBe(7n);
    expect(car.payer.equals(payer)).toBe(true);
    expect(car.entry).toBe(500n);
    expect([car.minSeats, car.maxSeats, car.seated, car.pages]).toEqual([5, 100, 5, 1]);
    expect([car.minSince, car.firstMinAt, car.departedAt, car.refundAfter]).toEqual([1_050, 1_040, 1_070, 87_470]);
    expect(car.stage).toBe("settling");
    expect(car.studioOwner?.equals(studio)).toBe(true);
    expect(car.listed).toBe(true);
    expect(car.run.phase).toBe("forfeits");
    expect(car.run.seatI).toBe(4);
    expect(car.run.lineI).toBe(2);
    expect(car.run.seatLeft).toBe(150n);
    expect(car.run.cutLeft).toEqual([44n, 64n, 21n]);
    expect(car.run.places).toHaveLength(3);
    expect(car.run.places[0]).toMatchObject({ seat: 3, shareBps: 6000, playerShareBps: 4000, won: 313n });
    expect(car.run.places[0].player.equals(dee)).toBe(true);
  });

  it("a seat page: its ten seats with Player, funder, Pot, refund and place", async () => {
    const match = key();
    const ana = key();
    const backer = key();
    const pot = key();
    const seat = (i: number) =>
      i === 2
        ? {
            state: 1,
            flags: 0,
            share_bps: le(4000, 2),
            place_bps: le(2500, 2),
            place: 2,
            reserved0: 0,
            pot_lines: le(3, 4),
            hold: le(5, 4),
            counted: zeros(8),
            counted_window: zeros(8),
            refund: le(350, 8),
            player: bytes(ana),
            funder: bytes(backer),
            pot: bytes(pot),
            reserved: zeros(24),
          }
        : { state: 0, flags: 0, share_bps: zeros(2), place_bps: zeros(2), place: 0, reserved0: 0, pot_lines: zeros(4), hold: zeros(4), counted: zeros(8), counted_window: zeros(8), refund: zeros(8), player: zeros(32), funder: zeros(32), pot: zeros(32), reserved: zeros(24) };
    const data = await coder.encode("SeatPage", { match_key: bytes(match), payer: bytes(ana), bump: 255, index: 1, reserved: zeros(6), seats: Array.from({ length: 10 }, (_, i) => seat(i)) });
    const page = decodeSeatPage(data);
    expect(page.index).toBe(1);
    expect(page.matchKey.equals(match)).toBe(true);
    expect(page.payer.equals(ana)).toBe(true);
    expect(page.seats).toHaveLength(10);
    const s = page.seats[2];
    expect(s.index).toBe(12);
    expect(s.seated).toBe(true);
    expect(page.seats[3].seated).toBe(false);
    expect(s.player.equals(ana)).toBe(true);
    expect(s.funder.equals(backer)).toBe(true);
    expect(s.pot.equals(pot)).toBe(true);
    expect([s.shareBps, s.placeBps, s.place, s.potLines, s.hold]).toEqual([4000, 2500, 2, 3, 5]);
    expect(s.refund).toBe(350n);
  });

  it("a page written with the seat-key layout (192-byte seats) reads the same fields", () => {
    const match = key();
    const ana = key();
    const SEAT = 192;
    const data = new Uint8Array(8 + 72 + 10 * SEAT);
    data.set(match.toBytes(), 8);
    data[8 + 64 + 1] = 0;
    const at = 80 + 3 * SEAT;
    data[at] = 1;
    data.set(ana.toBytes(), at + 40);
    const page = decodeSeatPage(data);
    expect(page.seats).toHaveLength(10);
    expect(page.seats[3].seated).toBe(true);
    expect(page.seats[3].player.equals(ana)).toBe(true);
  });

  it("a seat mark: which seat, whether its lines are on the way home, who paid it", async () => {
    const match = key();
    const ana = key();
    const payer = key();
    const data = await coder.encode("SeatMark", { bump: 1, seat: 12, returning: 1, reserved: 0, hold: le(4, 4), match_key: bytes(match), account: bytes(ana), payer: bytes(payer), match_seed: zeros(40), funder: bytes(ana), pot: zeros(32) });
    const m = decodeSeatMark(data);
    expect([m.seat, m.returning, m.hold]).toEqual([12, true, 4]);
    expect(m.account.equals(ana)).toBe(true);
    expect(m.payer.equals(payer)).toBe(true);
  });

  it("pages and marks sit at the program's seeds", () => {
    const match = key();
    const ana = key();
    expect(seatPagePda(match, 3).equals(PublicKey.findProgramAddressSync([Buffer.from("seat_page"), match.toBuffer(), Buffer.from([3])], TESORO_CORE)[0])).toBe(true);
    expect(seatMarkPda(match, ana).equals(PublicKey.findProgramAddressSync([Buffer.from("seat"), match.toBuffer(), ana.toBuffer()], TESORO_CORE)[0])).toBe(true);
  });
});

describe("many-seat instructions name the accounts the program checks", () => {
  const spec = (name: string) => (idl as unknown as { instructions: { name: string; accounts: { name: string }[] }[] }).instructions.find((i) => i.name === name)!;
  const named = (ix: { keys: { pubkey: PublicKey; isWritable: boolean; isSigner: boolean }[] }, name: string) => Object.fromEntries(spec(name).accounts.map((a, i) => [a.name, ix.keys[i].pubkey.equals(TESORO_CORE) ? null : ix.keys[i].pubkey]));
  const car = key();
  const seatOf = (o: Partial<SeatView>): SeatView => ({ index: 12, seated: true, shareBps: 0, placeBps: 0, place: 0, potLines: 1, hold: 0, refund: 0n, player: key(), funder: key(), pot: key(), signer: null, ...o });

  it("a backed seat's step-off and close pass the Backer's mark; an unbacked one does not", () => {
    const ana = key();
    const backer = key();
    const backed = seatOf({ player: ana, funder: backer, hold: 3 });
    const off = named(stepOffIx({ caller: ana, car, seat: backed, markPayer: ana, potPayer: ana, sponsor: true }), "step_off_many_seat_match");
    expect(off.funder_mark?.equals(seatMarkPda(car, backer))).toBe(true);
    expect(off.seat_page?.equals(seatPagePda(car, 1))).toBe(true);
    const close = named(closeSeatIx({ caller: ana, car, seat: backed, markPayer: ana, potPayer: ana, sponsor: false }), "close_many_seat");
    expect(close.funder_mark?.equals(seatMarkPda(car, backer))).toBe(true);
    expect(close.sponsor).toBeNull();
    const own = seatOf({ player: ana, funder: ana, hold: 0 });
    const plain = named(closeSeatIx({ caller: ana, car, seat: own, markPayer: ana, potPayer: ana, sponsor: false }), "close_many_seat");
    expect(plain.funder_mark).toBeNull();
    // No slots left held in the funder's spill: the spill is not needed.
    expect(plain.funder_spill).toBeNull();
  });

  it("a join with an Offer names the Backer's stores and the Backer's mark in this car", () => {
    const wallet = key();
    const backerAccount = key();
    const offer = key();
    const game = key();
    const ix = joinSeatIx({ payer: wallet, player: wallet, car, game, page: 0, pot: { address: key(), nonce: 3n, lines: 2 }, backing: { offer, backerAccount } });
    const a = named(ix, "join_many_seat_match");
    expect(a.offer?.equals(offer)).toBe(true);
    expect(a.funder_mark?.equals(seatMarkPda(car, backerAccount))).toBe(true);
    expect(ix.keys.find((k) => k.pubkey.equals(wallet))?.isSigner).toBe(true);
  });

  it("a join names the first page with an empty seat, or the next page when every page is full", () => {
    const full = { index: 0, matchKey: car, payer: car, seats: Array.from({ length: 10 }, (_, i) => seatOf({ index: i })) };
    expect(joinPage({ pages: 1, maxSeats: 100 }, [full])).toBe(1);
    const gap = { ...full, seats: full.seats.map((s, i) => (i === 4 ? { ...s, seated: false } : s)) };
    expect(joinPage({ pages: 1, maxSeats: 100 }, [gap])).toBe(0);
  });

  it("closing the car passes each page followed by who paid it, in page order", () => {
    const p0 = { index: 0, matchKey: car, payer: key(), seats: [] };
    const p1 = { index: 1, matchKey: car, payer: key(), seats: [] };
    const ix = closeCarIx(key(), { address: car, payer: key() }, [p1, p0]);
    const rest = ix.keys.slice(spec("close_many_seat_match").accounts.length).map((k) => k.pubkey);
    expect(rest.map((k) => k.toBase58())).toEqual([seatPagePda(car, 0), p0.payer, seatPagePda(car, 1), p1.payer].map((k) => k.toBase58()));
  });
});
