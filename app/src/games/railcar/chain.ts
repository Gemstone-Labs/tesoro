import * as anchor from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, type AccountMeta, type TransactionInstruction } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID, MAGIC_PROGRAM_ID, getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import railcarIdl from "../../lib/chain/idl/railcar.json";
import { gameAccounts } from "../../lib/chain/game-record";
import { MAGICBLOCK } from "../../lib/cluster-settings";
import { receiptPda, seatPagePda, type CarView } from "../../lib/chain/many-seat-plan";
import { rdI64, rdU64, u64 } from "../../lib/chain/native";
import type { Railcar } from "../../lib/chain/idl/railcar.types";
import type { PlayerSigner } from "../holdem/chain";

/**
 * Railcar on chain, as far as finishing a ride needs it (programs/railcar, `.scratch/railcar/06-ride-decision.md`): the
 * public Table and the Car, and the steps any Player's page sends: `check_departure`, `start_ride`, `signal`,
 * `commit_table`, `finalize`, `skip_car`, `close_car`. The keeper's safety sweep sends the same steps for a ride whose
 * pages are all gone (`nextRideStep` picks the step).
 */

export const RAILCAR_PROGRAM_ID = new PublicKey((railcarIdl as { address: string }).address);
const TESORO_CORE = new PublicKey("AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh");
const TEE_VALIDATOR = new PublicKey(MAGICBLOCK.teeValidator);
const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");
const ORACLE_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");

// Mirrors programs/railcar/src/state.rs.
export const SLOTS_PER_SEC = 100;
export const DRAW_WINDOW_SLOTS = 90 * SLOTS_PER_SEC;
/** The longest a ride runs once its draw is in (the 10-minute cap with Brakes). */
export const RIDE_CAP_SECS = 10 * 60;
/** `table_kit::COMMIT_RETRY_SECS`: a lost commit may be sent again this long after the last. */
export const COMMIT_RETRY_SECS = 120;

export const PHASE = { idle: 0, drawing: 1, riding: 2, over: 3 } as const;
export const OUTCOME = { none: 0, placed: 1, refund: 2 } as const;
export const REASON = { none: 0, played: 1, nobodyJumped: 2, noDraw: 3, outage: 4 } as const;

const pda = (...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, RAILCAR_PROGRAM_ID)[0];
const utf = (s: string) => Buffer.from(s);
const u16le = (n: number) => Uint8Array.from([n & 0xff, n >> 8]);

export const configPda = () => pda(utf("config"));
export const tablePda = (index: number) => pda(utf("table"), u16le(index));
export const carPda = (carNo: bigint) => pda(utf("car"), u64(carNo));
export const vaultPda = (table: PublicKey) => pda(utf("vault"), table.toBuffer());
export const sponsorPda = () => pda(utf("sponsor"));
export const authorityPda = () => pda(utf("authority"));
export const magicFeeVaultPda = () => PublicKey.findProgramAddressSync([utf("magic-fee-vault"), TEE_VALIDATOR.toBuffer()], DELEGATION_PROGRAM_ID)[0];
const coreEventAuthority = PublicKey.findProgramAddressSync([utf("__event_authority")], TESORO_CORE)[0];

// ---- the public Table (zero-copy bytes, read in place) ------------------------------------------------------------

/** Offsets in a Table account (after the 8-byte discriminator), checked against the IDL by chain.test.ts. */
export const TABLE_AT = { index: 2, phase: 4, outcome: 5, reason: 6, seated: 9, aboard: 10, jumps: 11, dirty: 16, carNo: 24, nextCar: 32, car: 40, tesoroMatch: 72, startedSlot: 136, rideSlot: 144, rideTs: 152, overAt: 164, commitAt: 172 } as const;

export interface TableView {
  address: PublicKey;
  index: number;
  phase: number;
  outcome: number;
  reason: number;
  seated: number;
  jumps: number;
  dirty: boolean;
  carNo: bigint;
  nextCar: bigint;
  car: PublicKey;
  tesoroMatch: PublicKey;
  startedSlot: bigint;
  rideSlot: bigint;
  rideTs: number;
  overAt: number;
  commitAt: number;
}

