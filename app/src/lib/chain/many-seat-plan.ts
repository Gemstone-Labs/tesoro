import { PublicKey, type AccountMeta, type TransactionInstruction } from "@solana/web3.js";
import { TESORO_CORE } from "./basket";
import coreIdl from "./idl/tesoro_core.json";
import { matchOverflowPda } from "./overflow";
import { POT_AT, decodeStore, decodeTicketHead } from "./pot-store";
import { dedupe, meta, missingCutPages, supplySources, type Ahead, type Core, type Reader } from "./settle-plan";

/**
 * The planner of a many-seat Match (a Railcar car, ADR 0015) once core holds its result: which accounts the next
 * `many_seat_chunk` needs, then `close_many_seat` for each seat and `close_many_seat_match`. Shared by the Players'
 * pages and the keeper's safety sweep. Accounts are read in place (byte layouts, no Borsh), as core reads them.
 */

// The browser's Buffer polyfill has no BigInt readers, so 64-bit fields go through a DataView.
const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const u16 = (b: Uint8Array, at: number) => dv(b).getUint16(at, true);
const u32 = (b: Uint8Array, at: number) => dv(b).getUint32(at, true);
const u64 = (b: Uint8Array, at: number) => dv(b).getBigUint64(at, true);
const i64 = (b: Uint8Array, at: number) => Number(dv(b).getBigInt64(at, true));
const key = (b: Uint8Array, at: number) => new PublicKey(b.subarray(at, at + 32));
const pda = (...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, TESORO_CORE)[0];
const utf = (s: string) => Buffer.from(s);

export const SEATS_PER_PAGE = 10;
const MAX_SEATS = 100;
/** Most steps one `many_seat_chunk` takes (core's `MAX_SEAT_CHUNK_STEPS`). */
export const MAX_SEAT_CHUNK_STEPS = 7;

// ---- layouts (programs/tesoro_core/src/state.rs, ledger/many_seat) -----------------------------------------------

/** `ManySeatMatch`: discriminator, bump, listing epoch, payer, then the record. */
const INNER_AT = 8 + 1 + 4 + 32;
const RUN_AT = INNER_AT + 220;
const PLACE_LEN = 77;
const MAX_PLACES = 10;
export const CAR_SPACE = RUN_AT + 92 + PLACE_LEN * MAX_PLACES;
/** `SeatPage`: discriminator, car, payer, bump, index, 6 reserved, then 10 seats of 160 bytes. */
const PAGE_SEATS_AT = 8 + 32 + 32 + 1 + 1 + 6;
const SEAT_LEN = 160;
export const PAGE_SPACE = PAGE_SEATS_AT + SEATS_PER_PAGE * SEAT_LEN;
/** `SeatMark`: discriminator, bump, seat, returning, reserved, hold, car, account, then the payer. */
const MARK_PAYER_AT = 8 + 4 + 4 + 32 + 32;

/** Core's stage byte (not the enum's order). */
const STAGES = ["boarding", "departed", "closed", "settling", "refunding", "paid"] as const;
export type CarStage = (typeof STAGES)[number];

const PHASE_HOME = 0;
const PHASE_FORFEITS = 1;
const PHASE_DONE = 2;
const KIND_WIN = 0;

export interface PlaceSlot {
  seat: number;
  shareBps: number;
  playerShareBps: number;
  won: bigint;
  player: PublicKey;
  funder: PublicKey;
}

/** The frozen plan of a run and its cursor (`SeatRun`). */
export interface SeatRun {
  kind: number;
  phase: number;
  nPlaces: number;
  placeI: number;
  seatI: number;
  inSeat: number;
  visited: number;
  feesCapped: boolean;
  lineI: number;
  seatLeft: bigint;
  wonLeft: bigint;
  playerLeft: bigint;
  cutLeft: bigint[];
  chunks: number;
  steps: number;
  places: PlaceSlot[];
}

/** A decoded `ManySeatMatch`. */
export interface CarView {
  address: PublicKey;
  payer: PublicKey;
  opener: PublicKey;
  n: bigint;
  game: PublicKey;
  studioOwner: PublicKey | null;
  entry: bigint;
  openedAt: number;
  deadlineAbs: number;
  firstMinAt: number;
  departedAt: number;
  refundAfter: number;
  minSeats: number;
  maxSeats: number;
  seated: number;
  pages: number;
  stage: CarStage;
  run: SeatRun;
}

