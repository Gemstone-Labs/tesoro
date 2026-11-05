import "./polyfill";
import { PublicKey, SystemProgram, type AccountMeta, type TransactionInstruction } from "@solana/web3.js";
import { TESORO_CORE } from "./basket";
import { coreIx, metaOf } from "./core-ix";
import coreIdlJson from "./idl/tesoro_core.json";
import { matchOverflowPda } from "./overflow";

/**
 * Many-seat Matches (tesoro_core `ledger/many_seat`, ADR 0015): the car record, its seat pages and seat marks, read in
 * place. Every field is a byte array on chain (alignment 1, no padding), so these decoders read offsets; a test holds
 * them to the IDL's layout. Pure: no network calls.
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

const INNER = 8 + 1 + 4 + 32;
const RUN = INNER + 220;
const PLACE_LEN = 77;
const PLACES_AT = 92;
const MAX_PLACES = 10;

function decodeRun(d: Uint8Array, at: number): SeatRunView {
  const phase = d[at + 1];
  const nPlaces = Math.min(d[at + 2], MAX_PLACES);
  const places: PlaceView[] = [];
  for (let i = 0; i < nPlaces; i++) {
    const p = at + PLACES_AT + i * PLACE_LEN;
    places.push({ seat: d[p], shareBps: u16(d, p + 1), playerShareBps: u16(d, p + 3), won: u64(d, p + 5), player: key(d, p + 13), funder: key(d, p + 45) });
  }
  return {
    kind: d[at],
    phase: phase === 0 ? "home" : phase === 1 ? "forfeits" : "done",
    nPlaces,
    placeI: d[at + 3],
    seatI: d[at + 4],
    inSeat: d[at + 5] !== 0,
    visited: d[at + 6],
    feesCapped: d[at + 7] !== 0,
    lineI: u32(d, at + 8),
    seatLeft: u64(d, at + 12),
    wonLeft: u64(d, at + 20),
    playerLeft: u64(d, at + 28),
    fees: [0, 1, 2].map((c) => u64(d, at + 36 + 8 * c)),
    cutLeft: [0, 1, 2].map((c) => u64(d, at + 60 + 8 * c)),
    chunks: u32(d, at + 84),
    steps: u32(d, at + 88),
    places,
  };
}

export function decodeCar(address: PublicKey, data: Uint8Array): CarView {
  const i = INNER;
  return {
    address,
    payer: key(data, 13),
    opener: key(data, i),
    n: u64(data, i + 32),
    game: key(data, i + 40),
    settleAuthority: key(data, i + 72),
    studioOwner: data[i + 196] ? key(data, i + 104) : null,
    entry: u64(data, i + 144),
    openedAt: i64(data, i + 152),
    deadlineAbs: i64(data, i + 160),
    minSince: i64(data, i + 168),
    firstMinAt: i64(data, i + 176),
    departedAt: i64(data, i + 184),
    platformBps: u16(data, i + 192),
    studioBps: u16(data, i + 194),
    listed: data[i + 200] !== 0,
    minSeats: data[i + 201],
    maxSeats: data[i + 202],
    seated: data[i + 203],
    pages: data[i + 204],
    stage: STAGES[data[i + 205]] ?? "closed",
    refundAfter: i64(data, i + 212),
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
  /** The seat key that plays this seat (seat-key layout, 192-byte seats); null in the first layout. */
  signer: PublicKey | null;
}

export interface SeatPageView {
  matchKey: PublicKey;
  payer: PublicKey;
  index: number;
  seats: SeatView[];
}

const PAGE_HEAD = 8 + 72;
/** Where the seat-key layout keeps a seat's key: after the 160 bytes of the first layout. */
const SEAT_SIGNER_AT = 160;

/** A seat page. The seat size is read from the account's length, so the seat-key layout (a signer added at the end) reads too. */
export function decodeSeatPage(data: Uint8Array): SeatPageView {
  const seatLen = Math.floor((data.length - PAGE_HEAD) / SEATS_PER_PAGE);
  const index = data[73];
  const seats: SeatView[] = [];
  for (let s = 0; s < SEATS_PER_PAGE; s++) {
    const at = PAGE_HEAD + s * seatLen;
    seats.push({
      index: index * SEATS_PER_PAGE + s,
      seated: data[at] === 1,
      shareBps: u16(data, at + 2),
      placeBps: u16(data, at + 4),
      place: data[at + 6],
      potLines: u32(data, at + 8),
      hold: u32(data, at + 12),
      refund: u64(data, at + 32),
      player: key(data, at + 40),
      funder: key(data, at + 72),
      pot: key(data, at + 104),
      signer: seatLen >= SEAT_SIGNER_AT + 32 ? key(data, at + SEAT_SIGNER_AT) : null,
    });
  }
  return { matchKey: key(data, 8), payer: key(data, 40), index, seats };
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

export function decodeSeatMark(data: Uint8Array): SeatMarkView {
  return {
    seat: data[9],
    returning: data[10] !== 0,
    hold: u32(data, 12),
    matchKey: key(data, 16),
    account: key(data, 48),
    payer: key(data, 80),
    funder: key(data, 152),
    pot: key(data, 184),
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
            backer_account: b.backerAccount,
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

/** `close_many_seat_match`: a car with no seat left; remaining = every page in order, each followed by who paid it. */
export const closeCarIx = (caller: PublicKey, car: Pick<CarView, "address" | "payer">, pages: SeatPageView[]): TransactionInstruction =>
  coreIx(
    "close_many_seat_match",
    { caller, match_state: car.address, match_payer: car.payer },
    {},
    [...pages].sort((a, b) => a.index - b.index).flatMap((p) => [metaOf(seatPagePda(car.address, p.index), true), metaOf(p.payer, true)]),
  );
