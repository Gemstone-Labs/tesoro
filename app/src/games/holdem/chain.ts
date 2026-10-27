/**
 * On-chain client for the Hold'em Game (programs/holdem).
 *
 * Matches run on persistent tables that stay delegated to the MagicBlock private rollup (TEE). On
 * the base layer an operator binds a tesoro_core Match to one table and epoch with a write-once
 * Assignment. Everything else happens on the table in the rollup: `begin_match`, `seat_players`
 * (each Player's Hole seat becomes readable by that Player only), `check_in` (the second one
 * starts the Match), then per hand `contribute_entropy`, `request_vrf`, the oracle's callback,
 * `deal`, `act`; `commit_table` publishes the result and `finalize` settles on the base layer from
 * the committed table's result ring. Wiping the seats, resetting the table, freeing ring slots and
 * choosing tables belong to the keeper's table scheduler (ticket 19t); this client has the
 * instructions (`wipeSeats`, `resetTable`, `releaseSlot`, `voidTable`, `closeAssignment`,
 * `assignMatch`, `initSeats`, `refillSponsor`).
 *
 * The client is IDL-based and takes the two IDLs (`target/idl/holdem.json`,
 * `target/idl/tesoro_core.json`) as arguments so it does not depend on how the app bundles JSON.
 * Runtime dependencies: `@coral-xyz/anchor`, `@solana/web3.js` (v1), `@magicblock-labs/ephemeral-rollups-sdk`,
 * `tweetnacl` (only for the Keypair adapter).
 *
 * Privacy: `readOwnHole` works only for the Player's own Hole account; every other read of a
 * hidden account returns `null` (indistinguishable from "does not exist"), never an RPC error.
 */
import type { Holdem } from "../../lib/chain/idl/holdem.types";
import { settledPda } from "../../lib/chain/basket";
import * as anchor from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  getAuthToken,
  permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import { gameAccounts } from "../../lib/chain/game-record";
import { MAGICBLOCK } from "../../lib/cluster-settings";
import { baseRpc } from "../../lib/chain/rpc-config";

export const HOLDEM_PROGRAM_ID = new PublicKey("CjhY1WkwetHYx56uvqRGGA3XuyShXrALSZkB3GjVusbE");
export const TESORO_CORE_PROGRAM_ID = new PublicKey("AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh");

/** The browser base-layer connection, built only when a client is made without one (the keeper and server pass theirs; mainnet has no default RPC). */
export const defaultBaseConnection = () => new Connection(baseRpc(process.env.NEXT_PUBLIC_SOLANA_RPC), "confirmed");
export const TEE_RPC = MAGICBLOCK.teeRpc;
export const TEE_WS = MAGICBLOCK.teeWs;
export const TEE_VALIDATOR = new PublicKey(MAGICBLOCK.teeValidator);
const EPHEMERAL_VAULT = new PublicKey("MagicVau1t999999999999999999999999999999999");
const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");
const ORACLE_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");

export const SPEED_STANDARD = 0;
export const SPEED_TURBO = 1;

export const STATUS = { created: 0, live: 1, over: 2, cancelled: 3 } as const;
export const PHASE = { shuffle: 0, preflop: 1, flop: 2, turn: 3, river: 4, none: 5 } as const;
export const NO_CARD = 255;
export const NO_WINNER = 255;
/** `lastResult` value for a split pot. */
export const SPLIT = 2;

/** A Player's decision. `raise.to` is the total bet for the street; all-in is `to = bet + stack`. */
export type Action =
  | { fold: Record<string, never> }
  | { check: Record<string, never> }
  | { call: Record<string, never> }
  | { raise: { to: anchor.BN } };
export const fold = (): Action => ({ fold: {} });
export const check = (): Action => ({ check: {} });
export const call = (): Action => ({ call: {} });
export const raise = (to: number | bigint | anchor.BN): Action => ({
  raise: { to: new anchor.BN(to.toString()) },
});