export function decodeTable(address: PublicKey, data: Uint8Array): TableView {
  const b = data.subarray(8);
  const at = TABLE_AT;
  const key = (o: number) => new PublicKey(b.subarray(o, o + 32));
  return {
    address,
    index: b[at.index] | (b[at.index + 1] << 8),
    phase: b[at.phase],
    outcome: b[at.outcome],
    reason: b[at.reason],
    seated: b[at.seated],
    jumps: b[at.jumps],
    dirty: b[at.dirty] === 1,
    carNo: rdU64(b, at.carNo),
    nextCar: rdU64(b, at.nextCar),
    car: key(at.car),
    tesoroMatch: key(at.tesoroMatch),
    startedSlot: rdU64(b, at.startedSlot),
    rideSlot: rdU64(b, at.rideSlot),
    rideTs: Number(rdI64(b, at.rideTs)),
    overAt: Number(rdI64(b, at.overAt)),
    commitAt: Number(rdI64(b, at.commitAt)),
  };
}

export interface CarAccount {
  address: PublicKey;
  carNo: bigint;
  tesoroMatch: PublicKey;
  table: number;
  tables: number;
  payer: PublicKey;
}

/** Where a core car rides: its Railcar Car (null once closed), its Table and the Table on the rollup and on base. */
export interface Ride {
  carNo: bigint | null;
  car: CarAccount | null;
  table: TableView;
  /** Base's committed copy of the Table (null when unreadable). */
  baseTable: TableView | null;
  /** Core froze the car the Table last rode (its receipt exists), so the Table may take its next car. */
  previousFrozen: boolean;
}

export interface RailcarChainOptions {
  base?: Connection;
  teeRpc?: string;
}

export class RailcarChain {
  readonly base: Connection;
  /** Typed from the generated IDL: a call to an instruction the program no longer has is a compile error. */
  readonly program: anchor.Program<Railcar>;
  readonly tesoro: anchor.Program<any>;
  private readonly teeRpc: string;
  private readonly tee = new Map<string, Connection>();

  constructor(idl: Railcar, tesoroIdl: any, opts: RailcarChainOptions & { base: Connection }) {
    this.base = opts.base;
    this.teeRpc = opts.teeRpc ?? MAGICBLOCK.teeRpc;
    const provider = new anchor.AnchorProvider(this.base, { publicKey: Keypair.generate().publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t }, { commitment: "confirmed" });
    this.program = new anchor.Program(idl, provider);
    this.tesoro = new anchor.Program(tesoroIdl, provider);
  }

  /** A TEE connection authenticated as `signer` (tokens are per key). */
  async teeConnection(signer: PlayerSigner): Promise<Connection> {
    const k = signer.publicKey.toBase58();
    const cached = this.tee.get(k);
    if (cached) return cached;
    const { token } = await getAuthToken(this.teeRpc, signer.publicKey, (m: Uint8Array) => signer.signMessage(m));
    const conn = new Connection(`${this.teeRpc}?token=${token}`, { commitment: "confirmed" });
    this.tee.set(k, conn);
    return conn;
  }

  // -- reads --------------------------------------------------------------------------------------

  async config(): Promise<{ tables: number; nextCar: bigint; boardingMatch: PublicKey }> {
    const info = await this.base.getAccountInfo(configPda());
    if (!info) throw new Error("Railcar has no config");
    const c: any = this.program.coder.accounts.decode("railcarConfig", info.data);
    return { tables: c.tables, nextCar: BigInt(c.nextCar.toString()), boardingMatch: c.boardingMatch };
  }

  /** The Railcar Car of the car boarding now, when it is `coreCar`. */
  async boardingCar(coreCar: PublicKey): Promise<CarAccount | null> {
    const c = await this.config();
    if (!c.boardingMatch.equals(coreCar) || c.nextCar === 0n) return null;
    const address = carPda(c.nextCar - 1n);
    const info = await this.base.getAccountInfo(address);
    return info ? this.decodeCar(address, info.data) : null;
  }

  private decodeCar(address: PublicKey, data: Buffer): CarAccount {
    const c: any = this.program.coder.accounts.decode("car", data);
    return { address, carNo: BigInt(c.carNo.toString()), tesoroMatch: c.tesoroMatch, table: c.table, tables: c.tables, payer: c.payer };
  }

