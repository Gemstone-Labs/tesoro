/**
 * On-chain client for Block Burst Live (programs/block_puzzle, code id `block_puzzle`).
 *
 * A live 1v1 Match runs on a persistent table that stays delegated to the MagicBlock private rollup (TEE). On the base
 * layer an operator binds a tesoro_core Match to one table and epoch with a write-once Assignment. Everything else happens
 * on the table in the rollup:
 *
 *   `begin_match` -> `seat_players` (each Player's Board becomes readable by that Player only) -> `check_in` x2
 *   -> `request_seed` (permissionless, the one VRF request) -> the oracle's callback -> `start` (sets the one shared clock)
 *   -> `begin` (each Player copies the Seed into their own Board) -> `play` / `play_hidden` -> `close` -> `commit_table`
 *   -> `finalize` (base layer, reads the committed table's result ring).
 *
 * Time is rollup slots (`SLOTS_PER_SEC`). `Table.startSlot` is the first slot of the run; the timer, the get-ready countdown
 * and the freeze all come from it (never from `Date.now()`): `phaseAt(table, slot)`.
 *
 * Boundary with ticket 28 (the live UI): this file is the typed client. It has one method per instruction, the decoders, the
 * pure timing helpers (`phaseAt`, `secondsLeft`, `canPlayPublic`), the packed-move codec and `rebuildRun` (Seed + move log
 * -> live state). The driver loop, the websocket feed and the RunSubmitter are ticket 28's; wiping seats, resetting tables,
 * freeing ring slots and choosing tables are ticket 19t's (this client has their instructions).
 *
 * Privacy: `readOwnBoard` works only for the Player's own Board; every other read of a hidden account returns `null`
 * (indistinguishable from "does not exist"), never an RPC error. The Vault is not readable by anyone.
 */
import { settledPda } from "../../lib/chain/basket";
import * as anchor from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID, getAuthToken, permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import { gameAccounts } from "../../lib/chain/game-record";
import { MAGICBLOCK } from "../../lib/cluster-settings";
import { baseRpc } from "../../lib/chain/rpc-config";
import { type PlayerSigner, keypairSigner } from "../holdem/chain";
import type { BlockPuzzle } from "../../lib/chain/idl/block_puzzle.types";
import * as engine from "./engine";
import { watchAccount } from "./table-feed";

export { keypairSigner, type PlayerSigner };

export const BLOCK_BURST_PROGRAM_ID = new PublicKey("5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj");
export const TESORO_CORE_PROGRAM_ID = new PublicKey("AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh");

/** The browser base-layer connection, built only when a client is made without one (the keeper and server pass theirs). */
export const defaultBaseConnection = () => new Connection(baseRpc(process.env.NEXT_PUBLIC_SOLANA_RPC), "confirmed");
export const TEE_RPC = MAGICBLOCK.teeRpc;
export const TEE_WS = MAGICBLOCK.teeWs;
export const TEE_VALIDATOR = new PublicKey(MAGICBLOCK.teeValidator);
const EPHEMERAL_VAULT = new PublicKey("MagicVau1t999999999999999999999999999999999");
const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");
const ORACLE_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");

// ---------------------------------------------------------------------------------------------
// Constants (mirror programs/block_puzzle/src/state.rs; a test keeps them equal to the IDL-visible layout)

/** Rollup slots per second (measured on devnet-tee: 99.99). */
export const SLOTS_PER_SEC = 100;
export const CHECKIN_SECS = 60;
export const SEED_SECS = 60;
export const SEED_RETRY_SECS = 20;
export const SEED_RETRY_SLOTS = SEED_RETRY_SECS * SLOTS_PER_SEC;
export const MAX_SEED_REQUESTS = 3;
export const GET_READY_SECS = 10;
export const PLAY_SECS = 90;
export const HIDE_LAST_SECS = 10;
export const GRACE_SECS = 3;
export const MAX_PLAY_BATCH = 8;
export const MOVES_PER_SEC = 4;
export const MOVE_BURST = 6;
export const TRIVIAL_MOVES = 5;
export const MAX_MOVES = engine.MAX_MOVES;
export const ENGINE_VERSION = 1;
export const RESET_DELAY_SECS = 30;
export const START_WINDOW_SECS = 300;

export const CHECKIN_SLOTS = CHECKIN_SECS * SLOTS_PER_SEC;
export const SEED_SLOTS = SEED_SECS * SLOTS_PER_SEC;
export const GET_READY_SLOTS = GET_READY_SECS * SLOTS_PER_SEC;
export const FREEZE_OFFSET_SLOTS = (PLAY_SECS - HIDE_LAST_SECS) * SLOTS_PER_SEC;
export const END_OFFSET_SLOTS = (PLAY_SECS + GRACE_SECS) * SLOTS_PER_SEC;

/**
 * The hidden beat (ticket 43). From the freeze every Player sends exactly one `play_hidden` per beat, moved or not, so what a
 * watcher of the public table, the Player's wallet and the program sees is the same rhythm for everyone. Beat `k` is due at
 * `start + FREEZE_OFFSET_SLOTS + HIDDEN_FIRST_BEAT_SLOTS + k * HIDDEN_BEAT_SLOTS`; the last one lands 0.7 s before the window
 * closes (the run itself ends 3 s before that, so no move is left behind). The public `play` stops `PUBLIC_GUARD_SLOTS` before
 * the freeze, so a `play` never reaches the program after it.
 */
export const HIDDEN_BEAT_SLOTS = 60;
export const HIDDEN_FIRST_BEAT_SLOTS = 30;
export const HIDDEN_BEATS = 21;
export const PUBLIC_GUARD_SLOTS = 30;
/** The slot beat `k` of this table is due at. */
export const hiddenBeatSlot = (t: Pick<Table, "startSlot">, k: number) => t.startSlot + FREEZE_OFFSET_SLOTS + HIDDEN_FIRST_BEAT_SLOTS + k * HIDDEN_BEAT_SLOTS;

