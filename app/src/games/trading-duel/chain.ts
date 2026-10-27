/**
 * On-chain client for the Trading Duel Game (programs/trading_duel).
 *
 * Matches run on persistent tables that stay delegated to the MagicBlock private rollup (TEE). On
 * the base layer an operator binds a tesoro_core Match to one table and epoch with a write-once
 * Assignment; everything else happens on the table in the rollup: `begin_match`, `open_seats`
 * (each Player's Book is an ephemeral account only that Player can read), `check_in` (the second
 * one starts the Match), picks, ticks, `end_match`, then `commit_table`. `finalize` runs on the
 * base layer and reads the committed table's result ring. Closing the seats, resetting the table,
 * freeing ring slots and choosing tables belong to the keeper's table scheduler (ticket 19t); this
 * client has the instructions for it (`closeSeats`, `resetTable`, `releaseSlot`, `voidTable`,
 * `closeAssignment`, `assignMatch`, `refillSponsor`).
 *
 * Shares the Player signer, payout maths and tesoro_core PDAs with the Hold'em client.
 */
import type { TradingDuel } from "../../lib/chain/idl/trading_duel.types";
import * as anchor from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  getAuthToken,
  permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  defaultBaseConnection,
  TEE_RPC,
  TEE_VALIDATOR,
  TEE_WS,
  TESORO_CORE_PROGRAM_ID,
  tesoroAccountPda,
  tesoroConfigPda,
  settledPda,
  eventAuthorityPda,
  type PlayerSigner,
} from "../holdem/chain";
import { MAGICBLOCK } from "../../lib/cluster-settings";
import { COLUMNS, type Track } from "./grid";
import { gameAccounts } from "../../lib/chain/game-record";

export { keypairSigner, type PlayerSigner } from "../holdem/chain";

export const TRADING_DUEL_PROGRAM_ID = new PublicKey("CNETsX9Gc78iApRNiGyAtiERKiHeD1yhHS8MwrfBAYyj");
const EPHEMERAL_VAULT = new PublicKey("MagicVau1t999999999999999999999999999999999");
const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");

/** Public rollup RPC / WebSocket for the price feeds (the same accounts live on the TEE). */
export const ER_RPC = MAGICBLOCK.erRpc;
export const ER_WS = MAGICBLOCK.erWs;

/**
 * What the screens call a Duel's status: `created` while the Match waits to start (the table is
 * Idle or Waiting for check-ins), `live` while the grid runs, `over` with a result, `cancelled`
 * when it never started (nobody checked in in time).
 */
export const STATUS = { created: 0, live: 1, over: 2, cancelled: 3 } as const;
/** `Table.phase` on chain. */
export const PHASE = { idle: 0, waiting: 1, live: 2, over: 3 } as const;
/** Ring slot states and outcomes (crates/table_kit/src/ring.rs). */
export const SLOT = { free: 0, reserved: 1, done: 2 } as const;
export const OUTCOME = { none: 0, win0: 1, win1: 2, draw: 3, noShow: 4 } as const;
export const NO_WINNER = 255;
export const DRAW = 2;

/** Rules the app needs beyond grid.ts, mirrored from programs/trading_duel/src/state.rs. */
export const RULES = {
  maxStaleSecs: 2,
  /** An end-of-window price must be published within this many seconds after the window closes. */
  endGraceSecs: 4,
} as const;

export interface Asset {
  id: 0 | 1 | 2;
  symbol: "SOL" | "ETH" | "HYPE";
  name: string;
  feed: PublicKey;
}

/** Feeds verified live on the devnet and mainnet rollups and TEEs (addresses are the same; see MagicBlockSettings.priceFeeds). */
export const ASSETS: Asset[] = [
  { id: 0, symbol: "SOL", name: "Solana", feed: new PublicKey(MAGICBLOCK.priceFeeds.SOL) },
  { id: 1, symbol: "ETH", name: "Ethereum", feed: new PublicKey(MAGICBLOCK.priceFeeds.ETH) },
  { id: 2, symbol: "HYPE", name: "Hyperliquid", feed: new PublicKey(MAGICBLOCK.priceFeeds.HYPE) },
];

