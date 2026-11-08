import { PublicKey, type AccountMeta, type TransactionInstruction } from "@solana/web3.js";
import { basketPda, sponsorPda, spillPda } from "./basket";
import {
  MAX_SEAT_CHUNK_STEPS,
  SEATS_PER_PAGE,
  closeCarIx,
  closeSeatIx,
  decodeCar,
  decodeSeatMark,
  decodeSeatPage,
  reserveRoomIx,
  seatChunkIx,
  seatMarkPda,
  seatPagePda,
  type CarView,
  type SeatPageView,
  type SeatRunView,
  type SeatView,
} from "./many-seat";
import { matchOverflowPda } from "./overflow";
import { POT_AT, decodeStore, decodeTicketHead, slack } from "./pot-store";
import { dedupe, meta, sizeByCompute, supplySources, type Ahead, type Core, type Reader } from "./settle-plan";

/**
 * The one planner of a Settling or Refunding many-seat car (Railcar), shared by the Player's page and the keeper's sweep.
 * `aheadOf` is a port of `ManySeatRecord::ahead` (programs/tesoro_core/src/ledger/many_seat/settle.rs): it walks the same
 * cursor `many_seat_chunk` walks and lists the accounts the next steps touch. `creditsOf` runs it to the end to size the
 * room winners need. Below them, the chain half: load a car, size its next chunk, reserve room, close its seats and itself.
 */

/** The lines of one seat's Pot, in order, as far as the walk reads them. */
export type SeatLines = { source: PublicKey; amount: bigint }[];

/** What the next steps touch, so a client knows which accounts to pass. */
export interface SeatAhead {
  /** Seat pages read (every seat the cursor passes, moved or skipped). */
  pages: number[];
  /** Seats whose lines move (their Pot). */
  seats: number[];
  /** Accounts credited (basket and spill). */
  owners: PublicKey[];
  /** Sources of the lines that move (their book). */
  sources: PublicKey[];
  /** Sources a fee is cut from (also their Source and Position). */
  cutSources: PublicKey[];
  /** Steps the walk found (at most the steps asked for). */
  steps: number;
}

const addKey = (v: PublicKey[], k: PublicKey) => {
  if (!v.some((x) => x.equals(k))) v.push(k);
};
const addNum = (v: number[], n: number) => {
  if (!v.includes(n)) v.push(n);
};
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const playerShare = (won: bigint, bps: number) => (won * BigInt(bps)) / 10_000n;

interface Cursor {
  phase: SeatRunView["phase"];
  seatI: number;
  inSeat: boolean;
  visited: number;
  lineI: number;
  seatLeft: bigint;
  placeI: number;
  wonLeft: bigint;
  playerLeft: bigint;
  cutLeft: bigint[];
}

/**
 * Walks the run from its cursor for up to `maxSteps` steps, calling `credit` for every credit a step makes (an Account's
 * basket, or a fee class with no Account). Mirrors the program step by step; the returned `SeatAhead` is `ahead`'s.
 */