const discOf = (name: string): Buffer => {
  const a = (coreIdl as { accounts: { name: string; discriminator: number[] }[] }).accounts.find((x) => x.name === name);
  if (!a) throw new Error(`${name} is not in the tesoro_core IDL`);
  return Buffer.from(a.discriminator);
};
let carDisc: Buffer | null = null;
let pageDisc: Buffer | null = null;

/** Whether `data` is a `ManySeatMatch` account. */
export function isCar(data: Uint8Array): boolean {
  carDisc ??= discOf("ManySeatMatch");
  return data.length === CAR_SPACE && Buffer.from(data.subarray(0, 8)).equals(carDisc);
}

export function decodeRun(b: Uint8Array): SeatRun {
  const r = b.subarray(RUN_AT);
  const places: PlaceSlot[] = [];
  for (let i = 0; i < MAX_PLACES; i++) {
    const p = r.subarray(92 + i * PLACE_LEN);
    places.push({ seat: p[0], shareBps: u16(p, 1), playerShareBps: u16(p, 3), won: u64(p, 5), player: key(p, 13), funder: key(p, 45) });
  }
  return {
    kind: r[0],
    phase: r[1],
    nPlaces: r[2],
    placeI: r[3],
    seatI: r[4],
    inSeat: r[5],
    visited: r[6],
    feesCapped: r[7] !== 0,
    lineI: u32(r, 8),
    seatLeft: u64(r, 12),
    wonLeft: u64(r, 20),
    playerLeft: u64(r, 28),
    cutLeft: [0, 1, 2].map((c) => u64(r, 60 + 8 * c)),
    chunks: u32(r, 84),
    steps: u32(r, 88),
    places,
  };
}

/** The few facts of a car a scan reads (from a slice of at least `CAR_HEAD_LEN` bytes). */
export interface CarHead {
  game: PublicKey;
  stage: CarStage;
  openedAt: number;
  deadlineAbs: number;
  firstMinAt: number;
  departedAt: number;
  refundAfter: number;
  minSeats: number;
  seated: number;
}

/** Bytes of a car a head needs: through `refund_after`. */
export const CAR_HEAD_LEN = INNER_AT + 220;

/** Reads a car's head from the first bytes of its account; null when the bytes are not a car's. */
export function carHeadOf(data: Uint8Array): CarHead | null {
  carDisc ??= discOf("ManySeatMatch");
  if (data.length < CAR_HEAD_LEN || !Buffer.from(data.subarray(0, 8)).equals(carDisc)) return null;
  const b = data.subarray(INNER_AT);
  const stage = STAGES[b[205]];
  if (!stage) return null;
  return { game: key(b, 40), stage, openedAt: i64(b, 152), deadlineAbs: i64(b, 160), firstMinAt: i64(b, 176), departedAt: i64(b, 184), refundAfter: i64(b, 212), minSeats: b[201], seated: b[203] };
}

/** Decodes a `ManySeatMatch` account's data. Throws when it is not one. */
export function decodeCar(address: PublicKey, data: Uint8Array): CarView {
  if (!isCar(data)) throw new Error("not a many-seat Match");
  const b = data.subarray(INNER_AT);
  return {
    address,
    payer: key(data, 13),
    opener: key(b, 0),
    n: u64(b, 32),
    game: key(b, 40),
    studioOwner: b[196] === 1 ? key(b, 104) : null,
    entry: u64(b, 144),
    openedAt: i64(b, 152),
    deadlineAbs: i64(b, 160),
    firstMinAt: i64(b, 176),
    departedAt: i64(b, 184),
    refundAfter: i64(b, 212),
    minSeats: b[201],
    maxSeats: b[202],
    seated: b[203],
    pages: b[204],
    stage: STAGES[b[205]] ?? "closed",
    run: decodeRun(data),
  };
}

export interface CarSeat {
  /** Index in the car: page * 10 + slot. */
  index: number;
  seated: boolean;
  /** Place in the result (1 = first), 0 unplaced. */
  place: number;
  refund: bigint;
  hold: number;
  player: PublicKey;
  funder: PublicKey;
  pot: PublicKey;
}