/** The asset a Match trades: `meta.asset` of its tesoro_core MatchState. */
export const assetOfIndex = (index: number): Asset | null => ASSETS[index] ?? null;

const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, TRADING_DUEL_PROGRAM_ID)[0];
const u16le = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};

export const configPda = () => pda([Buffer.from("config")]);
export const sponsorPda = () => pda([Buffer.from("sponsor")]);
export const fuelPda = (n: number) => pda([Buffer.from("fuel"), Buffer.from([n])]);
export const authorityPda = () => pda([Buffer.from("authority")]);
export const tablePda = (generation: number, index: number) => pda([Buffer.from("table"), u16le(generation), u16le(index)]);
/** The write-once binding of a tesoro_core Match (`["match", opener, n]`) to a table and epoch. */
export const assignmentPda = (match: PublicKey) => pda([Buffer.from("assign"), match.toBuffer()]);
export const bookPda = (table: PublicKey, seat: 0 | 1) => pda([Buffer.from("book"), table.toBuffer(), Buffer.from([seat])]);
/** The magic fee vault of the TEE validator: the commit fee goes there. */
export const magicFeeVaultPda = () => PublicKey.findProgramAddressSync([Buffer.from("magic-fee-vault"), TEE_VALIDATOR.toBuffer()], DELEGATION_PROGRAM_ID)[0];

export interface Addresses {
  assignment: PublicKey;
  table: PublicKey;
  book0: PublicKey;
  book1: PublicKey;
  authority: PublicKey;
}

/** PDAs of one Match once its Assignment is known (which says the table). */
export function addresses(match: PublicKey, table: PublicKey): Addresses {
  return { assignment: assignmentPda(match), table, book0: bookPda(table, 0), book1: bookPda(table, 1), authority: authorityPda() };
}

// ---------------------------------------------------------------------------------------------
// Decoded state

const big = (n: anchor.BN) => BigInt(n.toString());

/** What a Match shows on the screens, read from its table (the Match's turn on a persistent table). */
export interface Duel {
  /** The table the Match runs on. */
  address: PublicKey;
  /** The table epoch the Match ran in. */
  epoch: number;
  /** The table is waiting for the second Player's check-in: who has checked in. */
  checkedIn: [boolean, boolean];
  /** Both seats exist (the Books were created). */
  seatsOpen: boolean;
  /** The result is in and has not been committed to Solana yet. */
  dirty: boolean;
  tesoroMatch: PublicKey;
  /** seat 0 opened the tesoro_core Match, seat 1 joined */
  players: [PublicKey, PublicKey];
  asset: Asset;
  status: number;
  /** 0 / 1 = winning seat, `DRAW`, `NO_WINNER` until over */
  winner: number;
  startDeadline: number;
  /** Unix seconds (rollup clock): the Match starts, the line enters column 1, the Match ends. 0 before the start. */
  startsAt: number;
  gridAt: number;
  endsAt: number;
  /** 1e-8 USD: the price at the start (band 0 begins here), and the height of one band. */
  anchor: bigint;
  step: bigint;
  lastTick: number;
  /** What the line did in each column so far. */
  track: Track;
  /** Per seat, the band picked for each column (signed, i16); `NO_PICK` until the column locks. */
  revealed: [number[], number[]];
  /** Points of the columns that are finished (all of them once over). */
  scores: [number, number];
}

export interface Book {
  address: PublicKey;
  table: PublicKey;
  player: PublicKey;
  seat: number;
  /** A signed band per column (0 starts at the anchor), `NO_PICK` where none. */
  picks: number[];
  pickCount: number;
}