function walk(car: CarView, seats: SeatView[], lines: SeatLines[], maxSteps: number, credit: (owner: PublicKey | null) => void): SeatAhead {
  const out: SeatAhead = { pages: [], seats: [], owners: [], sources: [], cutSources: [], steps: 0 };
  if (car.stage !== "settling" && car.stage !== "refunding") return out;
  const run = car.run;
  const places = run.places;
  const r: Cursor = { phase: run.phase, seatI: run.seatI, inSeat: run.inSeat, visited: run.visited, lineI: run.lineI, seatLeft: run.seatLeft, placeI: run.placeI, wonLeft: run.wonLeft, playerLeft: run.playerLeft, cutLeft: [...run.cutLeft] };
  const amounts = lines.map((l) => l.map((x) => x.amount));
  const refundRun = run.kind !== 0;
  const span = Math.min(seats.length, Math.min(car.pages * SEATS_PER_PAGE, 100));
  const owed = () => r.cutLeft.reduce((a, b) => a + b, 0n) + r.wonLeft + places.slice(r.placeI + 1).reduce((a, p) => a + p.won, 0n);
  const nextSeat = () => {
    r.seatI += 1;
    r.inSeat = false;
  };
  const enterPlace = (i: number) => {
    r.placeI = i;
    const p = places[i];
    r.wonLeft = p.won;
    r.playerLeft = p.player.equals(p.funder) ? 0n : playerShare(p.won, p.playerShareBps);
  };
  let left = maxSteps;
  while (left > 0 && r.phase !== "done") {
    if (r.phase === "home") {
      if (r.visited >= car.seated || r.seatI >= span) {
        r.phase = owed() === 0n ? "done" : "forfeits";
        r.seatI = 0;
        r.inSeat = false;
        continue;
      }
      const i = r.seatI;
      const s = seats[i];
      addNum(out.pages, Math.floor(i / SEATS_PER_PAGE));
      if (!r.inSeat) {
        const whole = refundRun || s.place !== 0;
        const want = whole ? car.entry : s.refund;
        if (!s.seated || want === 0n) {
          if (s.seated) r.visited += 1;
          nextSeat();
          continue;
        }
        r.seatLeft = want;
        r.lineI = 0;
        r.inSeat = true;
      }
      let at = -1;
      for (let j = r.lineI; j < amounts[i].length; j++)
        if (amounts[i][j] > 0n) {
          at = j;
          break;
        }
      if (at < 0) break;
      const take = min(amounts[i][at], r.seatLeft);
      amounts[i][at] -= take;
      addKey(out.owners, s.funder);
      credit(s.funder);
      addKey(out.sources, lines[i][at].source);
      addNum(out.seats, i);
      r.lineI = at;
      r.seatLeft -= take;
      if (r.seatLeft === 0n) {
        nextSeat();
        r.visited += 1;
      }
    } else {
      if (owed() === 0n || r.seatI >= span) break;
      const i = r.seatI;
      const s = seats[i];
      addNum(out.pages, Math.floor(i / SEATS_PER_PAGE));
      if (!r.inSeat) {
        const lost = car.entry > s.refund ? car.entry - s.refund : 0n;
        if (!s.seated || s.place !== 0 || lost === 0n) {
          nextSeat();
          continue;
        }
        r.seatLeft = lost;
        r.lineI = amounts[i].length;
        r.inSeat = true;
      }
      let at = -1;
      for (let j = r.lineI - 1; j >= 0; j--)
        if (amounts[i][j] > 0n) {
          at = j;
          break;
        }
      if (at < 0) break;
      let take = min(amounts[i][at], r.seatLeft);
      const source = lines[i][at].source;
      const cls = [0, 1, 2].find((c) => r.cutLeft[c] > 0n);
      if (cls !== undefined) {
        take = min(take, r.cutLeft[cls]);
        r.cutLeft[cls] -= take;
        addKey(out.cutSources, source);
        if (cls === 1 && car.studioOwner) {
          addKey(out.owners, car.studioOwner);
          credit(car.studioOwner);
        } else credit(null);
      } else {
        while (r.wonLeft === 0n && r.placeI + 1 < places.length) enterPlace(r.placeI + 1);
        const slot = places[r.placeI];
        take = min(take, r.wonLeft);
        if (!slot.player.equals(slot.funder) && r.playerLeft > 0n) {
          take = min(take, r.playerLeft);
          r.playerLeft -= take;
          addKey(out.owners, slot.player);
          credit(slot.player);
        } else {
          addKey(out.owners, slot.funder);
          credit(slot.funder);
        }
        r.wonLeft -= take;
      }
      amounts[i][at] -= take;
      addKey(out.sources, source);
      addNum(out.seats, i);
      r.lineI = at + 1;
      r.seatLeft -= take;
      if (r.seatLeft === 0n) nextSeat();
    }
    left -= 1;
    out.steps += 1;
  }
  return out;
}

/**
 * The accounts the next `maxSteps` steps of a Settling or Refunding car touch. `seats` is every seat of the car by index
 * (empty seats too); `lines[i]` the lines of seat `i`'s Pot as they are now.
 */
export const aheadOf = (car: CarView, seats: SeatView[], lines: SeatLines[], maxSteps: number): SeatAhead => walk(car, seats, lines, maxSteps, () => {});

/**
 * Lines each Account receives over the rest of the run: an upper bound on the store room it needs (credits of the same
 * Source may merge). The page grows a winner's or the Studio's spill, or reserves its overflow record, before the chunks.
 */
export function creditsOf(car: CarView, seats: SeatView[], lines: SeatLines[]): { account: PublicKey; lines: number }[] {
  const out: { account: PublicKey; lines: number }[] = [];
  walk(car, seats, lines, Number.MAX_SAFE_INTEGER, (owner) => {
    if (!owner) return;
    const seen = out.find((o) => o.account.equals(owner));
    if (seen) seen.lines += 1;
    else out.push({ account: owner, lines: 1 });
  });
  return out;
}

// ---- The chain half -------------------------------------------------------------------------------------------------