/** `Table.phase` on chain. `getReady` covers the countdown and the run; `phaseAt` tells them apart from the slot. */
export const TABLE_PHASE = { idle: 0, assigned: 1, seeding: 2, getReady: 3, closed: 4 } as const;
/** Ring slot states and outcomes (crates/table_kit/src/ring.rs). */
export const SLOT = { free: 0, reserved: 1, done: 2 } as const;
export const OUTCOME = { none: 0, win0: 1, win1: 2, draw: 3, noShow: 4 } as const;
/** Why a Match ended the way it did (`Table.reason`). */
export const REASON = {
  none: 0,
  /** both ran; the scores (or a zero-move side) decided */
  played: 1,
  /** one Player never checked in: the other won */
  absent: 2,
  /** neither checked in: a no-show, each side pays the Platform Fee */
  neither: 3,
  /** the Seed never arrived: refund */
  noSeed: 4,
  /** the rollup stalled: refund */
  void: 5,
  /** both checked in and nobody moved: no-show */
  noShow: 6,
  /** equal scores, both under TRIVIAL_MOVES: no-show */
  trivial: 7,
  /** equal scores: draw, refund */
  draw: 8,
} as const;

const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, BLOCK_BURST_PROGRAM_ID)[0];
const tesoroPda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, TESORO_CORE_PROGRAM_ID)[0];
const u16le = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u64le = (n: number | bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

export const tesoroAccountPda = (authority: PublicKey) => tesoroPda([Buffer.from("account"), authority.toBuffer()]);
export const tesoroConfigPda = () => tesoroPda([Buffer.from("config")]);
export { settledPda };
export const eventAuthorityPda = (program: PublicKey = TESORO_CORE_PROGRAM_ID) => PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], program)[0];

export const configPda = () => pda([Buffer.from("config")]);
export const sponsorPda = () => pda([Buffer.from("sponsor")]);
export const fuelPda = (n: number) => pda([Buffer.from("fuel"), Buffer.from([n])]);
export const authorityPda = () => pda([Buffer.from("authority")]);
export const tablePda = (generation: number, index: number) => pda([Buffer.from("table"), u16le(generation), u16le(index)]);
/** The write-once binding of a tesoro_core Match (`["match", opener, n]`) to a table and epoch. */
export const assignmentPda = (match: PublicKey) => pda([Buffer.from("assign"), match.toBuffer()]);
/** A Player's hidden seat on the table (an ephemeral account only that Player can read). */
export const boardPda = (table: PublicKey, seat: 0 | 1) => pda([Buffer.from("board"), table.toBuffer(), Buffer.from([seat])]);
/** The zero-member hidden account that holds the Seed until the run starts. Nobody can read it. */
export const vaultPda = (table: PublicKey) => pda([Buffer.from("vault"), table.toBuffer()]);
/** The address the VRF callback of request number `nonce` must name. */
export const requestMarkerPda = (table: PublicKey, nonce: number | bigint) => pda([Buffer.from("vrfreq"), table.toBuffer(), u64le(nonce)]);
/** The magic fee vault of the TEE validator: the commit fee goes there. */
export const magicFeeVaultPda = () => PublicKey.findProgramAddressSync([Buffer.from("magic-fee-vault"), TEE_VALIDATOR.toBuffer()], DELEGATION_PROGRAM_ID)[0];

// ---------------------------------------------------------------------------------------------
// Moves

/** A move as the program takes it. */
export interface MoveArg {
  piece: number;
  x: number;
  y: number;
}

/** What every Player instruction names: the Match, the table generation and the epoch. */
export interface Binding {
  tesoroMatch: PublicKey;
  generation: number;
  epoch: number;
}

/** The binding of the Match the table is running (what a Player's instruction must carry). */
export const bindingOf = (t: Pick<Table, "tesoroMatch" | "generation" | "epoch">): Binding => ({ tesoroMatch: t.tesoroMatch, generation: t.generation, epoch: t.epoch });

const bindingArg = (b: Binding) => ({ tesoroMatch: b.tesoroMatch, generation: b.generation, epoch: new anchor.BN(b.epoch) });

/** The packed log byte of a move: the piece's place in its hand (2 bits), `x` (3) and `y` (3). */
export function packMove(handBase: number, m: MoveArg): number {
  return (((m.piece - handBase) & 3) << 6) | ((m.x & 7) << 3) | (m.y & 7);
}

/** The move a packed byte stands for, given the number of moves made before it. */
export function unpackMove(movesBefore: number, byte: number): MoveArg {
  const handBase = Math.floor(movesBefore / engine.HAND) * engine.HAND;
  return { piece: handBase + (byte >> 6), x: (byte >> 3) & 7, y: byte & 7 };
}

/**
 * Seed + move log -> the live state (the reconnect path): replays the packed moves with the engine. Returns the engine state
 * after them; a log that does not replay throws `EngineFailure`.
 */
export function rebuildRun(seed: bigint, log: ArrayLike<number>, count: number): engine.State {
  let st = engine.newState(seed);
  for (let i = 0; i < count; i++) st = engine.apply(st, unpackMove(i, log[i])).state;
  return st;
}

/** Slot offsets (from `startSlot`) of a seat's logged moves: two bytes little-endian each. */
export function offsetsOf(offsets: ArrayLike<number>, seat: 0 | 1, count: number): number[] {
  const base = seat * MAX_MOVES * 2;
  return Array.from({ length: count }, (_, i) => offsets[base + 2 * i] | (offsets[base + 2 * i + 1] << 8));
}