export interface CarPage {
  address: PublicKey;
  car: PublicKey;
  payer: PublicKey;
  index: number;
  seats: CarSeat[];
}

export function decodePage(address: PublicKey, data: Uint8Array): CarPage {
  pageDisc ??= discOf("SeatPage");
  if (data.length !== PAGE_SPACE || !Buffer.from(data.subarray(0, 8)).equals(pageDisc)) throw new Error("not a seat page");
  const index = data[8 + 64 + 1];
  const seats: CarSeat[] = [];
  for (let slot = 0; slot < SEATS_PER_PAGE; slot++) {
    const s = data.subarray(PAGE_SEATS_AT + slot * SEAT_LEN);
    seats.push({ index: index * SEATS_PER_PAGE + slot, seated: s[0] === 1, place: s[6], refund: u64(s, 32), hold: u32(s, 12), player: key(s, 40), funder: key(s, 72), pot: key(s, 104) });
  }
  return { address, car: key(data, 8), payer: key(data, 40), index, seats };
}

export const seatPagePda = (car: PublicKey, page: number) => pda(utf("seat_page"), car.toBuffer(), Uint8Array.from([page]));
export const seatMarkPda = (car: PublicKey, account: PublicKey) => pda(utf("seat"), car.toBuffer(), account.toBuffer());
export const receiptPda = (car: PublicKey) => pda(utf("settled"), car.toBuffer());
const basketOf = (account: PublicKey) => pda(utf("basket"), account.toBuffer());
const spillOf = (account: PublicKey) => pda(utf("spill"), account.toBuffer());
const countersOf = (account: PublicKey) => pda(utf("counters"), account.toBuffer());
const sponsorAddress = pda(utf("sponsor"));

// ---- the next chunk's accounts (a port of `ManySeatRecord::ahead`) -------------------------------------------------

export interface SeatLine {
  source: PublicKey;
  amount: bigint;
}

/** What the next steps touch: seat pages, seats whose Pot moves, Accounts credited, Sources moved and cut from. */
export interface CarAhead {
  pages: number[];
  seats: number[];
  owners: PublicKey[];
  sources: PublicKey[];
  cutSources: PublicKey[];
}

const addKey = (v: PublicKey[], k: PublicKey) => {
  if (!v.some((x) => x.equals(k))) v.push(k);
};
const addNum = (v: number[], n: number) => {
  if (!v.includes(n)) v.push(n);
};
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/**
 * The accounts the next `maxSteps` steps of a Settling or Refunding car touch: a port of `ManySeatRecord::ahead`
 * (programs/tesoro_core/src/ledger/many_seat/settle.rs), walking a copy of the same cursor. `seats` are every seat of
 * every page in index order; `lines[i]` the Pot lines of seat `i` (empty when it has no Pot).
 */