/** The on-chain column ranges as a `grid.ts` Track. */
export function decodeTrack(t: any): Track {
  return {
    lo: (t.lo as anchor.BN[]).map(big),
    hi: (t.hi as anchor.BN[]).map(big),
    seen: Array.from({ length: COLUMNS }, (_, c) => (t.seen & (1 << c)) !== 0),
    last: big(t.last) === 0n ? null : big(t.last),
    lastCol: t.lastCol,
  };
}

export interface Assignment {
  address: PublicKey;
  tesoroMatch: PublicKey;
  generation: number;
  index: number;
  epoch: number;
  players: [PublicKey, PublicKey];
  asset: Asset;
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
    asset: ASSETS[a.asset] ?? ASSETS[0],
    startDeadline: a.startDeadline.toNumber(),
    payer: a.payer,
  };
}

/** A ring slot: the result of a finished Match, kept until tesoro_core has frozen the Match. */
export interface Slot {
  state: number;
  tesoroMatch: PublicKey;
  epoch: number;
  outcome: number;
  at: number;
}

/** The decoded table account, as the chain has it. */
export interface Table {
  address: PublicKey;
  generation: number;
  index: number;
  epoch: number;
  phase: number;
  seatsOpen: boolean;
  dirty: boolean;
  tesoroMatch: PublicKey;
  slot: number;
  players: [PublicKey, PublicKey];
  asset: Asset;
  startDeadline: number;
  checkedIn: [boolean, boolean];
  startsAt: number;
  gridAt: number;
  endsAt: number;
  overAt: number;
  anchor: bigint;
  step: bigint;
  lastTick: number;
  track: Track;
  revealed: [number[], number[]];
  scores: [number, number];
  winner: number;
  ring: Slot[];
}

export function decodeTable(address: PublicKey, t: any): Table {
  return {
    address,
    generation: t.generation,
    index: t.index,
    epoch: t.epoch.toNumber(),
    phase: t.phase,
    seatsOpen: t.seatsOpen,
    dirty: t.dirty,
    tesoroMatch: t.tesoroMatch,
    slot: t.slot,
    players: t.players,
    asset: ASSETS[t.asset] ?? ASSETS[0],
    startDeadline: t.startDeadline.toNumber(),
    checkedIn: [t.checkedIn[0], t.checkedIn[1]],
    startsAt: t.startsAt.toNumber(),
    gridAt: t.gridAt.toNumber(),
    endsAt: t.endsAt.toNumber(),
    overAt: t.overAt.toNumber(),
    anchor: big(t.anchor),
    step: big(t.step),
    lastTick: t.lastTick.toNumber(),
    track: decodeTrack(t.track),
    revealed: [[...t.revealed[0]], [...t.revealed[1]]],
    scores: [t.scores[0], t.scores[1]],
    winner: t.winner,
    ring: (t.ring.slots as any[]).map((x) => ({ state: x.state, tesoroMatch: x.matchKey, epoch: x.epoch.toNumber(), outcome: x.outcome, at: x.at.toNumber() })),
  };
}

/** The ring slot of a Match, if the table still holds one. */
export const slotOf = (t: Table, match: PublicKey, epoch: number): Slot | null =>
  t.ring.find((s) => s.state !== SLOT.free && s.epoch === epoch && s.tesoroMatch.equals(match)) ?? null;

/**
 * Whether base's copy of the table can settle the Match: its ring holds the Match's result, or the table has moved past the
 * Match's epoch without ever running it (a refund, once the start deadline has passed). Mirrors `finalize` on chain.
 */
export function canFinalizeTable(base: Table, a: Assignment, nowS: number): boolean {
  const slot = slotOf(base, a.tesoroMatch, a.epoch);
  if (slot) return slot.state === SLOT.done;
  return base.epoch > a.epoch && nowS > a.startDeadline;
}