// ---------------------------------------------------------------------------------------------
// Decoded state

/** A ring slot: the result of a finished Match, kept until tesoro_core has frozen the Match. */
export interface Slot {
  state: number;
  tesoroMatch: PublicKey;
  epoch: number;
  outcome: number;
  at: number;
}

/** The moves of a finished Match, public once it is over. Seat 0's moves come first in `moves` and `offsets`. */
export interface RunLog {
  engineVersion: number;
  seed: bigint;
  seedHash: Uint8Array;
  startSlot: number;
  reason: number;
  scores: [number, number];
  counts: [number, number];
  moves: Uint8Array;
  offsets: Uint8Array;
}

/** The public table: the Match, its clock, what each seat shows, the result and the ring with its run logs. */
export interface Table {
  address: PublicKey;
  generation: number;
  index: number;
  /** Rises at every reset; a Match is bound to one epoch. */
  epoch: number;
  /** `TABLE_PHASE`. */
  phase: number;
  seatsCreated: boolean;
  seatsOpen: boolean;
  /** The result is in and has not been committed to Solana yet. */
  dirty: boolean;
  tesoroMatch: PublicKey;
  slot: number;
  startDeadline: number;
  /** seat 0 opened the tesoro_core Match, seat 1 joined */
  players: [PublicKey, PublicKey];
  checkedIn: [boolean, boolean];
  assignedSlot: number;
  assignedTs: number;
  seedingSlot: number;
  /** Number of the latest VRF request, whether one is outstanding, and how many were made for this Match. */
  reqNonce: number;
  reqPending: boolean;
  reqSlot: number;
  reqCount: number;
  /** The Seed is in the Vault (says nothing about its value). */
  seedReady: boolean;
  readySlot: number;
  /** The first slot of the run; 0 before `start`. */
  startSlot: number;
  /** Each seat's last seen score and move count: written by `play` until the freeze, then by nothing until `close`. */
  shownScore: [number, number];
  shownMoves: [number, number];
  overAt: number;
  /** `REASON`. */
  reason: number;
  /** Ring outcome of the result (`OUTCOME`), `OUTCOME.none` before `close`. */
  outcome: number;
  finalScores: [number, number];
  finalMoves: [number, number];
  ring: Slot[];
  logs: RunLog[];
}

const bigOf = (n: anchor.BN) => BigInt(n.toString());

function decodeLog(l: any): RunLog {
  return {
    engineVersion: l.engineVersion,
    seed: bigOf(l.seed),
    seedHash: Uint8Array.from(l.seedHash),
    startSlot: l.startSlot.toNumber(),
    reason: l.reason,
    scores: [l.scores[0], l.scores[1]],
    counts: [l.counts[0], l.counts[1]],
    moves: Uint8Array.from(l.moves),
    offsets: Uint8Array.from(l.offsets),
  };
}

export function decodeTable(address: PublicKey, t: any): Table {
  return {
    address,
    generation: t.generation,
    index: t.index,
    epoch: t.epoch.toNumber(),
    phase: t.phase,
    seatsCreated: t.seatsCreated,
    seatsOpen: t.seatsOpen,
    dirty: t.dirty,
    tesoroMatch: t.tesoroMatch,
    slot: t.slot,
    startDeadline: t.startDeadline.toNumber(),
    players: [t.players[0], t.players[1]],
    checkedIn: [t.checkedIn[0], t.checkedIn[1]],
    assignedSlot: t.assignedSlot.toNumber(),
    assignedTs: t.assignedTs.toNumber(),
    seedingSlot: t.seedingSlot.toNumber(),
    reqNonce: t.reqNonce.toNumber(),
    reqPending: t.reqPending,
    reqSlot: t.reqSlot.toNumber(),
    reqCount: t.reqCount,
    seedReady: t.seedReady,
    readySlot: t.readySlot.toNumber(),
    startSlot: t.startSlot.toNumber(),
    shownScore: [t.shownScore[0], t.shownScore[1]],
    shownMoves: [t.shownMoves[0], t.shownMoves[1]],
    overAt: t.overAt.toNumber(),
    reason: t.reason,
    outcome: t.outcome,
    finalScores: [t.finalScores[0], t.finalScores[1]],
    finalMoves: [t.finalMoves[0], t.finalMoves[1]],
    ring: (t.ring.slots as any[]).map((x) => ({ state: x.state, tesoroMatch: x.matchKey, epoch: x.epoch.toNumber(), outcome: x.outcome, at: x.at.toNumber() })),
    logs: (t.logs as any[]).map(decodeLog),
  };
}

export interface Assignment {
  address: PublicKey;
  tesoroMatch: PublicKey;
  generation: number;
  index: number;
  epoch: number;
  players: [PublicKey, PublicKey];
  startDeadline: number;
  payer: PublicKey;
}

/** What most table instructions need of an Assignment: which table. */
export type TableRef = Pick<Assignment, "generation" | "index">;

export function decodeAssignment(address: PublicKey, a: any): Assignment {
  return {
    address,
    tesoroMatch: a.tesoroMatch,
    generation: a.generation,
    index: a.index,
    epoch: a.epoch.toNumber(),
    players: a.players,
    startDeadline: a.startDeadline.toNumber(),
    payer: a.payer,
  };
}

/** A Player's own run, from their hidden Board. */
export interface OwnBoard {
  seat: 0 | 1;
  player: PublicKey;
  tesoroMatch: PublicKey;
  epoch: number;
  began: boolean;
  seed: bigint;
  occ: bigint;
  gems: bigint;
  score: number;
  moves: number;
  used: number;
  over: boolean;
  /** Packed moves; the first `moves` bytes are the log. */
  log: Uint8Array;
  /** Slot offsets of the moves, two bytes little-endian each. */
  offsets: Uint8Array;
}

