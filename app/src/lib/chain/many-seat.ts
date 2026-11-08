import "./polyfill";
import { PublicKey, SystemProgram, type AccountMeta, type TransactionInstruction } from "@solana/web3.js";
import { TESORO_CORE } from "./basket";
import { coreIx, metaOf } from "./core-ix";
import coreIdlJson from "./idl/tesoro_core.json";
import { layoutOf, type IdlWithTypes } from "./idl-layout";
import { matchOverflowPda } from "./overflow";

const coreIdl = coreIdlJson as unknown as IdlWithTypes;

/**
 * Many-seat Matches (tesoro_core `ledger/many_seat`, ADR 0015): the car record, its seat pages and seat marks, read in
 * place. Every field is a byte array on chain (alignment 1, no padding); the offsets come from the IDL's type layout
 * (`idl-layout`), and many-seat.layouts.test.ts holds the decoders to bytes core's own Rust wrote. Pure: no network calls.
 */

export const SEATS_PER_PAGE = 10;
/** Steps one `many_seat_chunk` takes at most (`MAX_SEAT_CHUNK_STEPS`). */
export const MAX_SEAT_CHUNK_STEPS = 7;
/** Lines one step-off returns at most (`MAX_RETURN_LINES`). */
export const MAX_RETURN_LINES = 8;

export const seatPagePda = (match: PublicKey, page: number) => PublicKey.findProgramAddressSync([Buffer.from("seat_page"), match.toBuffer(), Buffer.from([page])], TESORO_CORE)[0];
export const seatMarkPda = (match: PublicKey, account: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("seat"), match.toBuffer(), account.toBuffer()], TESORO_CORE)[0];

const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const u16 = (d: Uint8Array, at: number) => dv(d).getUint16(at, true);
const u32 = (d: Uint8Array, at: number) => dv(d).getUint32(at, true);
const u64 = (d: Uint8Array, at: number) => dv(d).getBigUint64(at, true);
const i64 = (d: Uint8Array, at: number) => Number(dv(d).getBigInt64(at, true));
const key = (d: Uint8Array, at: number) => new PublicKey(d.subarray(at, at + 32));

export type CarStage = "boarding" | "departed" | "settling" | "refunding" | "paid" | "closed";
const STAGES: Record<number, CarStage> = { 0: "boarding", 1: "departed", 2: "closed", 3: "settling", 4: "refunding", 5: "paid" };

export interface PlaceView {
  seat: number;
  shareBps: number;
  /** The Player's Offer share of a Backed seat's winnings (0 unbacked). */
  playerShareBps: number;
  /** Forfeited Gemas this place gets on top of its entry. */
  won: bigint;
  player: PublicKey;
  funder: PublicKey;
}

/** The frozen run of a Settling or Refunding car and its cursor (`SeatRun`). */
export interface SeatRunView {
  /** 0 a win; 4, 5, 6 refund runs. */
  kind: number;
  phase: "home" | "forfeits" | "done";
  nPlaces: number;
  placeI: number;
  seatI: number;
  inSeat: boolean;
  visited: number;
  feesCapped: boolean;
  lineI: number;
  seatLeft: bigint;
  wonLeft: bigint;
  playerLeft: bigint;
  fees: bigint[];
  cutLeft: bigint[];
  chunks: number;
  steps: number;
  places: PlaceView[];
}

/** A many-seat Match (`ManySeatMatch`). */
export interface CarView {
  address: PublicKey;
  payer: PublicKey;
  opener: PublicKey;
  n: bigint;
  game: PublicKey;
  settleAuthority: PublicKey;
  studioOwner: PublicKey | null;
  entry: bigint;
  openedAt: number;
  deadlineAbs: number;
  /** When the seat count last reached `minSeats` (0 below it). */
  minSince: number;
  /** When it first did; a step-off never clears it (Railcar's departure is 30 s after it). */
  firstMinAt: number;
  departedAt: number;
  platformBps: number;
  studioBps: number;
  listed: boolean;
  minSeats: number;
  maxSeats: number;
  seated: number;
  pages: number;
  stage: CarStage;
  refundAfter: number;
  run: SeatRunView;
}

