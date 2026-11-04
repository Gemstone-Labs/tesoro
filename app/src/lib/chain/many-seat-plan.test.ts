import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { basketPda, spillPda } from "./basket";
import { seatPagePda, type CarView, type PlaceView, type SeatRunView, type SeatView } from "./many-seat";
import { aheadOf, chunkRemaining, creditsOf, roomNeeds, type SeatLines } from "./many-seat-plan";
import { matchOverflowPda } from "./overflow";

/**
 * The spec's worked example (spec.md): Ana, Ben, Cy, Dee and Eve each enter 500. Ana Jumps early (350 back); Dee, Ben and
 * Cy are placed 60/25/15; Eve is aboard at Impact. Fees 129 (Platform 44, Studio 64, Leaderboard 21); winnings 313 / 130 / 78.
 * The run walks own Gemas home first (Ana's refund, the placed seats' entries), then the forfeits (Ana's 150, Eve's 500),
 * each from its last line backward: fees first, then first place, then second, then third.
 */
const k = () => Keypair.generate().publicKey;
const [ana, ben, cy, dee, eve, studio] = [k(), k(), k(), k(), k(), k()];
const players = [ana, ben, cy, dee, eve];
const sources = players.map(() => k());

const seat = (i: number, o: Partial<SeatView> = {}): SeatView => ({
  index: i,
  seated: true,
  shareBps: 0,
  placeBps: 0,
  place: 0,
  potLines: 1,
  hold: 2,
  refund: 0n,
  player: players[i],
  funder: players[i],
  pot: k(),
  ...o,
});
const seats = [seat(0, { refund: 350n }), seat(1, { place: 2, placeBps: 2500 }), seat(2, { place: 3, placeBps: 1500 }), seat(3, { place: 1, placeBps: 6000 }), seat(4)];
const oneLine = (i: number): SeatLines => [{ source: sources[i], amount: 500n }];

const place = (s: number, shareBps: number, won: bigint, o: Partial<PlaceView> = {}): PlaceView => ({ seat: s, shareBps, playerShareBps: 0, won, player: players[s], funder: players[s], ...o });
const places = [place(3, 6000, 313n), place(1, 2500, 130n), place(2, 1500, 78n)];

const run = (o: Partial<SeatRunView> = {}): SeatRunView => ({
  kind: 0,
  phase: "home",
  nPlaces: 3,
  placeI: 0,
  seatI: 0,
  inSeat: false,
  visited: 0,
  feesCapped: false,
  lineI: 0,
  seatLeft: 0n,
  wonLeft: 313n,
  playerLeft: 0n,
  fees: [44n, 64n, 21n],
  cutLeft: [44n, 64n, 21n],
  chunks: 0,
  steps: 0,
  places,
  ...o,
});

const car = (r: SeatRunView, o: Partial<CarView> = {}): CarView => ({
  address: k(),
  payer: k(),
  opener: ana,
  n: 0n,
  game: k(),
  settleAuthority: k(),
  studioOwner: studio,
  entry: 500n,
  openedAt: 0,
  deadlineAbs: 0,
  minSince: 0,
  firstMinAt: 0,
  departedAt: 0,
  platformBps: 200,
  studioBps: 300,
  listed: true,
  minSeats: 5,
  maxSeats: 100,
  seated: 5,
  pages: 1,
  stage: "settling",
  refundAfter: 0,
  run: r,
  ...o,
});

const names = (ks: PublicKey[]) => ks.map((x) => [...players, studio].findIndex((p) => p.equals(x)));

