import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import idl from "../../lib/chain/idl/railcar.json";
import { seatPagePda } from "../../lib/chain/many-seat";
import { checkDepartureIx, decodeTable, finalizeIx, jumpIx, openCarIx, carPda, tablePda, NO_SEAT } from "./chain";

const coder = new BorshAccountsCoder(idl as unknown as Idl);
const layout = (name: string) => (coder as unknown as { accountLayouts: Map<string, { layout: { encode(v: unknown, b: Buffer): number } }> }).accountLayouts.get(name)!.layout;
const encode = (name: string, value: unknown) => {
  const body = Buffer.alloc(16_384);
  const len = layout(name).encode(value, body);
  return Buffer.concat([Buffer.from(coder.accountDiscriminator(name)), body.subarray(0, len)]);
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
const zeros = (n: number) => new Array(n).fill(0);
const key = () => Keypair.generate().publicKey;
const spec = (name: string) => (idl as unknown as { instructions: { name: string; accounts: { name: string }[] }[] }).instructions.find((i) => i.name === name)!;
const named = (ix: { keys: { pubkey: PublicKey }[] }, name: string) => Object.fromEntries(spec(name).accounts.map((a, i) => [a.name, ix.keys[i].pubkey]));

describe("a Table reads as the program writes it", () => {
  it("the worked example after Impact: who Jumped when, the places last off first, Ana's refund", () => {
    const players = Array.from({ length: 5 }, key);
    const car = key();
    const match = key();
    // Ana Jumped first at 25 s, then Cy, Ben, Dee; Eve aboard. Places: Dee (seat 3), Ben (1), Cy (2).
    const jumps = [
      [1, 25_000, 350],
      [3, 96_000, 0],
      [2, 95_000, 0],
      [4, 98_000, 0],
      [0, 0, 0],
    ];
    const seat = (i: number) =>
      i < 5
        ? { seat: i, order: jumps[i][0], flags: 0, reserved0: 0, jump_ms: le(jumps[i][1], 4), refund: le(jumps[i][2], 8), account: Array.from(players[i].toBytes()), reserved: zeros(24) }
        : { seat: 0, order: 0, flags: 0, reserved0: 0, jump_ms: zeros(4), refund: zeros(8), account: zeros(32), reserved: zeros(24) };
    const data = encode("Table", {
      version: 1,
      bump: 255,
      index: le(1, 2),
      phase: 3,
      outcome: 1,
      reason: 1,
      tell: 3,
      false_screws: 2,
      seated: 5,
      aboard: 1,
      jumps: 4,
      places: [3, 1, 2],
      vault_ready: 1,
      dirty: 0,
      req_pending: 0,
      req_count: 1,
      commit_tries: 0,
      reserved0: zeros(4),
      car_no: le(9, 8),
      next_car: le(11, 8),
      car: Array.from(car.toBytes()),
      tesoro_match: Array.from(match.toBytes()),
      entry: le(500, 8),
      vrf_nonce: le(4, 8),
      req_nonce: le(4, 8),
      req_slot: le(1_000, 8),
      started_slot: le(1_000, 8),
      ride_slot: le(1_300, 8),
      ride_ts: le(1_762_300_000, 8),
      over_ms: le(104_000, 4),
      over_at: le(1_762_300_104, 8),
      commit_at: zeros(8),
      reserved: zeros(128),
      seats: Array.from({ length: 100 }, (_, i) => seat(i)),
    });
    const t = decodeTable(data);
    expect([t.index, t.phase, t.outcome, t.reason, t.tell, t.falseScrews]).toEqual([1, "over", "placed", "played", 3, 2]);
    expect([t.seated, t.aboard, t.jumps]).toEqual([5, 1, 4]);
    expect(t.places).toEqual([3, 1, 2]);
    expect([t.carNo, t.nextCar, t.entry, t.rideSlot]).toEqual([9n, 11n, 500n, 1_300n]);
    expect([t.rideTs, t.overMs, t.overAt]).toEqual([1_762_300_000, 104_000, 1_762_300_104]);
    expect(t.car.equals(car)).toBe(true);
    expect(t.tesoroMatch.equals(match)).toBe(true);
    expect(t.seats).toHaveLength(5);
    expect(t.seats[0]).toMatchObject({ tableSeat: 0, seat: 0, order: 1, jumpMs: 25_000, refund: 350n });
    expect(t.seats[4].order).toBe(0);
    expect(t.seats[2].account.equals(players[2])).toBe(true);
    expect(NO_SEAT).toBe(255);
  });
});

describe("Railcar instructions name the accounts the program checks", () => {
  it("the opener's open_car names the next car and the core Match the opener's counter gives", () => {
    const wallet = key();
    const boarding = key();
    const a = named(openCarIx({ payer: wallet, opener: wallet, config: { operator: key(), tables: 2, nextCar: 7n, boardingMatch: boarding }, n: 3n }), "open_car");
    expect(a.car.equals(carPda(7n))).toBe(true);
    expect(a.boarding_match.equals(boarding)).toBe(true);
  });

  it("check_departure names the car by its number and the core Match it boards", () => {
    const match = key();
    const a = named(checkDepartureIx(4n, match), "check_departure");
    expect(a.car.equals(carPda(4n))).toBe(true);
    expect(a.match_state.equals(match)).toBe(true);
  });

  it("finalize passes every seat page of the car after its named accounts", () => {
    const match = key();
    const ix = finalizeIx(key(), { carNo: 2n, table: 0, tesoroMatch: match, payer: key() }, 3);
    expect(named(ix, "finalize").table.equals(tablePda(0))).toBe(true);
    const rest = ix.keys.slice(spec("finalize").accounts.length).map((k) => k.pubkey.toBase58());
    expect(rest).toEqual([0, 1, 2].map((p) => seatPagePda(match, p).toBase58()));
  });

  it("jump names the Table seat and the car, signed by the Player", () => {
    const wallet = key();
    const ix = jumpIx(wallet, 1, 9n, 4);
    expect(named(ix, "jump").table.equals(tablePda(1))).toBe(true);
    expect(ix.keys[0].isSigner).toBe(true);
    // car_no (u64 LE) then seat (u8) after the 8-byte discriminator.
    expect(Array.from(ix.data.subarray(8))).toEqual([9, 0, 0, 0, 0, 0, 0, 0, 4]);
  });
});
