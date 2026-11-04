/**
 * On-chain client for Railcar (programs/railcar): accounts, decoders and instruction builders. Pure: no network calls.
 *
 * Base layer: `open_car` (the first Player of a car opens core's many-seat Match), core's `join_many_seat_match` with
 * `check_departure` in the same transaction, then `finalize` (core settle by CPI) and core's chunks and closes.
 * Rollup (the Table, delegated to the TEE): `start_ride` -> VRF -> `signal` from open pages / `jump` -> the Table commits
 * itself at Impact. Time is rollup slots (`SLOTS_PER_SEC`); the ride clock starts at `Table.rideSlot`.
 */
import "../../lib/chain/polyfill";
import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, type AccountMeta, type TransactionInstruction } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { TESORO_CORE, matchPda, settledPda } from "../../lib/chain/basket";
import { idlIxBuilder } from "../../lib/chain/core-ix";
import { seatPagePda } from "../../lib/chain/many-seat";
import { MAGICBLOCK } from "../../lib/cluster-settings";
import idl from "../../lib/chain/idl/railcar.json";

const railcar = idlIxBuilder(idl as { address: string; instructions: unknown[] });
/** Placeholder until the real program keypair exists (ticket 15). */
export const RAILCAR_PROGRAM_ID = railcar.programId;
export const railcarIx = railcar.build;

// ---- Constants (programs/railcar/src/state.rs) ----------------------------------------------------------------------

export const ENTRY_GEMAS = 500;
export const MIN_SEATS = 5;
export const MAX_SEATS = 100;
export const COUNTDOWN_SECS = 30;
export const SLOTS_PER_SEC = 100;
export const MS_PER_SLOT = 1000 / SLOTS_PER_SEC;
export const DRAW_WINDOW_SECS = 90;
export const NO_SEAT = 255;

export type TablePhase = "idle" | "drawing" | "riding" | "over";
const PHASES: TablePhase[] = ["idle", "drawing", "riding", "over"];
export type RideOutcome = "none" | "placed" | "refund";
const OUTCOMES: RideOutcome[] = ["none", "placed", "refund"];
export type RideReason = "none" | "played" | "nobody-jumped" | "no-draw";
const REASONS: RideReason[] = ["none", "played", "nobody-jumped", "no-draw"];

// ---- Addresses -------------------------------------------------------------------------------------------------------

const pda = (...seeds: (string | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s)), RAILCAR_PROGRAM_ID)[0];
const corePda = (...seeds: (string | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s)), TESORO_CORE)[0];
const le = (n: bigint | number, len: number) => {
  const b = Buffer.alloc(len);
  let v = BigInt(n);
  for (let i = 0; i < len; i++) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
};