export function carAhead(car: CarView, seats: CarSeat[], lines: SeatLine[][], maxSteps: number): CarAhead {
  const out: CarAhead = { pages: [], seats: [], owners: [], sources: [], cutSources: [] };
  if (car.stage !== "settling" && car.stage !== "refunding") return out;
  const entry = car.entry;
  const r = { ...car.run, cutLeft: [...car.run.cutLeft] };
  const amounts = lines.map((l) => l.map((x) => x.amount));
  const refundRun = r.kind !== KIND_WIN;
  const span = Math.min(seats.length, Math.min(car.pages * SEATS_PER_PAGE, MAX_SEATS));
  const owed = () => {
    let later = 0n;
    for (let p = r.placeI + 1; p < r.nPlaces; p++) later += r.places[p].won;
    return r.cutLeft.reduce((a, c) => a + c, 0n) + r.wonLeft + later;
  };
  const enterPlace = (i: number) => {
    r.placeI = i;
    const slot = r.places[i];
    r.wonLeft = slot.won;
    r.playerLeft = slot.player.equals(slot.funder) ? 0n : (slot.won * BigInt(slot.playerShareBps)) / 10_000n;
  };
  const nextSeat = () => {
    r.seatI += 1;
    r.inSeat = 0;
  };
  let left = maxSteps;
  while (left > 0 && r.phase !== PHASE_DONE) {
    if (r.phase === PHASE_HOME) {
      if (r.visited >= car.seated || r.seatI >= span) {
        r.phase = owed() === 0n ? PHASE_DONE : PHASE_FORFEITS;
        r.seatI = 0;
        r.inSeat = 0;
        continue;
      }
      const i = r.seatI;
      const s = seats[i];
      addNum(out.pages, Math.floor(i / SEATS_PER_PAGE));
      if (r.inSeat === 0) {
        const want = refundRun || s.place !== 0 ? entry : s.refund;
        if (!s.seated || want === 0n) {
          if (s.seated) r.visited += 1;
          nextSeat();
          continue;
        }
        r.seatLeft = want;
        r.lineI = 0;
        r.inSeat = 1;
      }
      let at = -1;
      for (let j = r.lineI; j < amounts[i].length; j++)
        if (amounts[i][j] > 0n) {
          at = j;
          break;
        }
      if (at < 0) break;
      const k = min(amounts[i][at], r.seatLeft);
      amounts[i][at] -= k;
      addKey(out.owners, s.funder);
      addKey(out.sources, lines[i][at].source);
      addNum(out.seats, i);
      r.lineI = at;
      r.seatLeft -= k;
      if (r.seatLeft === 0n) {
        nextSeat();
        r.visited += 1;
      }
      left -= 1;
    } else {
      if (owed() === 0n || r.seatI >= span) break;
      const i = r.seatI;
      const s = seats[i];
      addNum(out.pages, Math.floor(i / SEATS_PER_PAGE));
      if (r.inSeat === 0) {
        const lost = entry > s.refund ? entry - s.refund : 0n;
        if (!s.seated || s.place !== 0 || lost === 0n) {
          nextSeat();
          continue;
        }
        r.seatLeft = lost;
        r.lineI = amounts[i].length;
        r.inSeat = 1;
      }
      let at = -1;
      for (let j = r.lineI - 1; j >= 0; j--)
        if (amounts[i][j] > 0n) {
          at = j;
          break;
        }
      if (at < 0) break;
      let k = min(amounts[i][at], r.seatLeft);
      const source = lines[i][at].source;
      const c = [0, 1, 2].find((x) => r.cutLeft[x] > 0n);
      if (c !== undefined) {
        k = min(k, r.cutLeft[c]);
        r.cutLeft[c] -= k;
        addKey(out.cutSources, source);
        if (c === 1 && car.studioOwner) addKey(out.owners, car.studioOwner);
      } else {
        while (r.wonLeft === 0n && r.placeI + 1 < r.nPlaces) enterPlace(r.placeI + 1);
        const slot = r.places[r.placeI];
        k = min(k, r.wonLeft);
        if (!slot.player.equals(slot.funder) && r.playerLeft > 0n) {
          k = min(k, r.playerLeft);
          r.playerLeft -= k;
          addKey(out.owners, slot.player);
        } else addKey(out.owners, slot.funder);
        r.wonLeft -= k;
      }
      amounts[i][at] -= k;
      addKey(out.sources, source);
      addNum(out.seats, i);
      r.lineI = at + 1;
      r.seatLeft -= k;
      if (r.seatLeft === 0n) nextSeat();
      left -= 1;
    }
  }
  return out;
}

// ---- loading a car ------------------------------------------------------------------------------------------------

export interface LoadedCar {
  car: CarView;
  pages: CarPage[];
  seats: CarSeat[];
  lines: SeatLine[][];
}

/** Reads a car's pages and the Pots of its seated seats. Null when the car is gone. */
export async function loadCar(read: Reader, address: PublicKey): Promise<LoadedCar | null> {
  const [info] = await read.many([address]);
  if (!info) return null;
  const car = decodeCar(address, info.data);
  const pageKeys = Array.from({ length: car.pages }, (_, p) => seatPagePda(address, p));
  const pageInfos = await read.many(pageKeys);
  const pages = pageInfos.map((p, i) => {
    if (!p) throw new Error(`seat page ${i} of ${address.toBase58()} is missing`);
    return decodePage(pageKeys[i], p.data);
  });
  const seats = pages.flatMap((p) => p.seats);
  const potInfos = await read.many(seats.map((s) => s.pot));
  const lines = seats.map((s, i) => {
    const pot = potInfos[i];
    if (!s.seated || !pot || pot.data.length <= POT_AT) return [];
    return decodeStore(pot.data, POT_AT)
      .lines()
      .map((l) => ({ source: l.source, amount: l.amount }));
  });
  return { car, pages, seats, lines };
}

