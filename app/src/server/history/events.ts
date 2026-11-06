import * as anchor from "@coral-xyz/anchor";
import type { IdlField } from "@coral-xyz/anchor/dist/cjs/idl";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import coreIdl from "../../lib/chain/idl/tesoro_core.json";
import railcarIdl from "../../lib/chain/idl/railcar.json";
import type { StoredRide } from "../../lib/chain/ride-record";

const CORE = new PublicKey((coreIdl as { address: string }).address);
const EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], CORE)[0].toBase58();
/** Anchor's event-CPI instruction tag: the first 8 bytes of the data of the self-call that carries an event. */
const EVENT_TAG = Buffer.from("e445a52e51cb9a1d", "hex");
/** Decoded event fields keep the IDL's snake_case names. */
const coder = new anchor.BorshEventCoder(coreIdl as anchor.Idl);
/** Railcar: its `finalize` reveals the ride (event-CPI under Railcar's own event authority). */
const RAILCAR = new PublicKey((railcarIdl as { address: string }).address);
const RAILCAR_EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], RAILCAR)[0].toBase58();
const railcarCoder = new anchor.BorshEventCoder(railcarIdl as anchor.Idl);
// sha256("event:<name>")[..8], pinned independently of the IDL so a missing IDL event fails closed.
const CHUNK_DISC = "f9dcbc7080eb500a";
const LINE_DISCS = new Set(["2c6817949b2b6a55", CHUNK_DISC]);
function legacyChunkCoder(overflow: boolean) {
  const idl = coreIdl as anchor.Idl;
  const chunk = idl.types?.find((t) => t.name === "MatchChunkDone");
  if (!chunk || chunk.type.kind !== "struct" || !chunk.type.fields) throw new Error("Missing legacy chunk layout");
  const named = chunk.type.fields;
  if (!named.every((f): f is IdlField => typeof f === "object" && f !== null && "name" in f)) throw new Error("Legacy chunk requires named fields");
  const fields = new Set(["opener", "n", "chunk_no", "steps", "done", "blocked", ...(overflow ? ["overflowed"] : [])]);
  return new anchor.BorshEventCoder({ ...idl, events: idl.events?.filter((e) => e.name === "MatchChunkDone"),
    types: [{ ...chunk, type: { ...chunk.type, fields: named.filter((f) => fields.has(f.name)) } }] });
}
const legacyChunk = legacyChunkCoder(true), olderChunk = legacyChunkCoder(false);

/** An instruction run inside a transaction, as its account keys and data. */
export interface InnerInstruction {
  programId: string;
  accounts: string[];
  data: Uint8Array;
}

const key = (v: unknown) => new PublicKey(v as PublicKey).toBase58();
const num = (v: unknown) => Number((v as { toString(): string }).toString());

export interface MatchRunStartedRecord {
  type: "start";
  opener: string;
  n: bigint;
  game: string;
  /** 0 win, 1 no-show, 2 draw, 3 cancelled, 4 abandoned, 5 game upgraded, 6 refunded by game. */
  kind: number;
  /** 0 opened, 1 joined; null when there is none. */
  winnerSide: 0 | 1 | null;
  entry: number;
  /** Exact wire values for Source-line reconciliation; display values above remain numbers. */
  entryExact?: string;
  feesExact?: [string, string, string];
  /** Gemas taken from the Pot: Platform, Studio, Leaderboard. */
  fees: [number, number, number];
  aPlayer: string;
  aFunder: string;
  bPlayer: string | null;
  bFunder: string | null;
  challenge: boolean;
  asset: number;
  openedAt: number;
  ts: number;
  /** Each side's Player share of a Backing, in bps (0 for an unbacked side). */
  aShareBps: number;
  bShareBps: number;
}
export interface MatchWonRecord {
  type: "won";
  opener: string;
  n: bigint;
  game: string;
  entry: number;
  entryExact?: string;
  poolFeeExact?: string;
  winner: string;
  funder: string;
  loser: string;
  points: number;
  poolFee: number;
  season: number;
  ts: number;
  challenge: boolean;
  asset: number;
  openedAt: number;
}
export interface MatchChunkRecord {
  type: "chunk";
  opener: string;
  n: bigint;
  chunkNo: number;
  steps: number;
  done: boolean;
  blocked: boolean;
  /** A many-seat chunk: where each entry-back and refund line went (the history's refund rows when no ride was revealed). */
  seatLines?: SeatLineRef[];
}
export interface MatchSettledRecord {
  type: "settled";
  opener: string;
  n: bigint;
  kind: number;
  chunks: number;
}
export interface MatchLinesStartedRecord {
  type: "lines-start"; opener: string; n: bigint; version: number; potLines: [number, number];
  studioOwner: string | null; studioPriority: boolean;
}
export interface MatchLineStepRecord {
  type: "line-step"; opener: string; n: bigint; version: number; chunkNo: number; step: number;
  potSide: number; potIndex: number; purpose: number; incoming: string; outgoing: string;
  recipientKind: number; recipient: string; placement: number;
}
export interface MatchLinesProgressRecord {
  type: "lines-progress"; opener: string; n: bigint; version: number; chunkNo: number; cumulativeSteps: number; done: boolean;
}
export type MatchLineRecord = MatchLinesStartedRecord | MatchLineStepRecord | MatchLinesProgressRecord;
/** The start of a many-seat Match's run (`ManySeatRunStarted`) with its paid places, first place first. */
export interface ManySeatStartRecord {
  type: "seats-start";
  opener: string;
  n: bigint;
  game: string;
  /** 0 win, 4 abandoned, 5 Game upgraded, 6 refunded by the Game. */
  kind: number;
  entry: number;
  fees: [number, number, number];
  seated: number;
  /** MatchWon's open time when the transaction has one, else the run's start. */
  openedAt: number;
  ts: number;
  places: StoredRide["places"];
}
/** A finished Railcar ride as `reveal_ride` published it (`RideRevealed`, Railcar's own event authority). */
export interface RideRevealedRecord {
  type: "ride";
  opener: string;
  n: bigint;
  ride: Omit<StoredRide, "places" | "fees">;
}
/** The seats a many-seat chunk sent Gemas home to: each line's seat, purpose (3 entry back, 5 early refund) and recipient Account. */
export interface SeatLineRef {
  seat: number;
  purpose: number;
  recipient: string;
}
export type MatchRecord = (MatchRunStartedRecord | MatchWonRecord | MatchChunkRecord | MatchSettledRecord | MatchLineRecord | ManySeatStartRecord | RideRevealedRecord) & { coreEvent?: string };