/** Seats and departure stop this long before the absolute deadline (`BOARDING_MARGIN_SECS`). */
export const BOARDING_MARGIN_SECS = 60 * 60;
export const boardingEnds = (car: Pick<CarView, "deadlineAbs">) => car.deadlineAbs - BOARDING_MARGIN_SECS;

const DISC = 8;
const MATCH = layoutOf(coreIdl, "ManySeatMatch");
const RECORD = layoutOf(coreIdl, "ManySeatRecord");
const RUN_L = layoutOf(coreIdl, "SeatRun");
const PLACE = layoutOf(coreIdl, "PlaceSlot");
/** Where a car's record starts in its account, and its run. */
const INNER = DISC + MATCH.at.inner;
const RUN = INNER + RECORD.at.run;
const MAX_PLACES = 10;
/** Absolute offset of a `ManySeatRecord` field in a car's account (the keeper's sliced scan reads these). */
export const carFieldAt = (field: string): number => {
  if (!(field in RECORD.at)) throw new Error(`No ManySeatRecord field ${field}`);
  return INNER + RECORD.at[field];
};

function decodeRun(d: Uint8Array, at: number): SeatRunView {
  const r = RUN_L.at;
  const phase = d[at + r.phase];
  const nPlaces = Math.min(d[at + r.n_places], MAX_PLACES);
  const places: PlaceView[] = [];
  for (let i = 0; i < nPlaces; i++) {
    const p = at + r.places + i * PLACE.size;
    places.push({ seat: d[p + PLACE.at.seat], shareBps: u16(d, p + PLACE.at.share_bps), playerShareBps: u16(d, p + PLACE.at.player_share_bps), won: u64(d, p + PLACE.at.won), player: key(d, p + PLACE.at.player), funder: key(d, p + PLACE.at.funder) });
  }
  return {
    kind: d[at + r.kind],
    phase: phase === 0 ? "home" : phase === 1 ? "forfeits" : "done",
    nPlaces,
    placeI: d[at + r.place_i],
    seatI: d[at + r.seat_i],
    inSeat: d[at + r.in_seat] !== 0,
    visited: d[at + r.visited],
    feesCapped: d[at + r.fees_capped] !== 0,
    lineI: u32(d, at + r.line_i),
    seatLeft: u64(d, at + r.seat_left),
    wonLeft: u64(d, at + r.won_left),
    playerLeft: u64(d, at + r.player_left),
    fees: [0, 1, 2].map((c) => u64(d, at + r.fees + 8 * c)),
    cutLeft: [0, 1, 2].map((c) => u64(d, at + r.cut_left + 8 * c)),
    chunks: u32(d, at + r.chunks),
    steps: u32(d, at + r.steps),
    places,
  };
}

export function decodeCar(address: PublicKey, data: Uint8Array): CarView {
  if (data.length !== DISC + MATCH.size) throw new Error(`A car is ${DISC + MATCH.size} bytes, not ${data.length}`);
  const f = (name: string) => carFieldAt(name);
  return {
    address,
    payer: key(data, DISC + MATCH.at.payer),
    opener: key(data, f("opener")),
    n: u64(data, f("n")),
    game: key(data, f("game")),
    settleAuthority: key(data, f("settle_authority")),
    studioOwner: data[f("has_studio_owner")] ? key(data, f("studio_owner")) : null,
    entry: u64(data, f("entry")),
    openedAt: i64(data, f("opened_at")),
    deadlineAbs: i64(data, f("deadline_abs")),
    minSince: i64(data, f("min_since")),
    firstMinAt: i64(data, f("first_min_at")),
    departedAt: i64(data, f("departed_at")),
    platformBps: u16(data, f("platform_bps")),
    studioBps: u16(data, f("studio_bps")),
    listed: data[f("listed")] !== 0,
    minSeats: data[f("min_seats")],
    maxSeats: data[f("max_seats")],
    seated: data[f("seated")],
    pages: data[f("pages")],
    stage: STAGES[data[f("stage")]] ?? "closed",
    refundAfter: i64(data, f("refund_after")),
    run: decodeRun(data, RUN),
  };
}

/** One seat of a page (`ledger::many_seat::Seat`). */
export interface SeatView {
  /** page * 10 + slot. */
  index: number;
  seated: boolean;
  shareBps: number;
  placeBps: number;
  /** 0 unplaced, else the place (1 first). */
  place: number;
  potLines: number;
  hold: number;
  refund: bigint;
  player: PublicKey;
  funder: PublicKey;
  pot: PublicKey;
  /** The seat key that plays this seat (the Player's wallet when the join named none). */
  signer: PublicKey;
}