/** What the client needs from a wallet. `keypairSigner` adapts a Keypair (scripts, tests). */
export interface PlayerSigner {
  publicKey: PublicKey;
  signTransaction<T extends Transaction>(tx: T): Promise<T>;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

export function keypairSigner(kp: Keypair): PlayerSigner {
  return {
    publicKey: kp.publicKey,
    signTransaction: async (tx) => {
      tx.partialSign(kp);
      return tx;
    },
    signMessage: async (m) => nacl.sign.detached(m, kp.secretKey),
  };
}

const tesoroPda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, TESORO_CORE_PROGRAM_ID)[0];
export const tesoroAccountPda = (authority: PublicKey) => tesoroPda([Buffer.from("account"), authority.toBuffer()]);
export const tesoroConfigPda = () => tesoroPda([Buffer.from("config")]);
export { settledPda };
export const eventAuthorityPda = () => tesoroPda([Buffer.from("__event_authority")]);

// ---------------------------------------------------------------------------------------------
// Cards

const RANKS = "23456789TJQKA";
const SUITS = "cdhs";
/** `0..51` to "As", "Td"... `NO_CARD` to "??". */
export function cardName(card: number): string {
  if (card >= 52) return "??";
  return RANKS[card % 13] + SUITS[Math.floor(card / 13)];
}


const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, HOLDEM_PROGRAM_ID)[0];
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

export const configPda = () => pda([Buffer.from("config")]);
export const sponsorPda = () => pda([Buffer.from("sponsor")]);
export const fuelPda = (n: number) => pda([Buffer.from("fuel"), Buffer.from([n])]);
export const authorityPda = () => pda([Buffer.from("authority")]);
export const tablePda = (generation: number, index: number) => pda([Buffer.from("table"), u16le(generation), u16le(index)]);
/** The write-once binding of a tesoro_core Match (`["match", opener, n]`) to a table and epoch. */
export const assignmentPda = (match: PublicKey) => pda([Buffer.from("assign"), match.toBuffer()]);
/** A Player's hidden seat on the table (an ephemeral account only that Player can read). */
export const holePda = (table: PublicKey, seat: 0 | 1) => pda([Buffer.from("hole"), table.toBuffer(), Buffer.from([seat])]);
/** The address the VRF callback of request number `nonce` must name. */
export const requestMarkerPda = (table: PublicKey, nonce: number | bigint) => pda([Buffer.from("vrfreq"), table.toBuffer(), u64le(nonce)]);
/** The magic fee vault of the TEE validator: the commit fee goes there. */
export const magicFeeVaultPda = () => PublicKey.findProgramAddressSync([Buffer.from("magic-fee-vault"), TEE_VALIDATOR.toBuffer()], DELEGATION_PROGRAM_ID)[0];

/** `Table.phase` on chain: the table between and during Matches. */
export const TABLE_PHASE = { idle: 0, waiting: 1, live: 2, over: 3 } as const;
/** Ring slot states and outcomes (crates/table_kit/src/ring.rs). */
export const SLOT = { free: 0, reserved: 1, done: 2 } as const;
export const OUTCOME = { none: 0, win0: 1, win1: 2, draw: 3, noShow: 4 } as const;

// ---------------------------------------------------------------------------------------------
// Decoded state

