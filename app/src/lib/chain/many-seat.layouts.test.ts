// Many-seat accounts as tesoro_core's own Rust code writes them (`keeper_fixtures` in programs/tesoro_core writes
// keeper/fixtures/core-layouts.json), read by the app's decoders and the sponsor's seat-key check. A layout change in core
// fails the Rust test until the file is regenerated, and then fails here if the decoders were not updated.
import { PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { carNamesSeatKey } from "../../server/seat-keys";
import { TESORO_CORE } from "./basket";
import { decodeCar, decodeSeatMark, decodeSeatPage, seatMarkPda, seatPagePda } from "./many-seat";

const fx = Object.fromEntries(
  Object.entries(JSON.parse(readFileSync(new URL("../../../../keeper/fixtures/core-layouts.json", import.meta.url), "utf8")) as Record<string, string>).map(([k, v]) => [k, Buffer.from(v, "hex")]),
);
/** The Rust fixtures' `key(n)`. */
const keyOf = (n: number) => {
  const b = Buffer.alloc(32, n);
  b[0] = (n * 3 + 1) & 0xff;
  return new PublicKey(b);
};

describe("many-seat accounts written by tesoro_core", () => {
  it("a seat page: the funded seat's Player, Backer, Pot, share and seat key", () => {
    const page = decodeSeatPage(fx.seatPage);
    expect([page.matchKey, page.payer, page.index]).toEqual([keyOf(54), keyOf(55), 1]);
    expect(page.seats.map((s) => s.seated)).toEqual([false, false, true, false, false, false, false, false, false, false]);
    const s = page.seats[2];
    expect([s.index, s.shareBps, s.potLines, s.hold, s.place, s.refund]).toEqual([12, 4_000, 3, 2, 0, 0n]);
    expect([s.player, s.funder, s.pot, s.signer]).toEqual([keyOf(56), keyOf(57), keyOf(59), keyOf(58)]);
  });

  it("the sponsor finds the seat key in that page through the Player's mark, and no other key", async () => {
    const car = keyOf(54);
    const at = new Map([
      [seatMarkPda(car, keyOf(56)).toBase58(), fx.seatMark],
      [seatPagePda(car, 1).toBase58(), fx.seatPage],
    ]);
    const read = async (k: PublicKey) => {
      const data = at.get(k.toBase58());
      return data ? { owner: TESORO_CORE, data } : null;
    };
    expect(await carNamesSeatKey(read, car, keyOf(56), keyOf(58))).toBe(true);
    expect(await carNamesSeatKey(read, car, keyOf(56), keyOf(57))).toBe(false);
    expect(await carNamesSeatKey(read, car, keyOf(57), keyOf(58))).toBe(false);
  });

  it("a seat mark: the seat, the lines on their way home, the funder and the Pot", () => {
    const m = decodeSeatMark(fx.seatMark);
    expect([m.seat, m.returning, m.hold]).toEqual([12, true, 2]);
    expect([m.matchKey, m.account, m.payer, m.funder, m.pot]).toEqual([keyOf(54), keyOf(56), keyOf(60), keyOf(57), keyOf(59)]);
  });

  it("a departed car: its id, Game, fees, seat bounds and times", () => {
    const c = decodeCar(keyOf(1), fx.manySeatMatch);
    expect([c.payer, c.opener, c.n, c.game, c.settleAuthority, c.studioOwner]).toEqual([keyOf(53), keyOf(50), 7n, keyOf(51), keyOf(52), null]);
    expect([c.entry, c.platformBps, c.studioBps, c.listed, c.minSeats, c.maxSeats, c.seated, c.pages, c.stage]).toEqual([500n, 200, 300, true, 5, 100, 5, 1, "departed"]);
    expect([c.openedAt, c.deadlineAbs, c.firstMinAt, c.minSince, c.departedAt, c.refundAfter]).toEqual([1_790_000_000, 1_790_000_000 + 7 * 86_400, 1_790_000_040, 1_790_000_040, 1_790_000_100, 1_790_000_100 + 86_400]);
  });
});