export interface SeatPageView {
  matchKey: PublicKey;
  payer: PublicKey;
  index: number;
  seats: SeatView[];
}

const PAGE = layoutOf(coreIdl, "SeatPage");
const SEAT = layoutOf(coreIdl, "Seat");
/** Bytes of a seat page account. */
export const SEAT_PAGE_LEN = DISC + PAGE.size;

/** A seat page. */
export function decodeSeatPage(data: Uint8Array): SeatPageView {
  if (data.length !== SEAT_PAGE_LEN) throw new Error(`A seat page is ${SEAT_PAGE_LEN} bytes, not ${data.length}`);
  const index = data[DISC + PAGE.at.index];
  const s = SEAT.at;
  const seats: SeatView[] = [];
  for (let i = 0; i < SEATS_PER_PAGE; i++) {
    const at = DISC + PAGE.at.seats + i * SEAT.size;
    seats.push({
      index: index * SEATS_PER_PAGE + i,
      seated: data[at + s.state] === 1,
      shareBps: u16(data, at + s.share_bps),
      placeBps: u16(data, at + s.place_bps),
      place: data[at + s.place],
      potLines: u32(data, at + s.pot_lines),
      hold: u32(data, at + s.hold),
      refund: u64(data, at + s.refund),
      player: key(data, at + s.player),
      funder: key(data, at + s.funder),
      pot: key(data, at + s.pot),
      signer: key(data, at + s.signer),
    });
  }
  return { matchKey: key(data, DISC + PAGE.at.match_key), payer: key(data, DISC + PAGE.at.payer), index, seats };
}

export interface SeatMarkView {
  seat: number;
  /** The seat stepped off and its lines are on the way back. */
  returning: boolean;
  hold: number;
  matchKey: PublicKey;
  account: PublicKey;
  payer: PublicKey;
  funder: PublicKey;
  pot: PublicKey;
}

const MARK = layoutOf(coreIdl, "SeatMark");

export function decodeSeatMark(data: Uint8Array): SeatMarkView {
  if (data.length !== DISC + MARK.size) throw new Error(`A seat mark is ${DISC + MARK.size} bytes, not ${data.length}`);
  const m = (field: string) => DISC + MARK.at[field];
  return {
    seat: data[m("seat")],
    returning: data[m("returning")] !== 0,
    hold: u32(data, m("hold")),
    matchKey: key(data, m("match_key")),
    account: key(data, m("account")),
    payer: key(data, m("payer")),
    funder: key(data, m("funder")),
    pot: key(data, m("pot")),
  };
}

// ---- Instructions ---------------------------------------------------------------------------------------------------