/** What the screens read of a Match: the public hand state, as `GameMatch` on the table holds it. */
export interface Table {
  address: PublicKey;
  tesoroMatch: PublicKey;
  /** seat 0 opened the tesoro_core Match, seat 1 joined */
  players: [PublicKey, PublicKey];
  speed: number;
  status: number;
  winner: number;
  handNo: number;
  dealer: number;
  phase: number;
  smallBlind: bigint;
  bigBlind: bigint;
  stacks: [bigint, bigint];
  bets: [bigint, bigint];
  committed: [bigint, bigint];
  pot: bigint;
  toAct: number;
  lastRaise: bigint;
  /** Only revealed cards are below 52. */
  board: number[];
  /** Unix seconds; after it anyone may `claimTimeout`. */
  deadline: number;
  missed: [number, number];
  lastHand: {
    handNo: number;
    /** 0/1 = winning seat, `SPLIT` = chop, `NO_WINNER` = none yet */
    result: number;
    pot: bigint;
    showdown: boolean;
    shown: [[number, number], [number, number]];
    board: number[];
  };
  // -- the table around the Match
  generation: number;
  index: number;
  /** Rises at every reset; a Match is bound to one epoch. */
  epoch: number;
  /** `TABLE_PHASE`. */
  tablePhase: number;
  seatsCreated: boolean;
  seatsOpen: boolean;
  /** The result is in and has not been committed to Solana yet. */
  dirty: boolean;
  checkedIn: [boolean, boolean];
  startDeadline: number;
  overAt: number;
  slot: number;
  /** Number of the latest VRF request, whether one is outstanding, and whether its answer waits for `deal`. */
  reqNonce: number;
  reqPending: boolean;
  vrfReady: boolean;
  ring: Slot[];
}

/** The table-protocol fields of a Table that is not on chain (Practice, the design page): a live table with its seats open. */
export const OFF_CHAIN_TABLE = {
  generation: 0,
  index: 0,
  epoch: 0,
  tablePhase: 2,
  seatsCreated: true,
  seatsOpen: true,
  dirty: false,
  checkedIn: [true, true] as [boolean, boolean],
  startDeadline: 0,
  overAt: 0,
  slot: 0,
  reqNonce: 0,
  reqPending: false,
  vrfReady: false,
  ring: [] as Slot[],
};

/** A ring slot: the result of a finished Match, kept until tesoro_core has frozen the Match. */
export interface Slot {
  state: number;
  tesoroMatch: PublicKey;
  epoch: number;
  outcome: number;
  at: number;
}

const big = (n: anchor.BN) => BigInt(n.toString());
const pair = (a: anchor.BN[]): [bigint, bigint] => [big(a[0]), big(a[1])];

export function decodeTable(address: PublicKey, t: any): Table {
  const m = t.game;
  const committed = pair(m.committed);
  return {
    address,
    tesoroMatch: t.tesoroMatch,
    players: m.players,
    speed: m.speed,
    status: m.status,
    winner: m.winner,
    handNo: m.handNo,
    dealer: m.dealer,
    phase: m.phase,
    smallBlind: big(m.smallBlind),
    bigBlind: big(m.bigBlind),
    stacks: pair(m.stacks),
    bets: pair(m.bets),
    committed,
    pot: committed[0] + committed[1],
    toAct: m.toAct,
    lastRaise: big(m.lastRaise),
    board: Array.from(m.board),
    deadline: m.deadline.toNumber(),
    missed: [m.missed[0], m.missed[1]],
    lastHand: {
      handNo: m.lastHandNo,
      result: m.lastResult,
      pot: big(m.lastPot),
      showdown: m.lastShowdown,
      shown: m.lastShown,
      board: Array.from(m.lastBoard),
    },
    generation: t.generation,
    index: t.index,
    epoch: t.epoch.toNumber(),
    tablePhase: t.phase,
    seatsCreated: t.seatsCreated,
    seatsOpen: t.seatsOpen,
    dirty: t.dirty,
    checkedIn: [t.checkedIn[0], t.checkedIn[1]],
    startDeadline: t.startDeadline.toNumber(),
    overAt: t.overAt.toNumber(),
    slot: t.slot,
    reqNonce: t.reqNonce.toNumber(),
    reqPending: t.reqPending,
    vrfReady: t.vrfReady,
    ring: (t.ring.slots as any[]).map((x) => ({ state: x.state, tesoroMatch: x.matchKey, epoch: x.epoch.toNumber(), outcome: x.outcome, at: x.at.toNumber() })),
  };
}