describe("the next chunk's accounts (a port of ManySeatRecord::ahead)", () => {
  it("the worked example's first seven steps: four entries home, then Ana's forfeit cut into the three fees", () => {
    const a = aheadOf(car(run()), seats, seats.map((_, i) => oneLine(i)), 7);
    expect(a.pages).toEqual([0]);
    // Eve gets nothing back, so her Pot is not touched at home; Ana's is touched twice (refund, then her fees).
    expect(a.seats).toEqual([0, 1, 2, 3]);
    // Ana, Ben, Cy, Dee credited at home; the Studio Fee goes to the outside Studio.
    expect(names(a.owners)).toEqual([0, 1, 2, 3, 5]);
    expect(a.sources.map((s) => sources.findIndex((x) => x.equals(s)))).toEqual([0, 1, 2, 3]);
    expect(a.cutSources.map((s) => sources.findIndex((x) => x.equals(s)))).toEqual([0]);
    expect(a.steps).toBe(7);
  });

  it("the rest of the run: Ana's last 21 to Dee, then Eve's 500 to Dee, Ben and Cy", () => {
    // After the seven steps above: Ana's line has 21 left, every fee is cut, first place still owed 313.
    const mid = run({ phase: "forfeits", seatI: 0, inSeat: true, seatLeft: 21n, lineI: 1, cutLeft: [0n, 0n, 0n] });
    const lines = seats.map((_, i) => oneLine(i));
    lines[0] = [{ source: sources[0], amount: 21n }];
    const a = aheadOf(car(mid), seats, lines, 7);
    expect(a.steps).toBe(4);
    expect(a.seats).toEqual([0, 4]);
    expect(names(a.owners)).toEqual([3, 1, 2]);
    expect(a.cutSources).toEqual([]);
  });

  it("a Backed first place: the Player's Offer share is paid first, then the Backer", () => {
    const backer = k();
    const backed = [place(3, 6000, 313n, { funder: backer, playerShareBps: 4000 }), places[1], places[2]];
    // Player share of 313 at 40% is 125: Eve's 500 pays Dee 125, Dee's Backer 188, then Ben 130, Cy 57 of Cy's 78.
    const mid = run({ phase: "forfeits", seatI: 4, places: backed, wonLeft: 313n, playerLeft: 125n, cutLeft: [0n, 0n, 0n] });
    const a = aheadOf(car(mid), seats, seats.map((_, i) => oneLine(i)), 7);
    expect(a.steps).toBe(4);
    expect(a.owners.map((o) => (o.equals(backer) ? "backer" : names([o])[0]))).toEqual([3, "backer", 1, 2]);
  });

  it("a refund run sends every seat's whole entry home and nothing else", () => {
    const r = run({ kind: 6, nPlaces: 0, places: [], wonLeft: 0n, fees: [0n, 0n, 0n], cutLeft: [0n, 0n, 0n] });
    const plain = seats.map((s) => ({ ...s, refund: 0n, place: 0, placeBps: 0 }));
    const a = aheadOf(car(r, { stage: "refunding" }), plain, plain.map((_, i) => oneLine(i)), 7);
    expect(a.steps).toBe(5);
    expect(a.seats).toEqual([0, 1, 2, 3, 4]);
    expect(names(a.owners)).toEqual([0, 1, 2, 3, 4]);
  });

  it("nothing ahead of a car that is not settling", () => {
    const a = aheadOf(car(run(), { stage: "paid" }), seats, seats.map((_, i) => oneLine(i)), 7);
    expect(a.steps).toBe(0);
    expect(a.pages).toEqual([]);
  });

  it("an entry of many lines: one step per line, and a refund splits one line at most", () => {
    const many: SeatLines = [100n, 100n, 100n, 100n, 100n].map((amount) => ({ source: sources[0], amount }));
    const lines = seats.map((_, i) => (i === 0 ? many : oneLine(i)));
    // Ana's 350 back: lines 0, 1, 2 whole and 50 of line 3.
    const a = aheadOf(car(run()), seats, lines, 4);
    expect(a.seats).toEqual([0]);
    expect(a.steps).toBe(4);
  });
});

describe("what a whole run credits (room each Account needs)", () => {
  it("the worked example: who gets lines, and how many", () => {
    const c = creditsOf(car(run()), seats, seats.map((_, i) => oneLine(i)));
    const by = new Map(c.map((x) => [names([x.account])[0], x.lines]));
    // Home: Ana 1 (refund), Ben, Cy, Dee 1 each. Forfeits: Dee 2 (21 from Ana, 292 from Eve), Ben 1, Cy 1; the Studio 1 cut.
    expect(Object.fromEntries(by)).toEqual({ 0: 1, 1: 2, 2: 2, 3: 3, 5: 1 });
  });
});

describe("before the forfeits move", () => {
  it("only winners and the Studio short of room get an overflow record, sized to the shortfall", () => {
    const credits = [
      { account: ana, lines: 1 },
      { account: dee, lines: 3 },
      { account: ben, lines: 2 },
      { account: studio, lines: 1 },
    ];
    const free = (a: PublicKey) => (a.equals(dee) ? 1 : a.equals(ben) ? 5 : a.equals(studio) ? 0 : 0);
    // Ana is not paid beyond her own seat's hold, so her credits never need room here.
    const needs = roomNeeds(credits, free, [dee, ben, studio]);
    expect(needs.map((n) => [names([n.account])[0], n.lines])).toEqual([
      [3, 2],
      [5, 1],
    ]);
  });

  it("a chunk passes each page, each moving seat's Pot, each credited Account's stores and only overflow records that exist", () => {
    const c = car(run());
    const a = aheadOf(c, seats, seats.map((_, i) => oneLine(i)), 7);
    const record = matchOverflowPda(dee, { opener: c.opener, n: c.n });
    const metas = chunkRemaining({ car: c, seats }, a, (r) => r.equals(record));
    const has = (x: PublicKey) => metas.some((m) => m.pubkey.equals(x) && m.isWritable);
    expect(has(seatPagePda(c.address, 0))).toBe(true);
    expect([0, 1, 2, 3].every((i) => has(seats[i].pot))).toBe(true);
    expect(has(seats[4].pot)).toBe(false);
    expect([ana, ben, cy, dee, studio].every((o) => has(basketPda(o)) && has(spillPda(o)))).toBe(true);
    expect(has(record)).toBe(true);
    expect(has(matchOverflowPda(ben, { opener: c.opener, n: c.n }))).toBe(false);
  });
});