  /**
   * Finds the ride of core car `coreCar` among the Tables: the Table whose current car it is, or whose next car it is. Null
   * when no Table has it yet (an earlier car still holds its Table).
   */
  async findRide(viewer: PlayerSigner, coreCar: PublicKey): Promise<Ride | null> {
    const n = (await this.config()).tables;
    const addresses = Array.from({ length: n }, (_, i) => tablePda(i));
    const tee = await this.teeConnection(viewer);
    const live = await tee.getMultipleAccountsInfo(addresses);
    const tables = live.map((info, i) => (info ? decodeTable(addresses[i], info.data) : null));
    const around = async (t: TableView) => {
      const [base, receipt] = await this.base.getMultipleAccountsInfo([t.address, receiptPda(t.tesoroMatch)]);
      return { baseTable: base ? decodeTable(t.address, base.data) : null, previousFrozen: t.phase === PHASE.idle || !!receipt };
    };
    for (const t of tables) {
      if (t && t.phase !== PHASE.idle && t.tesoroMatch.equals(coreCar)) {
        const info = await this.base.getAccountInfo(t.car);
        return { carNo: t.carNo, car: info ? this.decodeCar(t.car, info.data) : null, table: t, ...(await around(t)) };
      }
    }
    const nexts = tables.filter((t): t is TableView => !!t);
    const cars = await this.base.getMultipleAccountsInfo(nexts.map((t) => carPda(t.nextCar)));
    for (let i = 0; i < nexts.length; i++) {
      const info = cars[i];
      if (!info) continue;
      const car = this.decodeCar(carPda(nexts[i].nextCar), info.data);
      if (car.tesoroMatch.equals(coreCar)) return { carNo: car.carNo, car, table: nexts[i], ...(await around(nexts[i])) };
    }
    return null;
  }

  // -- instructions ---------------------------------------------------------------------------------

  private readonly pages = (car: CarView): AccountMeta[] => Array.from({ length: car.pages }, (_, p) => ({ pubkey: seatPagePda(car.address, p), isSigner: false, isWritable: true }));

  private magic() {
    return { sponsor: sponsorPda(), magicFeeVault: magicFeeVaultPda(), magicContext: MAGIC_CONTEXT, magicProgram: MAGIC_PROGRAM_ID };
  }

  checkDepartureIx(car: CarAccount): Promise<TransactionInstruction> {
    return this.program.methods
      .checkDeparture()
      .accountsPartial({ car: car.address, matchState: car.tesoroMatch, ...gameAccounts(RAILCAR_PROGRAM_ID), authority: authorityPda(), tesoroProgram: TESORO_CORE })
      .instruction();
  }

  startRideIx(payer: PublicKey, car: CarAccount, coreCar: CarView, table: TableView): Promise<TransactionInstruction> {
    return this.program.methods
      .startRide()
      .accountsPartial({ payer, table: table.address, vault: vaultPda(table.address), car: car.address, matchState: car.tesoroMatch, previousReceipt: receiptPda(table.tesoroMatch), oracleQueue: ORACLE_QUEUE })
      .remainingAccounts(this.pages(coreCar))
      .instruction();
  }

  signalIx(caller: PublicKey, table: PublicKey): Promise<TransactionInstruction> {
    return this.program.methods
      .signal()
      .accountsPartial({ caller, table, vault: vaultPda(table), ...this.magic() })
      .instruction();
  }

  commitTableIx(caller: PublicKey, table: PublicKey): Promise<TransactionInstruction> {
    return this.program.methods
      .commitTable()
      .accountsPartial({ caller, table, ...this.magic() })
      .instruction();
  }

  finalizeIx(caller: PublicKey, car: CarAccount, coreCar: CarView): Promise<TransactionInstruction> {
    return this.program.methods
      .finalize()
      .accountsPartial({
        caller,
        car: car.address,
        carPayer: car.payer,
        table: tablePda(car.table),
        matchState: car.tesoroMatch,
        ...gameAccounts(RAILCAR_PROGRAM_ID),
        authority: authorityPda(),
        receipt: receiptPda(car.tesoroMatch),
        coreEventAuthority,
        tesoroProgram: TESORO_CORE,
      })
      .remainingAccounts(this.pages(coreCar))
      .instruction();
  }