/** A car with every page, the lines of every seat's Pot and who paid each Pot. */
export interface LoadedCar {
  car: CarView;
  pages: SeatPageView[];
  /** Every seat by index (`pages * 10` of them). */
  seats: SeatView[];
  /** Lines of seat `i`'s Pot as they are now (empty for an empty seat or a closed Pot). */
  lines: SeatLines[];
  /** Who paid seat `i`'s Pot (null when the Pot is gone). */
  potPayers: (PublicKey | null)[];
}

export async function loadCar(read: Reader, address: PublicKey): Promise<LoadedCar | null> {
  const [info] = await read.many([address]);
  if (!info) return null;
  const car = decodeCar(address, info.data);
  const pageInfos = await read.many(Array.from({ length: car.pages }, (_, p) => seatPagePda(address, p)));
  const pages = pageInfos.flatMap((p) => (p ? [decodeSeatPage(p.data)] : []));
  const seats = pages.sort((a, b) => a.index - b.index).flatMap((p) => p.seats);
  const pots = await read.many(seats.map((s) => s.pot));
  const lines: SeatLines[] = [];
  const potPayers: (PublicKey | null)[] = [];
  seats.forEach((s, i) => {
    const pot = s.seated ? pots[i] : null;
    if (!pot) {
      lines.push([]);
      potPayers.push(null);
      return;
    }
    lines.push(decodeStore(pot.data, POT_AT).lines().map((l) => ({ source: l.source, amount: l.amount })));
    potPayers.push(decodeTicketHead(pot.data).payer);
  });
  return { car, pages, seats, lines, potPayers };
}

/** The remaining accounts of a chunk whose steps `ahead` lists, given the overflow records that exist. */
export function chunkRemaining(l: Pick<LoadedCar, "car" | "seats">, ahead: SeatAhead, recordExists: (record: PublicKey) => boolean): AccountMeta[] {
  const out: AccountMeta[] = ahead.pages.map((p) => meta(seatPagePda(l.car.address, p)));
  for (const i of ahead.seats) out.push(meta(l.seats[i].pot));
  for (const o of ahead.owners) {
    out.push(meta(basketPda(o)), meta(spillPda(o)));
    const record = matchOverflowPda(o, { opener: l.car.opener, n: l.car.n });
    if (recordExists(record)) out.push(meta(record));
  }
  return dedupe(out);
}

/** The Sources `ahead` lists, as the head-to-head supplier takes them (a cut Source needs its Position too). */
export const sourcesOf = (ahead: SeatAhead): Ahead[] => {
  const out: Ahead[] = ahead.sources.map((source) => ({ source, cut: ahead.cutSources.some((c) => c.equals(source)) }));
  for (const c of ahead.cutSources) if (!out.some((o) => o.source.equals(c))) out.push({ source: c, cut: true });
  return out;
};

export interface SeatChunkPlan {
  ix: TransactionInstruction;
  steps: number;
  /** Sources whose book is missing: the chunk would refuse them. */
  missing: PublicKey[];
}

export interface SeatChunkSizing {
  /** Compute units a dry run of the chunk uses (null when it cannot be measured): the chunk then takes fewer steps until
   * it is under CHUNK_CU_TARGET, as head-to-head chunks do. A fee cut that syncs an open Advance costs about 8.6k, and 15k
   * on a staking token's Position, so 7 steps can use 250k (Railcar ticket 19). */
  simulate?(ix: TransactionInstruction): Promise<number | null>;
  log?(message: string): void;
}

/**
 * The next chunk of a Settling or Refunding car with as many steps as fit one transaction (7 at most, down to 1) and,
 * with `sizing.simulate`, the compute target. `fitsOne` says whether an instruction fits as the sender will compile it
 * (with or without a lookup table).
 */
export function planSeatChunk(core: Core, read: Reader, caller: PublicKey, l: LoadedCar, fitsOne: (ix: TransactionInstruction) => boolean, sizing: SeatChunkSizing = {}): Promise<SeatChunkPlan | null> {
  return sizeByCompute(MAX_SEAT_CHUNK_STEPS, (steps) => fittedSeatChunk(core, read, caller, l, fitsOne, steps), sizing.simulate && ((ix) => sizing.simulate!(ix)), sizing.log && ((m) => sizing.log!(m)));
}

/**
 * The chunk of up to `steps` steps, halved until it fits one transaction (bytes and accounts). Core marks a run Paid only
 * when a chunk takes one step past its last credit (`ManySeatRecord::chunk`), so a run that ends inside the chunk asks for
 * that one step more, and a run whose last credit went at the end of the previous chunk still gets a one-step chunk.
 */