export const configPda = () => pda("config");
export const carPda = (carNo: bigint | number) => pda("car", le(carNo, 8));
export const tablePda = (index: number) => pda("table", le(index, 2));
export const vaultPda = (table: PublicKey) => pda("vault", table.toBuffer());
export const sponsorPda = () => pda("sponsor");
export const authorityPda = () => pda("authority");
export const identityPda = () => pda("identity");
const coreAccountOf = (wallet: PublicKey) => corePda("account", wallet.toBuffer());
const gameRecord = () => corePda("game", RAILCAR_PROGRAM_ID.toBuffer());
const programData = () => PublicKey.findProgramAddressSync([RAILCAR_PROGRAM_ID.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0];
const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");
const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");
const ORACLE_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
const VRF_PROGRAM = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
const SLOT_HASHES = new PublicKey("SysvarS1otHashes111111111111111111111111111");
export const magicFeeVault = () => PublicKey.findProgramAddressSync([Buffer.from("magic-fee-vault"), new PublicKey(MAGICBLOCK.teeValidator).toBuffer()], DELEGATION_PROGRAM_ID)[0];

// ---- Accounts ---------------------------------------------------------------------------------------------------------

const accounts = new BorshAccountsCoder(idl as unknown as Idl);

export interface RailcarConfigView {
  operator: PublicKey;
  tables: number;
  /** The number the next car gets. */
  nextCar: bigint;
  /** The core Match of the car boarding now (the default key before the first car). */
  boardingMatch: PublicKey;
}

export function decodeConfig(data: Uint8Array): RailcarConfigView {
  const c = accounts.decode("RailcarConfig", Buffer.from(data));
  return { operator: c.operator, tables: c.tables, nextCar: BigInt(c.next_car.toString()), boardingMatch: c.boarding_match };
}

export interface CarAccountView {
  carNo: bigint;
  /** The core many-seat Match it boards. */
  tesoroMatch: PublicKey;
  table: number;
  tables: number;
  openedAt: number;
  payer: PublicKey;
}

export function decodeCarAccount(data: Uint8Array): CarAccountView {
  const c = accounts.decode("Car", Buffer.from(data));
  return { carNo: BigInt(c.car_no.toString()), tesoroMatch: c.tesoro_match, table: c.table, tables: c.tables, openedAt: Number(c.opened_at.toString()), payer: c.payer };
}

/** One seat of a ride, public. */
export interface RideSeatView {
  /** Index in the Table's seats (what `jump` names). */
  tableSeat: number;
  /** The seat's index in the core Match. */
  seat: number;
  /** 0 while aboard, else the place in the Jump order (1 = first off). */
  order: number;
  /** Ride ms of the Jump. */
  jumpMs: number;
  /** Gemas of the entry the result refunds (written when the ride ends). */
  refund: bigint;
  /** The Player's core Account. */
  account: PublicKey;
}

/** A Table: one ride at a time (public part). */
export interface TableView {
  index: number;
  phase: TablePhase;
  outcome: RideOutcome;
  reason: RideReason;
  /** Tell stages passed: 0 none, 1 screws, 2 bolt and panel, 3 sparks and creak. */
  tell: number;
  falseScrews: number;
  seated: number;
  aboard: number;
  jumps: number;
  /** Table seats of the places, last Player off first (`NO_SEAT` unused). */
  places: number[];
  carNo: bigint;
  nextCar: bigint;
  car: PublicKey;
  tesoroMatch: PublicKey;
  entry: bigint;
  startedSlot: bigint;
  /** The ride clock: slot and unix time of the draw's arrival. */
  rideSlot: bigint;
  rideTs: number;
  overMs: number;
  overAt: number;
  seats: RideSeatView[];
}

const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const RIDE_SEAT = 72;
const SEATS_AT = 8 + 308;

/** The Table, read in place (zero-copy, alignment 1). */
export function decodeTable(data: Uint8Array): TableView {
  const v = dv(data);
  const b = 8;
  const seated = data[b + 9];
  const seats: RideSeatView[] = [];
  for (let i = 0; i < seated; i++) {
    const at = SEATS_AT + i * RIDE_SEAT;
    seats.push({ tableSeat: i, seat: data[at], order: data[at + 1], jumpMs: v.getUint32(at + 4, true), refund: v.getBigUint64(at + 8, true), account: new PublicKey(data.subarray(at + 16, at + 48)) });
  }
  return {
    index: v.getUint16(b + 2, true),
    phase: PHASES[data[b + 4]] ?? "idle",
    outcome: OUTCOMES[data[b + 5]] ?? "none",
    reason: REASONS[data[b + 6]] ?? "none",
    tell: data[b + 7],
    falseScrews: data[b + 8],
    seated,
    aboard: data[b + 10],
    jumps: data[b + 11],
    places: [data[b + 12], data[b + 13], data[b + 14]],
    carNo: v.getBigUint64(b + 24, true),
    nextCar: v.getBigUint64(b + 32, true),
    car: new PublicKey(data.subarray(b + 40, b + 72)),
    tesoroMatch: new PublicKey(data.subarray(b + 72, b + 104)),
    entry: v.getBigUint64(b + 104, true),
    startedSlot: v.getBigUint64(b + 136, true),
    rideSlot: v.getBigUint64(b + 144, true),
    rideTs: Number(v.getBigInt64(b + 152, true)),
    overMs: v.getUint32(b + 160, true),
    overAt: Number(v.getBigInt64(b + 164, true)),
    seats,
  };
}

// ---- Instructions: base layer -----------------------------------------------------------------------------------------

export interface OpenCarArgs {
  payer: PublicKey;
  /** The opening Player's wallet (it signs). */
  opener: PublicKey;
  config: RailcarConfigView;
  /** The opener's `next_match` (the new core Match is `["match", opener Account, n]`). */
  n: bigint;
}

/** `open_car`: opens the next car (core's many-seat Match for 500 Gemas, 5 to 100 seats) when none can take seats. */
export function openCarIx(a: OpenCarArgs): TransactionInstruction {
  const account = coreAccountOf(a.opener);
  return railcarIx(
    "open_car",
    {
      payer: a.payer,
      opener: a.opener,
      config: configPda(),
      car: carPda(a.config.nextCar),
      boarding_match: a.config.boardingMatch,
      match_state: matchPda(account, a.n),
      core_config: corePda("config"),
      economy: corePda("economy"),
      game_record: gameRecord(),
      game_program: RAILCAR_PROGRAM_ID,
      program_data: programData(),
      opener_account: account,
      counters: corePda("counters", account.toBuffer()),
      authority: authorityPda(),
      system_program: SystemProgram.programId,
    },
    { n: a.n },
  );
}

/** `check_departure`: anyone; makes a due car leave, else does nothing (so every join carries it). */
export const checkDepartureIx = (carNo: bigint, match: PublicKey): TransactionInstruction =>
  railcarIx("check_departure", { car: carPda(carNo), match_state: match, game_record: gameRecord(), game_program: RAILCAR_PROGRAM_ID, program_data: programData(), authority: authorityPda() });

/** `finalize`: anyone; reads the committed Table and sends core the result. Remaining = every seat page of the car. */
export function finalizeIx(caller: PublicKey, car: { carNo: bigint; table: number; tesoroMatch: PublicKey; payer: PublicKey }, pages: number): TransactionInstruction {
  const remaining: AccountMeta[] = Array.from({ length: pages }, (_, p) => ({ pubkey: seatPagePda(car.tesoroMatch, p), isSigner: false, isWritable: true }));
  return railcarIx(
    "finalize",
    {
      caller,
      car: carPda(car.carNo),
      car_payer: car.payer,
      table: tablePda(car.table),
      match_state: car.tesoroMatch,
      core_config: corePda("config"),
      game_record: gameRecord(),
      authority: authorityPda(),
      game_program: RAILCAR_PROGRAM_ID,
      program_data: programData(),
      receipt: settledPda(car.tesoroMatch),
      system_program: SystemProgram.programId,
      core_event_authority: corePda("__event_authority"),
      event_authority: pda("__event_authority"),
      program: RAILCAR_PROGRAM_ID,
    },
    {},
    remaining,
  );
}

// ---- Instructions: rollup ---------------------------------------------------------------------------------------------

const magic = () => ({ sponsor: sponsorPda(), magic_fee_vault: magicFeeVault(), magic_program: MAGIC_PROGRAM, magic_context: MAGIC_CONTEXT });

/** `start_ride`: anyone; puts the Table's next (departed) car on it and asks for the draw. Remaining = every seat page. */
export function startRideIx(payer: PublicKey, car: { carNo: bigint; table: number; tesoroMatch: PublicKey }, pages: number, previousMatch: PublicKey | null): TransactionInstruction {
  const table = tablePda(car.table);
  const remaining: AccountMeta[] = Array.from({ length: pages }, (_, p) => ({ pubkey: seatPagePda(car.tesoroMatch, p), isSigner: false, isWritable: false }));
  return railcarIx(
    "start_ride",
    {
      payer,
      table,
      vault: vaultPda(table),
      car: carPda(car.carNo),
      match_state: car.tesoroMatch,
      previous_receipt: previousMatch ? settledPda(previousMatch) : SystemProgram.programId,
      oracle_queue: ORACLE_QUEUE,
      program_identity: identityPda(),
      vrf_program: VRF_PROGRAM,
      slot_hashes: SLOT_HASHES,
      system_program: SystemProgram.programId,
    },
    {},
    remaining,
  );
}

/** `signal`: anyone; moves the Tell stage and, from the Impact slot, ends the ride and commits the Table. */
export const signalIx = (caller: PublicKey, tableIndex: number): TransactionInstruction => {
  const table = tablePda(tableIndex);
  return railcarIx("signal", { caller, table, vault: vaultPda(table), ...magic() });
};

/** `jump`: the Player of Table seat `tableSeat`. `signer` is the wallet of the seat's core Account. */
export const jumpIx = (signer: PublicKey, wallet: PublicKey, tableIndex: number, carNo: bigint, tableSeat: number): TransactionInstruction => {
  const table = tablePda(tableIndex);
  return railcarIx("jump", { player: signer, player_account: coreAccountOf(wallet), table, vault: vaultPda(table), ...magic() }, { car_no: carNo, seat: tableSeat });
};

/** `commit_table`: anyone; a result's commit, or a repeat of one that may have been lost. */
export const commitTableIx = (caller: PublicKey, tableIndex: number): TransactionInstruction =>
  railcarIx("commit_table", { caller, table: tablePda(tableIndex), sponsor: sponsorPda(), magic_fee_vault: magicFeeVault(), magic_program: MAGIC_PROGRAM, magic_context: MAGIC_CONTEXT });

/** `request_draw`: anyone; asks again when no draw came within 20 s. */
export const requestDrawIx = (payer: PublicKey, tableIndex: number): TransactionInstruction => {
  const table = tablePda(tableIndex);
  return railcarIx("request_draw", { payer, table, vault: vaultPda(table), oracle_queue: ORACLE_QUEUE, program_identity: identityPda(), vrf_program: VRF_PROGRAM, slot_hashes: SLOT_HASHES, system_program: SystemProgram.programId });
};