export interface Assignment {
  address: PublicKey;
  tesoroMatch: PublicKey;
  generation: number;
  index: number;
  epoch: number;
  players: [PublicKey, PublicKey];
  speed: number;
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
    speed: a.speed,
    startDeadline: a.startDeadline.toNumber(),
    payer: a.payer,
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

/** The table's turn that belongs to the Assignment: the table itself when it runs the Match, `null` once it moved on (it has been wiped). */
export function tableOf(a: Assignment, t: Table): Table | null {
  return t.epoch === a.epoch && t.tesoroMatch.equals(a.tesoroMatch) ? t : null;
}

// ---------------------------------------------------------------------------------------------
// Client

export interface HoldemChainOptions {
  base?: Connection;
  teeRpc?: string;
  teeWs?: string;
  /** Called once per confirmed step; useful for evidence logs. */
  onTx?: (step: string, layer: "base" | "tee", signature: string) => void;
}

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

export class HoldemChain {
  readonly base: Connection;
  readonly program: anchor.Program<Holdem>;
  readonly tesoro: anchor.Program<any>;
  private readonly teeRpc: string;
  private readonly teeWs: string;
  private readonly tee = new Map<string, Connection>();
  /** Step logger; a UI may replace it while it is mounted. */
  onTx?: HoldemChainOptions["onTx"];

  constructor(holdemIdl: Holdem, tesoroIdl: any, opts: HoldemChainOptions = {}) {
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
    this.program = new anchor.Program(holdemIdl, provider);
    this.tesoro = new anchor.Program(tesoroIdl, provider);
  }

  /** A TEE connection authenticated as `signer` (one per Player; tokens are per key). */
  async teeConnection(signer: PlayerSigner): Promise<Connection> {
    const key = signer.publicKey.toBase58();
    const cached = this.tee.get(key);
    if (cached) return cached;
    const { token } = await withRetry(() =>
      getAuthToken(this.teeRpc, signer.publicKey, (m: Uint8Array) => signer.signMessage(m)),
    );
    const conn = new Connection(`${this.teeRpc}?token=${token}`, {
      wsEndpoint: `${this.teeWs}?token=${token}`,
      commitment: "confirmed",
    });
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
      await sleep(500);
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
    if (!info || !info.owner.equals(HOLDEM_PROGRAM_ID)) return null;
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
    if (!info || (!info.owner.equals(DELEGATION_PROGRAM_ID) && !info.owner.equals(HOLDEM_PROGRAM_ID))) return null;
    return decodeTable(address, this.program.coder.accounts.decode("table", info.data));
  }

  /** The table as the base layer last saw it (what the last commit left): the result ring `finalize` reads, and the last hand shown. */
  async readTableOnBase(a: TableRef): Promise<Table | null> {
    const address = tablePda(a.generation, a.index);
    const info = await this.base.getAccountInfo(address);
    if (!info || (!info.owner.equals(DELEGATION_PROGRAM_ID) && !info.owner.equals(HOLDEM_PROGRAM_ID))) return null;
    return decodeTable(address, this.program.coder.accounts.decode("table", info.data));
  }

  /** Your own seat through your TEE token: the hole cards of the current hand, or `null` before the deal and for anything you may not read. */
  async readOwnHole(player: PlayerSigner, a: TableRef, seat: 0 | 1): Promise<{ handNo: number; cards: [number, number] } | null> {
    const address = holePda(tablePda(a.generation, a.index), seat);
    const conn = await this.teeConnection(player);
    const info = await conn.getAccountInfo(address).catch(() => null);
    if (!info || !info.owner.equals(HOLDEM_PROGRAM_ID)) return null;
    const hole: any = this.program.coder.accounts.decode("hole", info.data);
    if (!hole.dealt) return null;
    return { handNo: hole.handNo, cards: [hole.cards[0], hole.cards[1]] };
  }