export function decodeBoard(b: any): OwnBoard {
  return {
    seat: b.seat,
    player: b.player,
    tesoroMatch: b.tesoroMatch,
    epoch: b.epoch.toNumber(),
    began: b.began,
    seed: bigOf(b.seed),
    occ: bigOf(b.occ),
    gems: bigOf(b.gems),
    score: b.score,
    moves: b.moves,
    used: b.used,
    over: b.over,
    log: Uint8Array.from(b.log),
    offsets: Uint8Array.from(b.offsets),
  };
}

/** The engine state of a Board: enough to draw it, to continue the run, and to cross-check a rebuild. */
export const engineStateOf = (b: OwnBoard): engine.State => ({ seed: b.seed, occ: b.occ, gems: b.gems, score: b.score, moves: b.moves, used: b.used, over: b.over });

/** The ring slot of a Match, if the table still holds one. */
export const slotOf = (t: Table, match: PublicKey, epoch: number): Slot | null => t.ring.find((s) => s.state !== SLOT.free && s.epoch === epoch && s.tesoroMatch.equals(match)) ?? null;

/** The run log kept for a Match's ring slot (scores, moves and slot offsets of both Players), or `null`. */
export function runLogOf(t: Table, match: PublicKey, epoch: number): RunLog | null {
  const i = t.ring.findIndex((s) => s.state === SLOT.done && s.epoch === epoch && s.tesoroMatch.equals(match));
  return i < 0 ? null : t.logs[i];
}

/**
 * Whether base's copy of the table can settle the Match: its ring holds the Match's result, or the table has moved past the
 * Match's epoch without ever running it (a refund, once the start deadline has passed). Mirrors `finalize` on chain.
 */
export function canFinalizeTable(base: Table, a: Assignment, nowS: number): boolean {
  const slot = slotOf(base, a.tesoroMatch, a.epoch);
  if (slot) return slot.state === SLOT.done;
  return base.epoch > a.epoch && nowS > a.startDeadline;
}

/** The table's state that belongs to the Assignment: the table itself when it runs the Match, `null` once it moved on. */
export function tableOf(a: Assignment, t: Table): Table | null {
  return t.epoch === a.epoch && t.tesoroMatch.equals(a.tesoroMatch) ? t : null;
}

// ---------------------------------------------------------------------------------------------
// Time: everything the screen shows about the clock comes from the table and the rollup's slot

/** Where a Match is on the clock. `running`, `frozen` and `grace` are all parts of the run. */
export type LivePhase = "idle" | "checkIn" | "seeding" | "getReady" | "running" | "frozen" | "grace" | "ended" | "closed";

/**
 * The phase at rollup slot `slot`. The table's `phase` says what the program recorded; the slot says what the clock does
 * since: a Match whose window passed is `ended` until someone sends `close`.
 */
export function phaseAt(t: Table, slot: number): LivePhase {
  if (t.phase === TABLE_PHASE.idle) return "idle";
  if (t.phase === TABLE_PHASE.closed) return "closed";
  if (t.phase === TABLE_PHASE.assigned) return slot > t.assignedSlot + CHECKIN_SLOTS ? "ended" : "checkIn";
  if (t.phase === TABLE_PHASE.seeding) return slot > t.seedingSlot + SEED_SLOTS ? "ended" : "seeding";
  if (slot < t.startSlot) return "getReady";
  if (slot < t.startSlot + FREEZE_OFFSET_SLOTS) return "running";
  if (slot < t.startSlot + PLAY_SECS * SLOTS_PER_SEC) return "frozen";
  if (slot <= t.startSlot + END_OFFSET_SLOTS) return "grace";
  return "ended";
}

/** Seconds until the run starts (0 once it has). */
export const secondsToStart = (t: Table, slot: number) => (t.startSlot ? Math.max(0, (t.startSlot - slot) / SLOTS_PER_SEC) : null);

/** Seconds of the 90 s run left (clamped to 0..90). */
export function secondsLeft(t: Table, slot: number): number | null {
  if (!t.startSlot) return null;
  return Math.min(PLAY_SECS, Math.max(0, (t.startSlot + PLAY_SECS * SLOTS_PER_SEC - slot) / SLOTS_PER_SEC));
}

/** A `play` that writes the public score is allowed before the freeze; from it only `play_hidden` is. */
export const canPlayPublic = (t: Table, slot: number) => t.startSlot > 0 && slot < t.startSlot + FREEZE_OFFSET_SLOTS;

/** The scores are hidden for both Players from the freeze until the result: the UI shows "?" for the opponent. */
export const scoresHidden = (t: Table, slot: number) => {
  const p = phaseAt(t, slot);
  return p === "frozen" || p === "grace" || (p === "ended" && t.phase !== TABLE_PHASE.closed);
};

/**
 * How many moves a batch landing at `slot` may bring the Player to, given the pace: 4 a second plus a burst of 6. The client
 * keeps below it so a held-back batch is never refused for speed.
 */
export const paceLimit = (t: Table, slot: number) => Math.floor((MOVES_PER_SEC * Math.max(0, slot - t.startSlot)) / SLOTS_PER_SEC) + MOVE_BURST;

// ---------------------------------------------------------------------------------------------
// Client

export interface BlockBurstChainOptions {
  base?: Connection;
  teeRpc?: string;
  teeWs?: string;
  /** Called once per confirmed step; useful for evidence logs. */
  onTx?: (step: string, layer: "base" | "tee", signature: string) => void;
}