const coreKey = (seeds: (string | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s)), TESORO_CORE)[0];
const coreAccountOf = (authority: PublicKey) => coreKey(["account", authority.toBuffer()]);
const countersOf = (account: PublicKey) => coreKey(["counters", account.toBuffer()]);
const protectionsOf = (account: PublicKey) => coreKey(["protections", account.toBuffer()]);
const basketOf = (account: PublicKey) => coreKey(["basket", account.toBuffer()]);
const spillOf = (account: PublicKey) => coreKey(["spill", account.toBuffer()]);
export const coreEventAuthority = coreKey(["__event_authority"]);
const sponsorKey = coreKey(["sponsor"]);
const programDataOf = (program: PublicKey) => PublicKey.findProgramAddressSync([program.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0];

/**
 * Whether the deployed core takes a seat key on many-seat seats (seat keys ticket 08: `seat_signer` on the join).
 * Read from the IDL, so the builders follow the program the app was built
 * against: when ticket 08's IDL lands, joins name the seat key and closes pass its mark with no other change.
 */
const coreIxAccounts = (name: string): string[] => ((coreIdlJson as { instructions: { name: string; accounts: { name: string }[] }[] }).instructions.find((i) => i.name === name)?.accounts ?? []).map((a) => a.name);
export const SEATS_TAKE_SEAT_KEYS = coreIxAccounts("join_many_seat_match").includes("seat_signer");

/** A Backer's Offer an entry boards with (`join_many_seat_match`'s optional accounts). */
export interface SeatBacking {
  offer: PublicKey;
  backerAccount: PublicKey;
}

export interface JoinSeatArgs {
  payer: PublicKey;
  /** The Player's wallet (it signs the entry). */
  player: PublicKey;
  car: PublicKey;
  game: PublicKey;
  page: number;
  pot: { address: PublicKey; nonce: bigint; lines: number };
  backing?: SeatBacking;
  /** The seat key that will play the seat (it co-signs the join); the wallet when absent. Used once the core takes seat keys. */
  seatSigner?: PublicKey;
  /** Books of the Sources the entry draws (and the funder's overflow record). */
  remaining?: AccountMeta[];
}

/** `join_many_seat_match`: takes the lowest empty seat of `page` with the Player's (or the Backer's) entry. */
export function joinSeatIx(a: JoinSeatArgs): TransactionInstruction {
  const account = coreAccountOf(a.player);
  const b = a.backing;
  return coreIx(
    "join_many_seat_match",
    {
      payer: a.payer,
      player_authority: a.player,
      player_account: account,
      counters: countersOf(account),
      protections: protectionsOf(account),
      basket: basketOf(account),
      spill: spillOf(account),
      pot: a.pot.address,
      match_state: a.car,
      game_record: coreKey(["game", a.game.toBuffer()]),
      game_program: a.game,
      program_data: programDataOf(a.game),
      seat_page: seatPagePda(a.car, a.page),
      seat_mark: seatMarkPda(a.car, account),
      ...(b
        ? {
            offer: b.offer,
            backer_counters: countersOf(b.backerAccount),
            backer_protections: protectionsOf(b.backerAccount),
            backer_basket: basketOf(b.backerAccount),
            backer_spill: spillOf(b.backerAccount),
            funder_mark: seatMarkPda(a.car, b.backerAccount),
          }
        : {}),
      ...(SEATS_TAKE_SEAT_KEYS ? { seat_signer: a.seatSigner ?? a.player } : {}),
    },
    { pot_nonce: a.pot.nonce, pot_lines: a.pot.lines, page: a.page },
    a.remaining ?? [],
  );
}

/** The page a join should name: the first page with an empty seat, or the next page to create. */
export function joinPage(car: Pick<CarView, "pages" | "maxSeats">, pages: SeatPageView[]): number {
  for (const p of pages) if (p.seats.some((s, i) => p.index * SEATS_PER_PAGE + i < car.maxSeats && !s.seated)) return p.index;
  return car.pages;
}

export interface StepOffArgs {
  caller: PublicKey;
  car: PublicKey;
  seat: SeatView;
  /** The Player's mark and whoever paid it. */
  markPayer: PublicKey;
  potPayer: PublicKey;
  sponsor: boolean;
  /** Books of the lines' Sources, the funder's basket and spill (`return_stepped_off`'s accounts). */
  remaining?: AccountMeta[];
}

/** `step_off_many_seat_match`: the seat empties now; up to 8 of its lines go home in the same call. */
export function stepOffIx(a: StepOffArgs): TransactionInstruction {
  const backed = !a.seat.player.equals(a.seat.funder);
  const mark = seatMarkPda(a.car, a.seat.player);
  return coreIx(
    "step_off_many_seat_match",
    {
      caller: a.caller,
      match_state: a.car,
      seat_page: seatPagePda(a.car, Math.floor(a.seat.index / SEATS_PER_PAGE)),
      seat_mark: mark,
      mark_payer: a.markPayer,
      player_counters: countersOf(a.seat.player),
      player_protections: protectionsOf(a.seat.player),
      pot: a.seat.pot,
      pot_payer: a.potPayer,
      sponsor: a.sponsor ? sponsorKey : null,
      // The Backer's mark carries a backed seat's lines home (ticket 04).
      funder_mark: backed ? seatMarkPda(a.car, a.seat.funder) : null,
      // The Backer's Entry Limit count of a backed seat comes back with the step-off (ticket 17).
      funder_protections: backed ? protectionsOf(a.seat.funder) : null,
    },
    { seat: a.seat.index, max_lines: MAX_RETURN_LINES },
    a.remaining ?? [],
  );
}

/** `return_stepped_off`: anyone; up to 8 more lines of a stepped-off seat go home (`mark` is the funder's, which carries them). */
export const returnSteppedOffIx = (a: { caller: PublicKey; mark: PublicKey; markPayer: PublicKey; pot: PublicKey; potPayer: PublicKey; sponsor: boolean; remaining?: AccountMeta[] }): TransactionInstruction =>
  coreIx("return_stepped_off", { caller: a.caller, seat_mark: a.mark, mark_payer: a.markPayer, pot: a.pot, pot_payer: a.potPayer, sponsor: a.sponsor ? sponsorKey : null }, { max_lines: MAX_RETURN_LINES }, a.remaining ?? []);

/** `many_seat_chunk`: anyone; the remaining accounts are what `aheadOf` lists for the steps. */
export const seatChunkIx = (caller: PublicKey, car: PublicKey, steps: number, remaining: AccountMeta[]): TransactionInstruction =>
  coreIx("many_seat_chunk", { caller, match_state: car, event_authority: coreEventAuthority, program: TESORO_CORE }, { max_steps: steps }, remaining);

/** `reserve_many_seat_room`: anyone pays `account`'s overflow record for this car, so a credit that finds its stores full lands there. */
export const reserveRoomIx = (payer: PublicKey, car: Pick<CarView, "address" | "opener" | "n">, account: PublicKey, lines: number): TransactionInstruction =>
  coreIx("reserve_many_seat_room", { payer, match_state: car.address, record: matchOverflowPda(account, { opener: car.opener, n: car.n }), system_program: SystemProgram.programId }, { account, lines });

export interface CloseSeatArgs {
  caller: PublicKey;
  car: PublicKey;
  seat: SeatView;
  markPayer: PublicKey;
  potPayer: PublicKey;
  sponsor: boolean;
}

/** `close_many_seat`: one paid seat (Pot, the hold left in the funder's spill, both marks of a backed seat, the funder's Entry Limit count after a refund run). */
export function closeSeatIx(a: CloseSeatArgs): TransactionInstruction {
  const backed = !a.seat.player.equals(a.seat.funder);
  return coreIx(
    "close_many_seat",
    {
      caller: a.caller,
      match_state: a.car,
      seat_page: seatPagePda(a.car, Math.floor(a.seat.index / SEATS_PER_PAGE)),
      seat_mark: seatMarkPda(a.car, a.seat.player),
      mark_payer: a.markPayer,
      player_counters: countersOf(a.seat.player),
      pot: a.seat.pot,
      pot_payer: a.potPayer,
      sponsor: a.sponsor ? sponsorKey : null,
      funder_spill: a.seat.hold > 0 ? spillOf(a.seat.funder) : null,
      funder_mark: backed ? seatMarkPda(a.car, a.seat.funder) : null,
      // After a refund run the seat's Entry Limit count goes back to its funder (ticket 17).
      funder_protections: protectionsOf(a.seat.funder),
    },
    { seat: a.seat.index },
  );
}

/**
 * `refund_many_seat_match`: anyone, once a Departed car's refund time has passed with no result; `caller` pays the receipt
 * (returned when the receipt closes).
 */
export const refundCarIx = (caller: PublicKey, car: Pick<CarView, "address" | "game">): TransactionInstruction =>
  coreIx("refund_many_seat_match", {
    caller,
    payer: caller,
    game_record: coreKey(["game", car.game.toBuffer()]),
    game_program: car.game,
    program_data: programDataOf(car.game),
    match_state: car.address,
    receipt: coreKey(["settled", car.address.toBuffer()]),
    system_program: SystemProgram.programId,
    event_authority: coreEventAuthority,
    program: TESORO_CORE,
  });

/** `close_many_seat_match`: a car with no seat left; remaining = every page in order, each followed by who paid it. */
export const closeCarIx = (caller: PublicKey, car: Pick<CarView, "address" | "payer">, pages: SeatPageView[]): TransactionInstruction =>
  coreIx(
    "close_many_seat_match",
    { caller, match_state: car.address, match_payer: car.payer },
    {},
    [...pages].sort((a, b) => a.index - b.index).flatMap((p) => [metaOf(seatPagePda(car.address, p.index), true), metaOf(p.payer, true)]),
  );