// ---- instructions ---------------------------------------------------------------------------------------------------

export interface CarChunkPlan {
  ix: TransactionInstruction;
  steps: number;
  /** Sources the steps touch whose book is missing: the chunk would refuse them. */
  missing: PublicKey[];
}

/** The pages, Pots, credited stores (and overflow records), and Source accounts of the next steps. */
export async function carChunkAccounts(core: Core, read: Reader, l: LoadedCar, steps: number): Promise<{ remaining: AccountMeta[]; ahead: Ahead[]; missing: PublicKey[] }> {
  const plan = carAhead(l.car, l.seats, l.lines, steps);
  const metas: AccountMeta[] = plan.pages.map((p) => meta(seatPagePda(l.car.address, p)));
  for (const i of plan.seats) metas.push(meta(l.seats[i].pot));
  const stores = await read.many(plan.owners.flatMap((o) => [basketOf(o), spillOf(o)]));
  plan.owners.forEach((o, i) => {
    if (stores[2 * i] && stores[2 * i + 1]) metas.push(meta(basketOf(o)), meta(spillOf(o)));
  });
  const recordKeys = plan.owners.map((o) => matchOverflowPda(o, { opener: l.car.opener, n: l.car.n }));
  const records = await read.many(recordKeys);
  records.forEach((r, i) => {
    if (r && r.data.length > 0) metas.push(meta(recordKeys[i]));
  });
  const ahead: Ahead[] = [];
  for (const s of plan.sources) ahead.push({ source: s, cut: plan.cutSources.some((c) => c.equals(s)) });
  for (const c of plan.cutSources) if (!ahead.some((a) => a.source.equals(c))) ahead.push({ source: c, cut: true });
  const supply = await supplySources(core, read, ahead);
  return { remaining: dedupe([...metas, ...supply.metas]), ahead, missing: supply.missing };
}

export const carChunkIx = (core: Core, o: { caller: PublicKey; car: PublicKey; steps: number; remaining: AccountMeta[] }): Promise<TransactionInstruction> =>
  core.methods.manySeatChunk(o.steps).accountsPartial({ caller: o.caller, matchState: o.car }).remainingAccounts(o.remaining).instruction();

/** The next chunk with as many steps as fit one transaction (down to 1). */
export async function planCarChunk(core: Core, read: Reader, caller: PublicKey, l: LoadedCar, steps: number, fitsOne: (ix: TransactionInstruction) => boolean): Promise<CarChunkPlan> {
  for (let n = Math.max(1, Math.min(steps, MAX_SEAT_CHUNK_STEPS)); ; n -= 1) {
    const { remaining, missing } = await carChunkAccounts(core, read, l, n);
    const ix = await carChunkIx(core, { caller, car: l.car.address, steps: n, remaining });
    if (n === 1 || fitsOne(ix)) return { ix, steps: n, missing };
  }
}

/** Checkpoint pages a fee cut of the next steps needs that do not exist yet (anyone may create them). */
export async function carMissingCutPages(core: Core, read: Reader, l: LoadedCar, steps: number) {
  const { ahead } = await carChunkAccounts(core, read, l, steps);
  return missingCutPages(read, ahead);
}

/** Closes one seat of a paid car: its Pot, the hold in its funder's spill, its marks (the Backer's on a backed seat). */
export async function closeSeatIx(core: Core, read: Reader, caller: PublicKey, l: LoadedCar, seat: CarSeat): Promise<TransactionInstruction> {
  const car = l.car.address;
  const mark = seatMarkPda(car, seat.player);
  const [markInfo, potInfo, sponsorInfo] = await read.many([mark, seat.pot, sponsorAddress]);
  if (!markInfo) throw new Error(`seat ${seat.index} has no mark`);
  if (!potInfo) throw new Error(`seat ${seat.index} has no Pot`);
  const backed = !seat.player.equals(seat.funder);
  return core.methods
    .closeManySeat(seat.index)
    .accountsPartial({
      caller,
      matchState: car,
      seatPage: seatPagePda(car, Math.floor(seat.index / SEATS_PER_PAGE)),
      seatMark: mark,
      markPayer: key(markInfo.data, MARK_PAYER_AT),
      playerCounters: countersOf(seat.player),
      pot: seat.pot,
      potPayer: decodeTicketHead(potInfo.data).payer,
      sponsor: sponsorInfo ? sponsorAddress : null,
      funderSpill: seat.hold > 0 ? spillOf(seat.funder) : null,
      funderMark: backed ? seatMarkPda(car, seat.funder) : null,
    })
    .instruction();
}