/** The fixed-size move list of a hidden beat: the real moves, then padding the program ignores. */
export const hiddenMoves = (moves: MoveArg[]): MoveArg[] => {
  if (moves.length > MAX_PLAY_BATCH) throw new Error(`A batch holds at most ${MAX_PLAY_BATCH} moves`);
  return Array.from({ length: MAX_PLAY_BATCH }, (_, i) => moves[i] ?? { piece: 0, x: 0, y: 0 });
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Transient RPC failures (rate limits, dropped sockets) are common on public devnet. */
async function withRetry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries - 1) throw e;
      await sleep(750 * (i + 1));
    }
  }
}

export class BlockBurstChain {
  readonly base: Connection;
  /** Typed from the generated IDL: a call to an instruction the program no longer has is a compile error. */
  readonly program: anchor.Program<BlockPuzzle>;
  readonly tesoro: anchor.Program<any>;
  private readonly teeRpc: string;
  private readonly teeWs: string;
  private readonly tee = new Map<string, Connection>();
  /** Step logger; a UI may replace it while it is mounted. */
  onTx?: BlockBurstChainOptions["onTx"];

  constructor(blockBurstIdl: BlockPuzzle, tesoroIdl: any, opts: BlockBurstChainOptions = {}) {
    this.base = opts.base ?? defaultBaseConnection();
    this.teeRpc = opts.teeRpc ?? TEE_RPC;
    this.teeWs = opts.teeWs ?? TEE_WS;
    this.onTx = opts.onTx;
    const provider = new anchor.AnchorProvider(
      this.base,
      // Read-only provider (anchor's Node `Wallet` is not in the browser build): transactions are
      // built here and signed by the caller's signer.
      {
        publicKey: Keypair.generate().publicKey,
        signTransaction: async (t: any) => t,
        signAllTransactions: async (t: any) => t,
      },
      { commitment: "confirmed" },
    );
    this.program = new anchor.Program(blockBurstIdl, provider);
    this.tesoro = new anchor.Program(tesoroIdl, provider);
  }

  /** A TEE connection authenticated as `signer` (one per Player; tokens are per key). */
  async teeConnection(signer: PlayerSigner): Promise<Connection> {
    const key = signer.publicKey.toBase58();
    const cached = this.tee.get(key);
    if (cached) return cached;
    const { token } = await withRetry(() => getAuthToken(this.teeRpc, signer.publicKey, (m: Uint8Array) => signer.signMessage(m)));
    const conn = new Connection(`${this.teeRpc}?token=${token}`, { wsEndpoint: `${this.teeWs}?token=${token}`, commitment: "confirmed" });
    this.tee.set(key, conn);
    return conn;
  }

  /** The rollup's current slot, through a Player's (or the keeper's) token. All the clocks above are measured against it. */
  async currentSlot(viewer: PlayerSigner): Promise<number> {
    return (await this.teeConnection(viewer)).getSlot("confirmed");
  }

  // -- sending -------------------------------------------------------------------------------