/**
 * The table's turn that belongs to the Assignment, as the screens read it: the live Match when the
 * table runs it, `null` when the table is on another Match or epoch (it has been wiped).
 */
export function decodeDuel(a: Assignment, t: Table): Duel | null {
  if (t.epoch !== a.epoch || !t.tesoroMatch.equals(a.tesoroMatch)) return null;
  const never = t.phase === PHASE.over && t.startsAt === 0;
  return {
    address: t.address,
    epoch: t.epoch,
    checkedIn: t.checkedIn,
    seatsOpen: t.seatsOpen,
    dirty: t.dirty,
    tesoroMatch: t.tesoroMatch,
    players: a.players,
    asset: t.asset,
    status: never ? STATUS.cancelled : t.phase === PHASE.live ? STATUS.live : t.phase === PHASE.over ? STATUS.over : STATUS.created,
    winner: t.winner,
    startDeadline: a.startDeadline,
    startsAt: t.startsAt,
    gridAt: t.gridAt,
    endsAt: t.endsAt,
    anchor: t.anchor,
    step: t.step,
    lastTick: t.lastTick,
    track: t.track,
    revealed: t.revealed,
    scores: t.scores,
  };
}

export function decodeBook(address: PublicKey, b: any): Book {
  return { address, table: b.table, player: b.player, seat: b.seat, picks: [...b.picks], pickCount: b.pickCount };
}

// ---------------------------------------------------------------------------------------------
// Client