/** Closes a paid car once every seat is closed: remaining = each page and the key that paid it. */
export const closeCarMatchIx = (core: Core, caller: PublicKey, l: LoadedCar): Promise<TransactionInstruction> =>
  core.methods
    .closeManySeatMatch()
    .accountsPartial({ caller, matchState: l.car.address, matchPayer: l.car.payer })
    .remainingAccounts(l.pages.flatMap((p) => [meta(p.address), meta(p.payer)]))
    .instruction();

/** Core's anyone-refund of a car that left and was never settled (24 h after departure, or an upgraded Game). */
export const refundCarIx = (core: Core, o: { caller: PublicKey; car: CarView; programData: PublicKey }): Promise<TransactionInstruction> =>
  core.methods
    .refundManySeatMatch()
    .accountsPartial({ caller: o.caller, payer: o.caller, gameRecord: pda(utf("game"), o.car.game.toBuffer()), gameProgram: o.car.game, programData: o.programData, matchState: o.car.address, receipt: receiptPda(o.car.address) })
    .instruction();

// ---- finishing ------------------------------------------------------------------------------------------------------

/** Where a car is, as finishing it cares: a chunk moves `steps`, a closed seat lowers `seated`. Null once closed away. */
export const carProgress = (car: CarView) => `${car.stage}:${car.run.steps}:${car.seated}`;

export type CarStep = { kind: "chunk" | "close-seat" | "close-car"; ix: TransactionInstruction } | { kind: "stalled"; reason: string };

/** The next step that finishes a car whose result core holds: a chunk, a seat's close, or the car's close. */
export async function nextCarStep(core: Core, read: Reader, caller: PublicKey, l: LoadedCar, o: { steps: number; fitsOne: (ix: TransactionInstruction) => boolean }): Promise<CarStep> {
  const { car } = l;
  if (car.stage === "settling" || car.stage === "refunding") {
    const plan = await planCarChunk(core, read, caller, l, o.steps, o.fitsOne);
    if (plan.missing.length) return { kind: "stalled", reason: "missing-book" };
    return { kind: "chunk", ix: plan.ix };
  }
  if (car.stage === "paid") {
    const seat = l.seats.find((s) => s.seated);
    if (seat) return { kind: "close-seat", ix: await closeSeatIx(core, read, caller, l, seat) };
    return { kind: "close-car", ix: await closeCarMatchIx(core, caller, l) };
  }
  return { kind: "stalled", reason: car.stage };
}

export interface CarFinishDeps {
  load(address: PublicKey): Promise<LoadedCar | null>;
  next(l: LoadedCar): Promise<CarStep>;
  send(step: { kind: string; ix: TransactionInstruction }): Promise<string>;
  maxSteps?: number;
}

/**
 * Sends the steps that finish a car, as far as they go. Every step is permissionless and idempotent: a step that fails
 * because someone else moved the car first is not an error; one that fails with the car unmoved is thrown.
 */
export async function finishCar(deps: CarFinishDeps, address: PublicKey): Promise<{ done: boolean; stalled?: string; signatures: string[] }> {
  const signatures: string[] = [];
  const limit = deps.maxSteps ?? 200;
  let now = await deps.load(address);
  for (let i = 0; ; i++) {
    if (!now) return { done: true, signatures };
    if (i >= limit) return { done: false, stalled: "step-limit", signatures };
    const step = await deps.next(now);
    if (step.kind === "stalled") return { done: false, stalled: step.reason, signatures };
    let failure: unknown = null;
    try {
      signatures.push(await deps.send(step));
    } catch (e) {
      failure = e;
    }
    const after = await deps.load(address);
    const moved = !after || carProgress(after.car) !== carProgress(now.car);
    if (failure && !moved) throw failure;
    if (!failure && !moved) return { done: false, stalled: "no-progress", signatures };
    now = after;
  }
}