const ZERO = PublicKey.default.toBase58();
const opt = (k: string) => (k === ZERO ? null : k);

function toRecord(name: string, d: any): MatchRecord | null {
  if (!["MatchRunStarted", "MatchWon", "MatchChunkDone", "MatchSettled", "MatchLinesStarted", "MatchLineStep", "MatchLinesProgress"].includes(name)) return null;
  const id = { opener: key(d.opener), n: BigInt(d.n.toString()) };
  if (name.startsWith("MatchLine") && d.version !== 1) throw new Error(`Unsupported Match line stream version ${d.version}`);
  switch (name) {
    case "MatchRunStarted":
      return {
        type: "start",
        ...id,
        game: key(d.game),
        kind: d.kind,
        winnerSide: d.winner === 0 || d.winner === 1 ? d.winner : null,
        entry: num(d.entry),
        entryExact: d.entry.toString(),
        feesExact: d.fees.map((v: { toString(): string }) => v.toString()),
        fees: [num(d.fees[0]), num(d.fees[1]), num(d.fees[2])],
        aPlayer: key(d.a_player),
        aFunder: key(d.a_funder),
        bPlayer: opt(key(d.b_player)),
        bFunder: opt(key(d.b_funder)),
        challenge: d.challenge,
        asset: d.asset,
        openedAt: num(d.opened_at),
        ts: num(d.ts),
        aShareBps: d.a_share_bps,
        bShareBps: d.b_share_bps,
      };
    case "MatchWon":
      return {
        type: "won",
        ...id,
        game: key(d.game),
        entry: num(d.entry),
        entryExact: d.entry.toString(),
        poolFeeExact: d.pool_fee.toString(),
        winner: key(d.player),
        funder: key(d.funder),
        loser: key(d.loser),
        points: num(d.points),
        poolFee: num(d.pool_fee),
        season: d.season,
        ts: num(d.ts),
        challenge: d.challenge,
        asset: d.asset,
        openedAt: num(d.opened_at),
      };
    case "MatchChunkDone":
      return { type: "chunk", ...id, chunkNo: d.chunk_no, steps: d.steps, done: d.done, blocked: d.blocked };
    case "MatchSettled":
      return { type: "settled", ...id, kind: d.kind, chunks: d.chunks };
    case "MatchLinesStarted":
      return { type: "lines-start", ...id, version: d.version, potLines: d.pot_lines, studioOwner: opt(key(d.studio_owner)), studioPriority: d.studio_priority };
    case "MatchLineStep":
      return { type: "line-step", ...id, version: d.version, chunkNo: d.chunk_no, step: d.step,
        potSide: d.line.pot_side, potIndex: Buffer.from(d.line.pot_index_le).readUInt32LE(0), purpose: d.line.purpose,
        incoming: Buffer.from(d.line.incoming).toString("base64"), outgoing: Buffer.from(d.line.outgoing).toString("base64"),
        recipientKind: d.line.recipient_kind, recipient: key(d.line.recipient), placement: d.line.placement };
    case "MatchLinesProgress":
      return { type: "lines-progress", ...id, version: d.version, chunkNo: d.chunk_no, cumulativeSteps: d.cumulative_steps, done: d.done };
    default:
      return null;
  }
}