export interface DuelChainOptions {
  base?: Connection;
  teeRpc?: string;
  teeWs?: string;
  onTx?: (step: string, layer: "base" | "tee", signature: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

export class TradingDuelChain {
  readonly base: Connection;
  readonly program: anchor.Program<TradingDuel>;
  readonly tesoro: anchor.Program<any>;
  private readonly teeRpc: string;
  private readonly teeWs: string;
  private readonly tee = new Map<string, Connection>();
  onTx?: DuelChainOptions["onTx"];

  constructor(duelIdl: TradingDuel, tesoroIdl: any, opts: DuelChainOptions = {}) {
    this.base = opts.base ?? defaultBaseConnection();
    this.teeRpc = opts.teeRpc ?? TEE_RPC;
    this.teeWs = opts.teeWs ?? TEE_WS;
    this.onTx = opts.onTx;
    const provider = new anchor.AnchorProvider(
      this.base,
      { publicKey: Keypair.generate().publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t },
      { commitment: "confirmed" },
    );
    this.program = new anchor.Program(duelIdl, provider);
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
      await sleep(400);
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
    if (!info || !info.owner.equals(TRADING_DUEL_PROGRAM_ID)) return null;
    const a = decodeAssignment(address, this.program.coder.accounts.decode("assignment", info.data));
    this.assignments.set(key, a);
    return a;
  }

  async readTesoroMatch(match: PublicKey): Promise<any | null> {
    const info = await this.base.getAccountInfo(match);
    return info ? this.tesoro.coder.accounts.decode("matchState", info.data) : null;
  }

  /** The table in the rollup, through a Player's (or the keeper's) token; the table is public. */
  async readTable(viewer: PlayerSigner, a: TableRef): Promise<Table | null> {
    const address = tablePda(a.generation, a.index);
    const conn = await this.teeConnection(viewer);
    const info = await conn.getAccountInfo(address).catch(() => null);
    if (!info || (!info.owner.equals(DELEGATION_PROGRAM_ID) && !info.owner.equals(TRADING_DUEL_PROGRAM_ID))) return null;
    return decodeTable(address, this.program.coder.accounts.decode("table", info.data));
  }

  /** The table as the base layer last saw it (what the last commit left): the result ring `finalize` reads. */
  async readTableOnBase(a: TableRef): Promise<Table | null> {
    const address = tablePda(a.generation, a.index);
    const info = await this.base.getAccountInfo(address);
    if (!info || (!info.owner.equals(DELEGATION_PROGRAM_ID) && !info.owner.equals(TRADING_DUEL_PROGRAM_ID))) return null;
    return decodeTable(address, this.program.coder.accounts.decode("table", info.data));
  }

  /** The Match's turn on its table in the rollup; `null` if the table has moved on or cannot be read. */
  async readDuel(viewer: PlayerSigner, a: Assignment): Promise<Duel | null> {
    const t = await this.readTable(viewer, a);
    return t ? decodeDuel(a, t) : null;
  }

  /** The Match's turn as the last commit left it (the board of a finished Match, until the next Match's commit replaces it). */
  async readDuelOnBase(a: Assignment): Promise<Duel | null> {
    const t = await this.readTableOnBase(a);
    return t ? decodeDuel(a, t) : null;
  }

  /** Your own Book through your TEE token; `null` for anything you may not read, or while the seats are closed. */
  async readOwnBook(player: PlayerSigner, a: TableRef, seat: 0 | 1): Promise<Book | null> {
    const address = bookPda(tablePda(a.generation, a.index), seat);
    const conn = await this.teeConnection(player);
    const info = await conn.getAccountInfo(address).catch(() => null);
    if (!info || !info.owner.equals(TRADING_DUEL_PROGRAM_ID)) return null;
    return decodeBook(address, this.program.coder.accounts.decode("book", info.data));
  }

  static seatOf(duel: Duel, wallet: PublicKey): number {
    return duel.players.findIndex((p) => p.equals(wallet));
  }

  // -- base layer ----------------------------------------------------------------------------

  /**
   * Base layer, operator only (the table scheduler, ticket 19t). Binds an Active tesoro_core Match to
   * `generation`/`index` at the table's current `epoch`, once. The Players and the asset are copied from the Match.
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
   * Base layer, permissionless. Settles (or, for a draw, a no-start or a table that moved past the Match, refunds) the
   * tesoro_core Match from the result in the committed table's ring, by CPI as the Game authority PDA. Returns ""
   * when it is already settled. Fails with `NoResult` / `MatchNotOver` until the commit has landed.
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
        ...gameAccounts(TRADING_DUEL_PROGRAM_ID),
        authority: authorityPda(),
        receipt: settledPda(a.tesoroMatch),
        eventAuthority: eventAuthorityPda(),
        tesoroProgram: TESORO_CORE_PROGRAM_ID,
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
        ...gameAccounts(TRADING_DUEL_PROGRAM_ID),
        authority: authorityPda(),
        receipt: settledPda(tesoroMatch),
        eventAuthority: eventAuthorityPda(),
        tesoroProgram: TESORO_CORE_PROGRAM_ID,
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

  private isLive(tesoroMatch: any | null): boolean {
    return !!tesoroMatch && "active" in tesoroMatch.inner.stage;
  }

  // -- rollup: starting ----------------------------------------------------------------------

  /** Rollup, permissionless. Starts the Assignment's Match on its table (reserves a ring slot); the Players then check in. */
  async beginMatch(payer: PlayerSigner, a: Assignment): Promise<string> {
    const ix = await this.program.methods
      .beginMatch()
      .accountsPartial({ caller: payer.publicKey, assignment: a.address, table: tablePda(a.generation, a.index), tesoroMatch: a.tesoroMatch } as any)
      .instruction();
    return this.sendTee("begin_match", [ix], payer);
  }

  private seatAccounts(caller: PublicKey, a: TableRef) {
    const table = tablePda(a.generation, a.index);
    const b0 = bookPda(table, 0);
    const b1 = bookPda(table, 1);
    return {
      caller,
      table,
      book0: b0,
      book1: b1,
      book0Permission: permissionPdaFromAccount(b0),
      book1Permission: permissionPdaFromAccount(b1),
      permissionProgram: PERMISSION_PROGRAM_ID,
      ephemeralVault: EPHEMERAL_VAULT,
      magicProgram: MAGIC_PROGRAM_ID,
    } as any;
  }

  /** Rollup, permissionless. Creates both Players' Books (ephemeral, private to their Player). */
  async openSeats(payer: PlayerSigner, a: TableRef): Promise<string> {
    const ix = await this.program.methods.openSeats().accountsPartial(this.seatAccounts(payer.publicKey, a)).instruction();
    return this.sendTee("open_seats", [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix], payer);
  }

  /** Rollup. You are here. When both Players have, the Match starts at the live price: the head start runs, then 12 columns. */
  async checkIn(player: PlayerSigner, a: TableRef, asset: Asset): Promise<string> {
    const ix = await this.program.methods
      .checkIn()
      .accountsPartial({ player: player.publicKey, table: tablePda(a.generation, a.index), priceFeed: asset.feed } as any)
      .instruction();
    return this.sendTee("check_in", [ix], player);
  }

  /** Rollup, permissionless. Past the start deadline with a Player missing: ends the Match in the ring: the Player who checked in wins, nobody checking in is a no-show. */
  async expireStart(caller: PlayerSigner, a: TableRef): Promise<string> {
    const ix = await this.program.methods.expireStart().accountsPartial({ caller: caller.publicKey, table: tablePda(a.generation, a.index) } as any).instruction();
    return this.sendTee("expire_start", [ix], caller);
  }

  // -- rollup: playing -----------------------------------------------------------------------

  /** Rollup. Picks `band` (signed, 0 starts at the anchor) for `column`, or clears the pick with `NO_PICK`. Only until the column locks. */
  async setPick(player: PlayerSigner, a: TableRef, seat: 0 | 1, column: number, band: number): Promise<string> {
    const table = tablePda(a.generation, a.index);
    const ix = await this.program.methods
      .setPick(column, band)
      .accountsPartial({ player: player.publicKey, table, book: bookPda(table, seat) } as any)
      .instruction();
    return this.sendTee("set_pick", [ix], player);
  }

  private crankAccounts(caller: PublicKey, a: TableRef, asset: Asset) {
    const table = tablePda(a.generation, a.index);
    return { caller, table, book0: bookPda(table, 0), book1: bookPda(table, 1), priceFeed: asset.feed } as any;
  }

  /** Rollup, permissionless. Records the live price into the line, reveals the columns that locked, scores the ones that ended. */
  async tick(payer: PlayerSigner, a: TableRef, asset: Asset): Promise<string> {
    const ix = await this.program.methods.tick().accountsPartial(this.crankAccounts(payer.publicKey, a, asset)).instruction();
    return this.sendTee("tick", [ix], payer);
  }

  /** Rollup, permissionless. After the window: carries the line through any column it missed, scores every column, decides the Match and writes the result into the ring. Reads no price. */
  async end(payer: PlayerSigner, a: TableRef): Promise<string> {
    const table = tablePda(a.generation, a.index);
    const ix = await this.program.methods
      .endMatch()
      .accountsPartial({ caller: payer.publicKey, table, book0: bookPda(table, 0), book1: bookPda(table, 1) } as any)
      .instruction();
    return this.sendTee("end_match", [ix], payer);
  }

  // -- rollup: after the Match ---------------------------------------------------------------

  /** Rollup, permissionless, once per result (the table is `dirty` until then). Commits the table to Solana, paid by the Sponsor. */
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

  /** Rollup, permissionless, table scheduler (19t). Once the Match is over: closes both Books and their permissions. */
  async closeSeats(payer: PlayerSigner, a: TableRef): Promise<string> {
    const ix = await this.program.methods.closeSeats().accountsPartial(this.seatAccounts(payer.publicKey, a)).instruction();
    return this.sendTee("close_seats", [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix], payer);
  }

  /** Rollup, permissionless, table scheduler (19t). Wipes a finished, committed table with closed seats and moves it to the next epoch. */
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