  skipCarIx(caller: PublicKey, table: TableView, carAddress: PublicKey, coreCar: PublicKey): Promise<TransactionInstruction> {
    return this.program.methods
      .skipCar()
      .accountsPartial({ caller, table: table.address, config: configPda(), car: carAddress, matchState: coreCar, receipt: receiptPda(coreCar) })
      .instruction();
  }

  closeCarIx(caller: PublicKey, car: CarAccount): Promise<TransactionInstruction> {
    return this.program.methods
      .closeCar()
      .accountsPartial({ caller, car: car.address, carPayer: car.payer, receipt: receiptPda(car.tesoroMatch), matchState: car.tesoroMatch })
      .instruction();
  }

  // -- sending ------------------------------------------------------------------------------------

  async sendBase(signer: PlayerSigner, ixs: TransactionInstruction[]): Promise<string> {
    return this.send(this.base, signer, ixs);
  }

  async sendRollup(signer: PlayerSigner, ixs: TransactionInstruction[]): Promise<string> {
    return this.send(await this.teeConnection(signer), signer, ixs);
  }

  private async send(conn: Connection, signer: PlayerSigner, ixs: TransactionInstruction[]): Promise<string> {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ...ixs);
    tx.feePayer = signer.publicKey;
    const latest = await conn.getLatestBlockhash();
    tx.recentBlockhash = latest.blockhash;
    const signed = await signer.signTransaction(tx);
    const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    const res = await conn.confirmTransaction({ signature: sig, ...latest }, "confirmed");
    if (res.value.err) throw new Error(`failed ${sig}: ${JSON.stringify(res.value.err)}`);
    return sig;
  }
}

// ---- the step an unfinished ride needs ----------------------------------------------------------------------------

/** What `nextRideStep` decides from: the core car, its ride and the rollup's slot. */
export interface RideFacts {
  coreCar: CarView;
  ride: Ride | null;
  /** The rollup's current slot. */
  slot: bigint;
  now: number;
}

export type RidePlan = { step: "check_departure" | "start_ride" | "signal" | "commit_table" | "finalize" | "refund" | "signal_then_check" } | { wait: string };

/**
 * The one step a car whose pages are gone needs, the way a page would have sent it. Pure, so the order of the rules is tested:
 * a finished ride whose result base holds is finalized before anything else; past core's refund time a ride that cannot be
 * finalized is refunded through core; otherwise the ride is moved on (started, its Impact applied, its result committed).
 */
export function nextRideStep(f: RideFacts): RidePlan {
  const { coreCar, ride, slot, now } = f;
  if (coreCar.stage === "boarding") return { step: "check_departure" };
  if (coreCar.stage !== "departed") return { wait: `the car is ${coreCar.stage}` };
  const mine = ride && ride.table.phase !== PHASE.idle && ride.table.tesoroMatch.equals(coreCar.address) ? ride.table : null;
  const base = ride?.baseTable;
  if (mine && mine.phase === PHASE.over && ride?.car && base && base.phase === PHASE.over && base.carNo === mine.carNo && base.tesoroMatch.equals(coreCar.address)) return { step: "finalize" };
  if (now >= coreCar.refundAfter) return { step: "refund" };
  if (!ride) return { wait: "an earlier car still holds the Table" };
  if (!mine) {
    if (ride.table.nextCar !== ride.carNo) return { wait: "an earlier car still holds the Table" };
    if (!ride.previousFrozen) return { wait: "the Table's previous car is not frozen yet" };
    return { step: "start_ride" };
  }
  if (mine.phase === PHASE.drawing) return slot > mine.startedSlot + BigInt(DRAW_WINDOW_SLOTS) ? { step: "signal" } : { wait: "the draw window is open" };
  if (mine.phase === PHASE.riding) return now >= mine.rideTs + RIDE_CAP_SECS ? { step: "signal" } : { step: "signal_then_check" };
  if (mine.dirty) return { step: "commit_table" };
  if (now >= mine.commitAt + COMMIT_RETRY_SECS) return { step: "commit_table" };
  return { wait: "the commit is on its way to base" };
}