const RIDE_OUTCOMES = { 1: "placed", 2: "refund" } as const;
const RIDE_REASONS = ["none", "played", "nobody-jumped", "no-draw", "outage"] as const;
const hex = (b: ArrayLike<number>) => Buffer.from(Uint8Array.from(b)).toString("hex");

/**
 * Railcar's `RideRevealed` records in this transaction: event-CPIs Railcar issued under its own event authority. One of
 * those that does not decode fails the transaction closed (it stays pending), as Source-line events do.
 */
function rideRecords(inner: InnerInstruction[]): RideRevealedRecord[] {
  const out: RideRevealedRecord[] = [];
  for (const ix of inner) {
    if (ix.programId !== RAILCAR.toBase58() || ix.accounts[0] !== RAILCAR_EVENT_AUTHORITY) continue;
    const data = Buffer.from(ix.data);
    if (data.length <= 8 || !data.subarray(0, 8).equals(EVENT_TAG)) continue;
    let event;
    try {
      event = railcarCoder.decode(data.subarray(8).toString("base64"));
    } catch {
      event = null;
    }
    if (!event) throw new Error("Cannot decode a Railcar event; history cursor must wait");
    if (event.name !== "RideRevealed") continue;
    const d = event.data;
    const outcome = RIDE_OUTCOMES[d.outcome as 1 | 2];
    if (!outcome) throw new Error("A RideRevealed with no outcome; history cursor must wait");
    const draw = Uint8Array.from(d.draw);
    out.push({
      type: "ride",
      opener: key(d.opener),
      n: BigInt(d.n.toString()),
      ride: {
        carNo: d.car_no.toString(),
        outcome,
        reason: RIDE_REASONS[d.reason] ?? "none",
        draw: draw.some((b) => b !== 0) ? hex(draw) : null,
        brakes: d.brakes.map((b: any) => ({ seat: b.seat, ms: b.ms })),
        seats: d.seats.map((s: any) => ({ seat: s.seat, player: key(s.player), funder: key(s.backer ?? s.player), shareBps: s.share_bps, order: s.order, jumpMs: s.jump_ms, refund: num(s.refund) })),
      },
    });
  }
  return out;
}

/**
 * The Match records among a transaction's inner instructions. Only an event-CPI that tesoro_core itself
 * issued counts: the instruction's program is tesoro_core and its first account is core's event-authority
 * PDA, which only core can sign for. A log line printed by any other program, or the same bytes sent as
 * another program's instruction, is ignored (the Fake-wins fix of 93e7960, kept for event-CPI).
 */