  /** Whether your own seat has your secret for the hand in it (a refused retry must never send a second secret). */
  async hasContributed(player: PlayerSigner, a: TableRef, seat: 0 | 1): Promise<boolean> {
    const address = holePda(tablePda(a.generation, a.index), seat);
    const conn = await this.teeConnection(player);
    const info = await conn.getAccountInfo(address).catch(() => null);
    if (!info || !info.owner.equals(HOLDEM_PROGRAM_ID)) return false;
    const hole: any = this.program.coder.accounts.decode("hole", info.data);
    return !!hole.contributed;
  }

  /** Seat of `wallet` at this table, or -1. */
  static seatOf(table: Table, wallet: PublicKey): number {
    return table.players.findIndex((p) => p.equals(wallet));
  }

  // -- base layer ----------------------------------------------------------------------------

  /**
   * Base layer, operator only (the table scheduler, ticket 19t). Binds an Active tesoro_core Match to
   * `generation`/`index` at the table's current `epoch`, once. The Players and the speed are copied from the Match.
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
        ...gameAccounts(HOLDEM_PROGRAM_ID),
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
        ...gameAccounts(HOLDEM_PROGRAM_ID),
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

  // -- rollup: seats and starting -------------------------------------------------------------

  private seatAccounts(caller: PublicKey, a: TableRef) {
    const table = tablePda(a.generation, a.index);
    const h0 = holePda(table, 0);
    const h1 = holePda(table, 1);
    return {
      caller,
      table,
      hole0: h0,
      hole1: h1,
      hole0Permission: permissionPdaFromAccount(h0),
      hole1Permission: permissionPdaFromAccount(h1),
      permissionProgram: PERMISSION_PROGRAM_ID,
      ephemeralVault: EPHEMERAL_VAULT,
      magicProgram: MAGIC_PROGRAM_ID,
    } as any;
  }

  /** Rollup, permissionless, once per table (the operator's setup). Creates the two Hole seats, private to nobody until a Match is begun. */
  async initSeats(payer: PlayerSigner, a: TableRef): Promise<string> {
    const ix = await this.program.methods.initSeats().accountsPartial(this.seatAccounts(payer.publicKey, a)).instruction();
    return this.sendTee("init_seats", [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix], payer);
  }

  /** Rollup, permissionless. Starts the Assignment's Match on its table (reserves a ring slot); the seats are then handed over and the Players check in. */
  async beginMatch(payer: PlayerSigner, a: Assignment): Promise<string> {
    const ix = await this.program.methods
      .beginMatch()
      .accountsPartial({ caller: payer.publicKey, assignment: a.address, table: tablePda(a.generation, a.index), tesoroMatch: a.tesoroMatch } as any)
      .instruction();
    return this.sendTee("begin_match", [ix], payer);
  }

  /** Rollup, permissionless. Hands each seat to its Player (the seat becomes readable by that Player only). */
  async seatPlayers(payer: PlayerSigner, a: TableRef): Promise<string> {
    const ix = await this.program.methods.seatPlayers().accountsPartial(this.seatAccounts(payer.publicKey, a)).instruction();
    return this.sendTee("seat_players", [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix], payer);
  }

  /** Rollup. You are here. When both Players have, the Match starts (equal Chips, blinds posted). */
  async checkIn(player: PlayerSigner, a: TableRef): Promise<string> {
    const ix = await this.program.methods.checkIn().accountsPartial({ player: player.publicKey, table: tablePda(a.generation, a.index) } as any).instruction();
    return this.sendTee("check_in", [ix], player);
  }

  /** Rollup, permissionless. Past the start deadline with a Player missing: ends the Match in the ring: the Player who checked in wins, nobody checking in is a no-show. */
  async expireStart(caller: PlayerSigner, a: TableRef): Promise<string> {
    const ix = await this.program.methods.expireStart().accountsPartial({ caller: caller.publicKey, table: tablePda(a.generation, a.index) } as any).instruction();
    return this.sendTee("expire_start", [ix], caller);
  }