  private async sendBase(step: string, ixs: TransactionInstruction[], signers: PlayerSigner[]): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const tx = new Transaction().add(...ixs);
      tx.feePayer = signers[0].publicKey;
      const latest = await withRetry(() => this.base.getLatestBlockhash());
      tx.recentBlockhash = latest.blockhash;
      let signed = tx;
      for (const s of signers) signed = await s.signTransaction(signed);
      const sig = await this.base.sendRawTransaction(signed.serialize(), { skipPreflight: true });
      try {
        const res = await this.base.confirmTransaction({ signature: sig, ...latest }, "confirmed");
        if (res.value.err) {
          const t = await this.base.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
          throw new Error(`${step} failed ${sig}: ${JSON.stringify(res.value.err)}\n${t?.meta?.logMessages?.join("\n")}`);
        }
      } catch (e: any) {
        // A dropped transaction (blockhash expired before landing) is safe to rebuild and resend.
        if (attempt < 2 && String(e?.name).includes("TransactionExpiredBlockheightExceeded")) continue;
        throw e;
      }
      this.onTx?.(step, "base", sig);
      return sig;
    }
  }

  private async sendTee(step: string, ixs: TransactionInstruction[], signer: PlayerSigner): Promise<string> {
    const conn = await this.teeConnection(signer);
    const tx = new Transaction().add(...ixs);
    tx.feePayer = signer.publicKey;
    tx.recentBlockhash = (await withRetry(() => conn.getLatestBlockhash())).blockhash;
    const signed = await signer.signTransaction(tx);
    const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
    for (let i = 0; i < 60; i++) {
      const st = (await conn.getSignatureStatuses([sig])).value[0];
      if (st) {
        if (st.err) {
          const t = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
          throw new Error(`${step} failed ${sig}: ${JSON.stringify(st.err)}\n${t?.meta?.logMessages?.join("\n") ?? ""}`);
        }
        this.onTx?.(step, "tee", sig);
        return sig;
      }
      await sleep(250);
    }
    throw new Error(`${step} not confirmed ${sig}`);
  }

  // -- reads: the Assignment (base) and the table (rollup, or base once committed) ----------------

  private readonly assignments = new Map<string, Assignment>();

  /** The Match's Assignment on the base layer (it never changes once written), or `null` while the operator has not made it. */
  async readAssignment(match: PublicKey): Promise<Assignment | null> {
    const key = match.toBase58();
    const known = this.assignments.get(key);
    if (known) return known;
    const address = assignmentPda(match);
    const info = await this.base.getAccountInfo(address);
    if (!info || !info.owner.equals(BLOCK_BURST_PROGRAM_ID)) return null;
    const a = decodeAssignment(address, this.program.coder.accounts.decode("assignment", info.data));
    this.assignments.set(key, a);
    return a;
  }

  async readTesoroMatch(match: PublicKey): Promise<any | null> {
    const info = await this.base.getAccountInfo(match);
    return info ? this.tesoro.coder.accounts.decode("matchState", info.data) : null;
  }

  /** A tesoro_core Match that can still be settled (Active); false once settled, refunded or gone. */
  private isLive(tesoroMatch: any | null): boolean {
    return !!tesoroMatch && "active" in tesoroMatch.inner.stage;
  }

  /** The table in the rollup, through a Player's (or the keeper's) token; the table itself is public. */
  async readTable(viewer: PlayerSigner, a: TableRef): Promise<Table | null> {
    const address = tablePda(a.generation, a.index);
    const conn = await this.teeConnection(viewer);
    const info = await conn.getAccountInfo(address).catch(() => null);
    if (!info || (!info.owner.equals(DELEGATION_PROGRAM_ID) && !info.owner.equals(BLOCK_BURST_PROGRAM_ID))) return null;
    return decodeTable(address, this.program.coder.accounts.decode("table", info.data));
  }

  /**
   * Follows the table through the Player's token: the websocket pushes each change and a read fills any silence (the table is
   * silent by design from the freeze). Returns the stop function.
   */
  async watchTable(viewer: PlayerSigner, a: TableRef, onTable: (t: Table) => void, onError?: (e: unknown) => void): Promise<() => void> {
    const address = tablePda(a.generation, a.index);
    const conn = await this.teeConnection(viewer);
    return watchAccount<Table>({
      conn,
      address,
      decode: (info) => (info.owner.equals(DELEGATION_PROGRAM_ID) || info.owner.equals(BLOCK_BURST_PROGRAM_ID) ? decodeTable(address, this.program.coder.accounts.decode("table", info.data)) : null),
      onValue: onTable,
      onError,
    });
  }

  /** The table as the base layer last saw it (what the last commit left): the result ring `finalize` reads, and the run logs. */
  async readTableOnBase(a: TableRef): Promise<Table | null> {
    const address = tablePda(a.generation, a.index);
    const info = await this.base.getAccountInfo(address);
    if (!info || (!info.owner.equals(DELEGATION_PROGRAM_ID) && !info.owner.equals(BLOCK_BURST_PROGRAM_ID))) return null;
    return decodeTable(address, this.program.coder.accounts.decode("table", info.data));
  }

  /**
   * Your own Board through your TEE token: the run so far (the Seed from `begin`, the board, the true score, the move log), or
   * `null` before you were seated and for anything you may not read. This is the reconnect read: `rebuildRun(seed, log, moves)`.
   */
  async readOwnBoard(player: PlayerSigner, a: TableRef, seat: 0 | 1): Promise<OwnBoard | null> {
    const address = boardPda(tablePda(a.generation, a.index), seat);
    const conn = await this.teeConnection(player);
    const info = await conn.getAccountInfo(address).catch(() => null);
    if (!info || !info.owner.equals(BLOCK_BURST_PROGRAM_ID)) return null;
    const board = decodeBoard(this.program.coder.accounts.decode("board", info.data));
    return board.player.equals(player.publicKey) ? board : null;
  }

  /** Seat of `wallet` at this table, or -1. */
  static seatOf(table: Pick<Table, "players">, wallet: PublicKey): number {
    return table.players.findIndex((p) => p.equals(wallet));
  }

  // -- base layer ----------------------------------------------------------------------------

  /**
   * Base layer, operator only (the table scheduler, ticket 19t). Binds an Active tesoro_core Match to `generation`/`index` at
   * the table's current `epoch`, once. The Players are copied from the Match. Refused (`BudgetTooShort`) when the core
   * deadline leaves no room for every phase.
   */
  async assignMatch(operator: PlayerSigner, match: PublicKey, seatA: PublicKey, seatB: PublicKey, generation: number, index: number, epoch: number): Promise<string> {
    const ix = await this.program.methods
      .assignMatch(generation, index, new anchor.BN(epoch))
      .accountsPartial({
        operator: operator.publicKey,
        config: configPda(),
        tesoroMatch: match,
        accountA: tesoroAccountPda(seatA),
        accountB: tesoroAccountPda(seatB),
        authority: authorityPda(),
        assignment: assignmentPda(match),
        tesoroProgram: TESORO_CORE_PROGRAM_ID,
      } as any)
      .instruction();
    return this.sendBase("assign_match", [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ix], [operator]);
  }

  /**
   * Base layer, permissionless. Settles (or, for a refund, a no-start or a table that moved past the Match, refunds) the
   * tesoro_core Match from the result in the committed table's ring, by CPI as the Game authority PDA. Returns "" when it is
   * already settled. Fails with `NoResult` / `MatchNotOver` until the commit has landed.
   */
  /** The finalize instruction with `caller` paying the receipt's rent (the relayer, or the Player's wallet); null when the Match is already settled. */
  async finalizeIx(caller: PublicKey, a: Assignment): Promise<TransactionInstruction | null> {
    if (!this.isLive(await this.readTesoroMatch(a.tesoroMatch))) return null;
    return this.program.methods
      .finalize()
      .accountsPartial({
        caller,
        assignment: a.address,
        table: tablePda(a.generation, a.index),
        tesoroMatch: a.tesoroMatch,
        config: tesoroConfigPda(),
        ...gameAccounts(BLOCK_BURST_PROGRAM_ID),
        authority: authorityPda(),
        receipt: settledPda(a.tesoroMatch),
        coreEventAuthority: eventAuthorityPda(),
        tesoroProgram: TESORO_CORE_PROGRAM_ID,
        eventAuthority: eventAuthorityPda(BLOCK_BURST_PROGRAM_ID),
        program: BLOCK_BURST_PROGRAM_ID,
      } as any)
      .instruction();
  }

  async finalize(payer: PlayerSigner, a: Assignment): Promise<string> {
    const ix = await this.finalizeIx(payer.publicKey, a);
    if (!ix) return "";
    return this.sendBase("finalize", [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix], [payer]);
  }

  /**
   * Base layer, permissionless. Refunds a joined Match that no table was ever assigned to, once it has waited
   * `TABLE_WAIT_SECS` (5 minutes) for one. Refused while an Assignment exists for the Match.
   */
  async refundUntabled(payer: PlayerSigner, tesoroMatch: PublicKey): Promise<string> {
    const ix = await this.program.methods
      .refundUntabled()
      .accountsPartial({
        caller: payer.publicKey,
        assignment: assignmentPda(tesoroMatch),
        tesoroMatch,
        ...gameAccounts(BLOCK_BURST_PROGRAM_ID),
        authority: authorityPda(),
        receipt: settledPda(tesoroMatch),
        coreEventAuthority: eventAuthorityPda(),
        tesoroProgram: TESORO_CORE_PROGRAM_ID,
        eventAuthority: eventAuthorityPda(BLOCK_BURST_PROGRAM_ID),
        program: BLOCK_BURST_PROGRAM_ID,
      } as any)
      .instruction();
    return this.sendBase("refund_untabled", [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix], [payer]);
  }

  /**
   * Rollup, permissionless. Gives up an Assignment whose Match never began (its table is Idle at the Assignment's epoch and the
   * start window passed): writes a Draw into the ring so `finalize` refunds the Match once the table is committed.
   */
  async skipEpoch(caller: PlayerSigner, a: Assignment): Promise<string> {
    const ix = await this.program.methods
      .skipEpoch()
      .accountsPartial({ caller: caller.publicKey, assignment: a.address, table: tablePda(a.generation, a.index) } as any)
      .instruction();
    return this.sendTee("skip_epoch", [ix], caller);
  }

  /** Base layer, permissionless. Closes the Assignment once tesoro_core has frozen the Match (needs its settlement receipt); the rent goes back to the operator. */
  async closeAssignment(payer: PlayerSigner, a: Assignment): Promise<string> {
    const ix = await this.program.methods
      .closeAssignment()
      .accountsPartial({ caller: payer.publicKey, assignment: a.address, payer: a.payer, receipt: settledPda(a.tesoroMatch), matchState: a.tesoroMatch } as any)
      .instruction();
    return this.sendBase("close_assignment", [ix], [payer]);
  }

  // -- rollup: seats and starting -------------------------------------------------------------

  private seatAccounts(caller: PublicKey, a: TableRef) {
    const table = tablePda(a.generation, a.index);
    const b0 = boardPda(table, 0);
    const b1 = boardPda(table, 1);
    const v = vaultPda(table);
    return {
      caller,
      table,
      board0: b0,
      board1: b1,
      seedVault: v,
      board0Permission: permissionPdaFromAccount(b0),
      board1Permission: permissionPdaFromAccount(b1),
      seedVaultPermission: permissionPdaFromAccount(v),
      permissionProgram: PERMISSION_PROGRAM_ID,
      ephemeralVault: EPHEMERAL_VAULT,
      magicProgram: MAGIC_PROGRAM_ID,
    } as any;
  }

  /** Rollup, permissionless, once per table (the operator's setup). Creates the two Boards and the Vault, private to nobody until a Match is begun. */
  async initSeats(payer: PlayerSigner, a: TableRef): Promise<string> {
    const ix = await this.program.methods.initSeats().accountsPartial(this.seatAccounts(payer.publicKey, a)).instruction();
    return this.sendTee("init_seats", [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ix], payer);
  }

  /** Rollup, permissionless. Starts the Assignment's Match on its table (reserves a ring slot); the seats are then handed over and the Players check in. */
  async beginMatch(payer: PlayerSigner, a: Assignment): Promise<string> {
    const ix = await this.program.methods
      .beginMatch()
      .accountsPartial({ caller: payer.publicKey, assignment: a.address, table: tablePda(a.generation, a.index), tesoroMatch: a.tesoroMatch } as any)
      .instruction();
    return this.sendTee("begin_match", [ix], payer);
  }

  /** Rollup, permissionless. Hands each Board to its Player (the seat becomes readable by that Player only). */
  async seatPlayers(payer: PlayerSigner, a: TableRef): Promise<string> {
    const ix = await this.program.methods.seatPlayers().accountsPartial(this.seatAccounts(payer.publicKey, a)).instruction();
    return this.sendTee("seat_players", [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ix], payer);
  }

  /** Rollup. You are here (attendance only). A Player who does not check in within 60 s loses the Match. */
  async checkIn(player: PlayerSigner, table: Pick<Table, "tesoroMatch" | "generation" | "epoch" | "index">): Promise<string> {
    const ix = await this.program.methods
      .checkIn(bindingArg(bindingOf(table)))
      .accountsPartial({ player: player.publicKey, table: tablePda(table.generation, table.index) } as any)
      .instruction();
    return this.sendTee("check_in", [ix], player);
  }

  /** Rollup, permissionless. After both checked in: the one VRF request for the Seed. Retried by the program's rules (every 20 s, at most 3), never extends the window. */
  async requestSeed(payer: PlayerSigner, a: TableRef): Promise<string> {
    const table = tablePda(a.generation, a.index);
    const ix = await this.program.methods
      .requestSeed()
      .accountsPartial({ payer: payer.publicKey, table, seedVault: vaultPda(table), oracleQueue: ORACLE_QUEUE } as any)
      .instruction();
    return this.sendTee("request_seed", [ix], payer);
  }

  /** Rollup, permissionless. Once the Seed is in: sets the shared clock; the run begins 10 s from now. */
  async start(payer: PlayerSigner, a: TableRef): Promise<string> {
    const ix = await this.program.methods.start().accountsPartial({ caller: payer.publicKey, table: tablePda(a.generation, a.index) } as any).instruction();
    return this.sendTee("start", [ix], payer);
  }

  // -- rollup: playing -----------------------------------------------------------------------

  /** Rollup. The first instruction once the run has started: copies the Seed into your own Board (nothing public is written). */
  async begin(player: PlayerSigner, table: Pick<Table, "tesoroMatch" | "generation" | "epoch" | "index">, seat: 0 | 1): Promise<string> {
    const t = tablePda(table.generation, table.index);
    const ix = await this.program.methods
      .begin(bindingArg(bindingOf(table)))
      .accountsPartial({ player: player.publicKey, table: t, seedVault: vaultPda(t), board: boardPda(t, seat) } as any)
      .instruction();
    return this.sendTee("begin", [ix], player);
  }

  /**
   * Rollup. 1 to 8 moves (0 to 8 in a hidden beat, which pads to a fixed size and carries `beat`, the beat's number, only so
   * its bytes differ from the last beat's). `expectedCount` is your move count on chain before this batch (a resent batch is then refused as
   * `WrongCount` and changes nothing). `hidden` sends `play_hidden`, which touches nothing public: required from the freeze
   * (`canPlayPublic(table, slot)` is false), allowed before it. A `play` that lands after the freeze fails with `Frozen`:
   * resend it hidden.
   */
  async play(player: PlayerSigner, table: Pick<Table, "tesoroMatch" | "generation" | "epoch" | "index">, seat: 0 | 1, expectedCount: number, moves: MoveArg[], hidden: boolean, beat = 0): Promise<string> {
    const t = tablePda(table.generation, table.index);
    const accounts = { player: player.publicKey, table: t, board: boardPda(t, seat) } as any;
    const binding = bindingArg(bindingOf(table));
    const ix = hidden
      ? await this.program.methods.playHidden(binding, expectedCount, beat & 0xff, moves.length, hiddenMoves(moves)).accountsPartial(accounts).instruction()
      : await this.program.methods.play(binding, expectedCount, moves).accountsPartial(accounts).instruction();
    return this.sendTee(hidden ? "play_hidden" : "play", [ix], player);
  }

  /** Rollup, permissionless. Ends the Match once its window is over (or both runs are over) and writes the result and both run logs into the ring. */
  async close(payer: PlayerSigner, a: TableRef): Promise<string> {
    const table = tablePda(a.generation, a.index);
    const ix = await this.program.methods
      .close()
      .accountsPartial({ caller: payer.publicKey, table, board0: boardPda(table, 0), board1: boardPda(table, 1) } as any)
      .instruction();
    return this.sendTee("close", [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix], payer);
  }

  // -- rollup: after the Match ---------------------------------------------------------------

  /** Rollup, permissionless, once per result (the table is `dirty` until then). Commits the public table to Solana, paid by the Sponsor. */
  async commitTable(payer: PlayerSigner, a: TableRef): Promise<string> {
    const ix = await this.program.methods
      .commitTable()
      .accountsPartial({
        caller: payer.publicKey,
        table: tablePda(a.generation, a.index),
        sponsor: sponsorPda(),
        magicFeeVault: magicFeeVaultPda(),
        magicContext: MAGIC_CONTEXT,
        magicProgram: MAGIC_PROGRAM_ID,
      } as any)
      .instruction();
    return this.sendTee("commit_table", [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix], payer);
  }

  /** Rollup, permissionless, table scheduler (19t). Once the Match is over: zeroes both Boards and the Vault and swaps the Boards' permission members to nobody. */
  async wipeSeats(payer: PlayerSigner, a: TableRef): Promise<string> {
    const ix = await this.program.methods.wipeSeats().accountsPartial(this.seatAccounts(payer.publicKey, a)).instruction();
    return this.sendTee("wipe_seats", [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ix], payer);
  }

  /** Rollup, permissionless, table scheduler (19t). Wipes a finished, committed table with wiped seats and moves it to the next epoch. */
  async resetTable(payer: PlayerSigner, table: PublicKey): Promise<string> {
    const ix = await this.program.methods.resetTable().accountsPartial({ caller: payer.publicKey, table } as any).instruction();
    return this.sendTee("reset_table", [ix], payer);
  }

  /** Rollup, permissionless, table scheduler (19t). Frees a Done ring slot once tesoro_core's settlement receipt for its Match is 60 s old. */
  async releaseSlot(payer: PlayerSigner, table: PublicKey, index: number, match: PublicKey): Promise<string> {
    const ix = await this.program.methods
      .releaseSlot(index)
      .accountsPartial({ caller: payer.publicKey, table, receipt: settledPda(match), matchState: match } as any)
      .instruction();
    return this.sendTee("release_slot", [ix], payer);
  }

  /** Rollup, permissionless, table scheduler (19t). Gives up the table's unfinished Match once tesoro_core has refunded it. */
  async voidTable(payer: PlayerSigner, table: PublicKey, match: PublicKey): Promise<string> {
    const ix = await this.program.methods
      .voidTable()
      .accountsPartial({ caller: payer.publicKey, table, receipt: settledPda(match), matchState: match } as any)
      .instruction();
    return this.sendTee("void_table", [ix], payer);
  }

  /** Rollup, operator (19t). Moves lamports from a Fuel reserve into the Sponsor. */
  async refillSponsor(operator: PlayerSigner, fuel: number, amount: bigint): Promise<string> {
    const ix = await this.program.methods
      .refillSponsor(new anchor.BN(amount.toString()))
      .accountsPartial({ operator: operator.publicKey, config: configPda(), fuel: fuelPda(fuel), sponsor: sponsorPda() } as any)
      .instruction();
    return this.sendTee("refill_sponsor", [ix], operator);
  }
}