export function decodeMatchRecords(inner: InnerInstruction[]): MatchRecord[] {
  const out: MatchRecord[] = [];
  let run: any = null;
  let runAt = 0;
  let wonAt: number | null = null;
  const placed: any[] = [];
  for (const ix of inner) {
    if (ix.programId !== CORE.toBase58() || ix.accounts[0] !== EVENT_AUTHORITY) continue;
    const data = Buffer.from(ix.data);
    if (data.length <= 8 || !data.subarray(0, 8).equals(EVENT_TAG)) continue;
    let event;
    const discriminator = data.subarray(8, 16).toString("hex");
    const lineEvent = LINE_DISCS.has(discriminator);
    const chunk = discriminator === CHUNK_DISC;
    const legacy = chunk && (data.length === 66 || data.length === 70);
    const sourceChunk = chunk && !legacy;
    if (sourceChunk) {
      if (data.length < 79) throw new Error("Invalid Source-line chunk length; history cursor must wait");
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const count = view.getUint32(75, true), steps = view.getUint32(60, true), first = view.getUint32(71, true);
      if (data[70] !== 1 || count > 12 || steps !== count || data.length !== 79 + 328 * count
        || data[64] > 1 || data[65] > 1 || (data[64] === 1 && data[65] === 1)
        || (count === 0 ? first !== 0 || data[64] !== 1 : first < 1 || first + count - 1 > 0xffffffff)) {
        throw new Error("Invalid Source-line chunk; history cursor must wait");
      }
    }
    try {
      event = (legacy ? data.length === 66 ? olderChunk : legacyChunk : coder).decode(data.subarray(8).toString("base64"));
    } catch {
      if (lineEvent) throw new Error("Cannot decode Source-line event; history cursor must wait");
      continue;
    }
    if (lineEvent && !event) throw new Error("Source-line event missing from core IDL; history cursor must wait");
    const prefix = event && toRecord(event.name, event.data);
    if (prefix) out.push({ ...prefix, coreEvent: data.toString("base64") });
    if (event?.name === "ManySeatRunStarted") {
      runAt = out.length;
      run = event.data;
    } else if (event?.name === "ManySeatPlaced") placed.push(event.data);
    else if (event?.name === "MatchWon") wonAt = num(event.data.opened_at);
    else if (event?.name === "ManySeatSettled" || event?.name === "ManySeatChunkDone") {
      const d = event.data;
      const id = { opener: key(d.opener), n: BigInt(d.n.toString()) };
      if (event.name === "ManySeatSettled") out.push({ type: "settled", ...id, kind: d.kind, chunks: d.chunks });
      else {
        const seatLines = (d.lines as any[]).filter((l) => l.purpose === 3 || l.purpose === 5).map((l) => ({ seat: l.pot_side, purpose: l.purpose, recipient: key(l.recipient) }));
        out.push({ type: "chunk", ...id, chunkNo: d.chunk_no, steps: d.steps, done: d.done, blocked: d.blocked, seatLines });
      }
    }
    if (sourceChunk && event?.name === "MatchChunkDone") {
      const d = event.data;
      if (d.record_version !== 1 || !Array.isArray(d.lines) || d.lines.length !== d.steps) throw new Error("Source-line chunk missing from core IDL; history cursor must wait");
      for (let i = 0; i < d.steps; i++) {
        const record = toRecord("MatchLineStep", { ...d, version: d.record_version, step: d.first_step + i, line: d.lines[i] });
        if (record) out.push({ ...record, coreEvent: data.toString("base64") });
      }
      // A Closed retry carries no new work and must not conflict with the original progress record.
      if (d.steps > 0) out.push({ type: "lines-progress", opener: key(d.opener), n: BigInt(d.n.toString()), version: d.record_version,
        chunkNo: d.chunk_no, cumulativeSteps: d.first_step + d.steps - 1, done: d.done, coreEvent: data.toString("base64") });
    }
  }
  if (run) {
    out.splice(runAt, 0, {
      type: "seats-start",
      opener: key(run.opener),
      n: BigInt(run.n.toString()),
      game: key(run.game),
      kind: run.kind,
      entry: num(run.entry),
      fees: [num(run.fees[0]), num(run.fees[1]), num(run.fees[2])],
      seated: run.seated,
      openedAt: wonAt ?? num(run.ts),
      ts: num(run.ts),
      places: placed
        .sort((a, b) => a.place - b.place)
        .map((p) => ({ place: p.place, seat: p.seat, player: key(p.player), funder: key(p.funder), shareBps: p.share_bps, won: num(p.won) })),
    });
  }
  return [...out, ...rideRecords(inner)];
}

/** Events of the given names that tesoro_core itself emitted (the same program and event-authority checks as `decodeMatchRecords`). */
export function decodeCoreEvents(inner: InnerInstruction[], names: string[]): { name: string; data: any }[] {
  const out: { name: string; data: any }[] = [];
  for (const ix of inner) {
    if (ix.programId !== CORE.toBase58() || ix.accounts[0] !== EVENT_AUTHORITY) continue;
    const data = Buffer.from(ix.data);
    if (data.length <= 8 || !data.subarray(0, 8).equals(EVENT_TAG)) continue;
    let event;
    try {
      event = coder.decode(data.subarray(8).toString("base64"));
    } catch {
      continue;
    }
    if (event && names.includes(event.name)) out.push({ name: event.name, data: event.data });
  }
  return out;
}

/** The inner instructions of a `getTransaction` response (maxSupportedTransactionVersion 0), failed transactions excluded. */
export function innerInstructionsOf(tx: {
  meta: { err: unknown; innerInstructions?: { instructions: { programIdIndex: number; accounts: number[]; data: string }[] }[] | null; loadedAddresses?: { writable: PublicKey[]; readonly: PublicKey[] } } | null;
  transaction: { message: { staticAccountKeys?: PublicKey[]; accountKeys?: PublicKey[] } };
}): InnerInstruction[] {
  if (!tx.meta || tx.meta.err) return [];
  const m = tx.transaction.message;
  const keys = [...(m.staticAccountKeys ?? m.accountKeys ?? []), ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])].map((k) => k.toBase58());
  return (tx.meta.innerInstructions ?? []).flatMap((g) =>
    g.instructions.map((i) => ({ programId: keys[i.programIdIndex], accounts: i.accounts.map((a) => keys[a]), data: bs58.decode(i.data) })),
  );
}