async function fittedSeatChunk(core: Core, read: Reader, caller: PublicKey, l: LoadedCar, fitsOne: (ix: TransactionInstruction) => boolean, steps: number): Promise<SeatChunkPlan | null> {
  if (l.car.stage !== "settling" && l.car.stage !== "refunding") return null;
  for (let n = Math.max(1, Math.min(steps, MAX_SEAT_CHUNK_STEPS)); ; n = Math.max(1, Math.floor(n / 2))) {
    const ahead = aheadOf(l.car, l.seats, l.lines, n);
    const asked = Math.min(n, ahead.steps + 1);
    const records = ahead.owners.map((o) => matchOverflowPda(o, { opener: l.car.opener, n: l.car.n }));
    const have = await read.many(records);
    const exists = (r: PublicKey) => records.some((x, i) => x.equals(r) && !!have[i]);
    const supply = await supplySources(core, read, sourcesOf(ahead));
    const ix = seatChunkIx(caller, l.car.address, asked, dedupe([...chunkRemaining(l, ahead, exists), ...supply.metas]));
    if (n === 1 || fitsOne(ix)) return { ix, steps: asked, missing: supply.missing };
  }
}

/** Lines an Account still needs beyond its free store room. */
export interface RoomNeed {
  account: PublicKey;
  lines: number;
}

/**
 * Who the rest of the run credits more lines than their stores hold, and by how much: a winner or an outside Studio with
 * full stores would stop the forfeits, so the finishing page reserves their overflow record first (`reserve_many_seat_room`).
 * `free(account)` is the free room of the Account's basket + spill (null when it has no stores: the run needs them anyway).
 */
export function roomNeeds(credits: { account: PublicKey; lines: number }[], free: (account: PublicKey) => number | null, placesOf: PublicKey[]): RoomNeed[] {
  return credits
    .filter((c) => placesOf.some((p) => p.equals(c.account)))
    .flatMap((c) => {
      const f = free(c.account);
      const short = c.lines - Math.max(0, f ?? 0);
      return short > 0 ? [{ account: c.account, lines: short }] : [];
    });
}

/** Accounts the run pays beyond each seat's own hold: the places' Players and funders, and an outside Studio. */
export const paidAccounts = (car: CarView): PublicKey[] => {
  const out: PublicKey[] = [];
  for (const p of car.run.places) for (const k of [p.player, p.funder]) if (!out.some((o) => o.equals(k))) out.push(k);
  if (car.studioOwner && !out.some((o) => o.equals(car.studioOwner!))) out.push(car.studioOwner);
  return out;
};

/** The `reserve_many_seat_room` instructions a Settling car needs before its forfeits move. */
export async function roomIxs(read: Reader, payer: PublicKey, l: LoadedCar): Promise<TransactionInstruction[]> {
  if (l.car.stage !== "settling") return [];
  const accounts = paidAccounts(l.car);
  const infos = await read.many(accounts.flatMap((a) => [basketPda(a), spillPda(a), matchOverflowPda(a, { opener: l.car.opener, n: l.car.n })]));
  const free = (a: PublicKey) => {
    const i = accounts.findIndex((x) => x.equals(a));
    const [b, s, rec] = [infos[3 * i], infos[3 * i + 1], infos[3 * i + 2]];
    if (!b || !s) return null;
    // An existing record already gave room: count it as enough (it grows only by a further reserve).
    if (rec) return Number.MAX_SAFE_INTEGER;
    return slack(decodeStore(b.data), decodeStore(s.data));
  };
  return roomNeeds(creditsOf(l.car, l.seats, l.lines), free, accounts).map((n) => reserveRoomIx(payer, l.car, n.account, n.lines));
}

/** The closes of a Paid car: one per seat still seated, then the car itself. */
export async function closeIxs(read: Reader, caller: PublicKey, l: LoadedCar): Promise<TransactionInstruction[]> {
  if (l.car.stage !== "paid") return [];
  const seated = l.seats.filter((s) => s.seated);
  const marks = await read.many(seated.map((s) => seatMarkPda(l.car.address, s.player)));
  const [sponsor] = await read.many([sponsorPda()]);
  const out: TransactionInstruction[] = [];
  seated.forEach((s, i) => {
    const mark = marks[i];
    const potPayer = l.potPayers[s.index];
    if (!mark || !potPayer) return;
    out.push(closeSeatIx({ caller, car: l.car.address, seat: s, markPayer: decodeSeatMark(mark.data).payer, potPayer, sponsor: !!sponsor }));
  });
  if (out.length === seated.length) out.push(closeCarIx(caller, l.car, l.pages));
  return out;
}