  // -- rollup: playing -----------------------------------------------------------------------

  /**
   * Rollup. A Player's fresh secret for this hand, generated here and sent once, only inside the TEE, into your own seat.
   * Never call it again for the same hand after it was sent (a retry would send a second secret): `hasContributed` says.
   * `withVrf` also requests the oracle's randomness in the same transaction: pass it from the Player who contributes second.
   */
  async contributeEntropy(player: PlayerSigner, a: TableRef, seat: 0 | 1, withVrf = false): Promise<string> {
    const table = tablePda(a.generation, a.index);
    const secret = Array.from(nacl.randomBytes(32));
    const ixs: TransactionInstruction[] = [
      await this.program.methods
        .contributeEntropy(secret)
        .accountsPartial({ player: player.publicKey, table, hole: holePda(table, seat) } as any)
        .instruction(),
    ];
    if (withVrf) ixs.push(await this.requestVrfIx(player.publicKey, a));
    return this.sendTee(withVrf ? "contribute_entropy+request_vrf" : "contribute_entropy", ixs, player);
  }

  private requestVrfIx(payer: PublicKey, a: TableRef) {
    const table = tablePda(a.generation, a.index);
    return this.program.methods
      .requestVrf()
      .accountsPartial({ payer, table, hole0: holePda(table, 0), hole1: holePda(table, 1), oracleQueue: ORACLE_QUEUE } as any)
      .instruction();
  }

  /** Rollup, permissionless. Asks the oracle for this hand's randomness. The program accepts one request per hand; a second is refused. */
  async requestVrf(payer: PlayerSigner, a: TableRef): Promise<string> {
    return this.sendTee("request_vrf", [await this.requestVrfIx(payer.publicKey, a)], payer);
  }

  /** Rollup, permissionless. Deals the hand once both secrets and the oracle's answer are in. */
  async deal(payer: PlayerSigner, a: TableRef): Promise<string> {
    const table = tablePda(a.generation, a.index);
    const ix = await this.program.methods
      .deal()
      .accountsPartial({ payer: payer.publicKey, table, hole0: holePda(table, 0), hole1: holePda(table, 1) } as any)
      .instruction();
    return this.sendTee("deal", [ix], payer);
  }

  /** Rollup. A betting action on your turn. */
  async act(player: PlayerSigner, a: TableRef, action: Action): Promise<string> {
    const table = tablePda(a.generation, a.index);
    const ix = await this.program.methods
      .act(action as any)
      .accountsPartial({ player: player.publicKey, table, hole0: holePda(table, 0), hole1: holePda(table, 1) } as any)
      .instruction();
    return this.sendTee(`act ${Object.keys(action)[0]}`, [ix], player);
  }

  /**
   * Rollup, permissionless. Once `table.deadline` has passed: checks or folds the idle Player, cancels a no-show,
   * forfeits after three missed turns, refunds a hand whose randomness never came.
   */
  async claimTimeout(caller: PlayerSigner, a: TableRef): Promise<string> {
    const table = tablePda(a.generation, a.index);
    const ix = await this.program.methods
      .claimTimeout()
      .accountsPartial({ caller: caller.publicKey, table, hole0: holePda(table, 0), hole1: holePda(table, 1) } as any)
      .instruction();
    return this.sendTee("claim_timeout", [ix], caller);
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

  /** Rollup, permissionless, table scheduler (19t). Once the Match is over: zeroes both seats and swaps their permission members to nobody. */
  async wipeSeats(payer: PlayerSigner, a: TableRef): Promise<string> {
    const ix = await this.program.methods.wipeSeats().accountsPartial(this.seatAccounts(payer.publicKey, a)).instruction();
    return this.sendTee("wipe_seats", [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix], payer);
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
