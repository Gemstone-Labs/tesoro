/**
 * On-chain client for the Vanguard Game (programs/vanguard).
 *
 * Matches run on persistent tables that stay delegated to the MagicBlock private rollup (TEE). On the base layer an
 * operator binds a tesoro_core Match to one table and epoch with a write-once Assignment. Everything else happens on the
 * table in the rollup: `begin_match`, `seat_players` (each Player's Army seat becomes readable by that Player only),
 * `check_in` (the second one opens setup), `contribute_entropy`, `request_vrf`, the oracle's callback, `deal`, the declares
 * and `resolve`; `commit_table` publishes the result (the table and its public Battle) and `finalize` settles on the base
 * layer from the committed table's result ring. Wiping the seats, resetting the table, freeing ring slots and choosing
 * tables belong to the keeper's table scheduler (ticket 19t); this client has the instructions.
 *
 * Privacy: the Battle is readable by everyone, an Army only by its own Player. A read of an account the connection may not
 * see returns `null`, indistinguishable from "does not exist".
 */
import * as anchor from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID, getAuthToken, permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import {
  OUTCOME,
  SLOT,
  TABLE_PHASE,
  TEE_RPC,
  TEE_WS,
  TESORO_CORE_PROGRAM_ID,
  defaultBaseConnection,
  keypairSigner,
  tesoroAccountPda,
  tesoroConfigPda,
  settledPda,
  eventAuthorityPda,
  type PlayerSigner,
  type Slot,
} from "../holdem/chain";
import { decodeArmy, decodeBattle, type ArmyAccount, type Battle } from "./decode";
import { gameAccounts } from "../../lib/chain/game-record";

export { keypairSigner, tesoroAccountPda, type PlayerSigner };

export const VANGUARD_PROGRAM_ID = new PublicKey("TS3iowavNFV2pMUrHcbmGNC9SW2Vv54i52DqjKebYKH");
const EPHEMERAL_VAULT = new PublicKey("MagicVau1t999999999999999999999999999999999");
const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");

/**
 * Compute limits. A declare (a move, a timeout claim) checks public state only: about 4-6k CU in LiteSVM. The resolve
 * does the rank rules, the fight, the turn pass and the "any action left?" scan over every shape a rank could make
 * (rules version 6): 135-145k in LiteSVM on compiled SBF whatever the board (a lost turn the same; endings that skip
 * the scan are cheaper). 200k leaves 30% over the worst reading (see ticket vgp 05). The seat and commit steps make
 * permission and MagicBlock calls: Hold'em's 400k. `finalize` pays out.
 */
export const CU = { declare: 40_000, resolve: 200_000, finalize: 400_000, assign: 300_000, seats: 400_000, commit: 400_000 } as const;

/** What every declare carries: the `action_seq` it was built for (public) and the sealed Become a Spy byte. */
export interface DeclareSeal {
  expectedSeq: number;
  sealedSwitch: number;
}

export interface Addresses {
  table: PublicKey;
  battle: PublicKey;
  army0: PublicKey;
  army1: PublicKey;
  authority: PublicKey;
  /** The cluster settings (TEE validator, oracle queue). */
  config: PublicKey;
  /** The table settings (operator, generation, table cap). */
  tables: PublicKey;
  sponsor: PublicKey;
}

const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, VANGUARD_PROGRAM_ID)[0];
const u16le = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};

/** The program's VanguardConfig (the TEE validator and oracle queue). */
export const configPda = () => pda([Buffer.from("config")]);
/** The table settings (`TableConfig`): the operator, the current generation and the table cap. */
export const tablesPda = () => pda([Buffer.from("tables")]);
export const sponsorPda = () => pda([Buffer.from("sponsor")]);
export const fuelPda = (n: number) => pda([Buffer.from("fuel"), Buffer.from([n])]);
export const authorityPda = () => pda([Buffer.from("authority")]);
export const tablePda = (generation: number, index: number) => pda([Buffer.from("table"), u16le(generation), u16le(index)]);
export const battlePda = (table: PublicKey) => pda([Buffer.from("battle"), table.toBuffer()]);
/** A Player's hidden seat on the table (an ephemeral account only that Player can read). */
export const armyPda = (table: PublicKey, seat: 0 | 1) => pda([Buffer.from("army"), table.toBuffer(), Buffer.from([seat])]);
/** The write-once binding of a tesoro_core Match (`["match", opener, n]`) to a table and epoch. */
export const assignmentPda = (match: PublicKey) => pda([Buffer.from("assign"), match.toBuffer()]);
/** The magic fee vault of a TEE validator: the commit fee goes there. */
export const magicFeeVaultPda = (validator: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("magic-fee-vault"), validator.toBuffer()], DELEGATION_PROGRAM_ID)[0];

/** Which table: what most instructions need of an Assignment. */
export interface TableRef {
  generation: number;
  index: number;
}

/** PDAs of one table. */
export function addresses(ref: TableRef): Addresses {
  const table = tablePda(ref.generation, ref.index);
  return {
    table,
    battle: battlePda(table),
    army0: armyPda(table, 0),
    army1: armyPda(table, 1),
    authority: authorityPda(),
    config: configPda(),
    tables: tablesPda(),
    sponsor: sponsorPda(),
  };
}

/** The Assignment of a Match: which table and epoch, written once by the operator. */
export interface Assignment extends TableRef {
  address: PublicKey;
  tesoroMatch: PublicKey;
  epoch: number;
  players: [PublicKey, PublicKey];
  startDeadline: number;
  payer: PublicKey;
}

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

/** The public table: the protocol around the Match (the board itself is the Battle). */
export interface TableState extends TableRef {
  address: PublicKey;
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
  checkedIn: [boolean, boolean];
  overAt: number;
  /** Number of the latest VRF request, whether one is outstanding, whether the Match's one request was made, and whether its answer waits for `deal`. */
  reqNonce: number;
  reqPending: boolean;
  reqMade: boolean;
  vrfReady: boolean;
  ring: Slot[];
}

export function decodeTable(address: PublicKey, t: any): TableState {
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
    checkedIn: [t.checkedIn[0], t.checkedIn[1]],
    overAt: t.overAt.toNumber(),
    reqNonce: t.reqNonce.toNumber(),
    reqPending: t.reqPending,
    reqMade: t.reqMade,
    vrfReady: t.vrfReady,
    ring: (t.ring.slots as any[]).map((x) => ({ state: x.state, tesoroMatch: x.matchKey, epoch: x.epoch.toNumber(), outcome: x.outcome, at: x.at.toNumber() })),
  };
}

/** The ring slot of a Match, if the table still holds one. */
export const slotOf = (t: Pick<TableState, "ring">, match: PublicKey, epoch: number): Slot | null =>
  t.ring.find((s) => s.state !== SLOT.free && s.epoch === epoch && s.tesoroMatch.equals(match)) ?? null;

/**
 * Whether base's copy of the table can settle the Match: its ring holds the Match's result, or the table has moved past the
 * Match's epoch without ever running it (a refund, once the start deadline has passed). Mirrors `finalize` on chain.
 */
export function canFinalizeTable(base: Pick<TableState, "ring" | "epoch">, a: Pick<Assignment, "tesoroMatch" | "epoch" | "startDeadline">, nowS: number): boolean {
  const slot = slotOf(base, a.tesoroMatch, a.epoch);
  if (slot) return slot.state === SLOT.done;
  return base.epoch > a.epoch && nowS > a.startDeadline;
}

/** Whether the table's turn is the Assignment's: false once the table moved on (it has been wiped for its next Match). */
export const tableOf = (a: Pick<Assignment, "tesoroMatch" | "epoch">, t: Pick<TableState, "epoch" | "tesoroMatch">): boolean =>
  t.epoch === a.epoch && t.tesoroMatch.equals(a.tesoroMatch);

export { OUTCOME, SLOT, TABLE_PHASE };

export interface VanguardChainOptions {
  base?: Connection;
  teeRpc?: string;
  teeWs?: string;
  /** Called once per confirmed step; useful for evidence logs. */
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

/** A rollup blockhash is reused for this long, so a short turn does not spend a round trip on one. */
const BLOCKHASH_TTL_MS = 20_000;

export class VanguardChain {
  readonly base: Connection;
  readonly program: anchor.Program<any>;
  readonly tesoro: anchor.Program<any>;
  private readonly teeRpc: string;
  private readonly teeWs: string;
  private readonly tee = new Map<string, Connection>();
  /** The cached rollup blockhash per connection, with every message already sent under it. */
  private readonly hashes = new Map<Connection, { hash: string; at: number; sent: Set<string> }>();
  /** Step logger; a UI may replace it while it is mounted. */
  onTx?: VanguardChainOptions["onTx"];

  constructor(vanguardIdl: any, tesoroIdl: any, opts: VanguardChainOptions = {}) {
    this.base = opts.base ?? defaultBaseConnection();
    this.teeRpc = opts.teeRpc ?? TEE_RPC;
    this.teeWs = opts.teeWs ?? TEE_WS;
    this.onTx = opts.onTx;
    const provider = new anchor.AnchorProvider(
      this.base,
      // Read-only provider: transactions are built here and signed by the caller's signer.
      {
        publicKey: Keypair.generate().publicKey,
        signTransaction: async (t: any) => t,
        signAllTransactions: async (t: any) => t,
      },
      { commitment: "confirmed" },
    );
    this.program = new anchor.Program(vanguardIdl, provider);
    this.tesoro = new anchor.Program(tesoroIdl, provider);
  }

  private configRead: Promise<{ teeValidator: PublicKey; oracleQueue: PublicKey }> | null = null;

  /** The deployment values the program enforces (the TEE validator and the oracle queue), read once from its VanguardConfig. */
  readConfig(): Promise<{ teeValidator: PublicKey; oracleQueue: PublicKey }> {
    if (!this.configRead) {
      const read: Promise<{ teeValidator: PublicKey; oracleQueue: PublicKey }> = (this.program.account as any).vanguardConfig
        .fetch(configPda())
        .then((c: any) => ({ teeValidator: c.teeValidator as PublicKey, oracleQueue: c.oracleQueue as PublicKey }));
      read.catch(() => {
        this.configRead = null;
      });
      this.configRead = read;
      return read;
    }
    return this.configRead;
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
        // A dropped transaction (blockhash expired before landing) is safe to rebuild and resend.
        if (attempt < 2 && String(e?.name).includes("TransactionExpiredBlockheightExceeded")) continue;
        throw e;
      }
      this.onTx?.(step, "base", sig);
      return sig;
    }
  }

  private async blockhash(conn: Connection, fresh = false): Promise<{ hash: string; sent: Set<string> }> {
    const seen = this.hashes.get(conn);
    if (seen && !fresh && Date.now() - seen.at < BLOCKHASH_TTL_MS) return seen;
    const hash = (await withRetry(() => conn.getLatestBlockhash())).blockhash;
    // the rollup may hand the same hash out again: what was sent under it still counts
    const entry = { hash, at: Date.now(), sent: seen?.hash === hash ? seen.sent : new Set<string>() };
    this.hashes.set(conn, entry);
    return entry;
  }

  /**
   * Sets a blockhash under which these exact bytes were never sent. `resolve` and `claim_timeout` take no arguments, so the
   * same Player sending one twice under one hash would send the same transaction: it carries the first one's signature, the
   * rollup answers with the first one's result, and nothing runs.
   */
  private async setBlockhash(conn: Connection, tx: Transaction): Promise<void> {
    for (let i = 0; i < 20; i++) {
      const entry = await this.blockhash(conn, i > 0);
      tx.recentBlockhash = entry.hash;
      const message = tx.serializeMessage().toString("base64");
      if (!entry.sent.has(message)) {
        entry.sent.add(message);
        return;
      }
      if (i > 0) await sleep(100);
    }
    throw new Error("The rollup kept the same blockhash: try again");
  }

  private async sendTee(step: string, ixs: TransactionInstruction[], signer: PlayerSigner): Promise<string> {
    const conn = await this.teeConnection(signer);
    const tx = new Transaction().add(...ixs);
    tx.feePayer = signer.publicKey;
    await this.setBlockhash(conn, tx);
    const signed = await signer.signTransaction(tx);
    const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
    for (let i = 0; i < 120; i++) {
      const st = (await conn.getSignatureStatuses([sig])).value[0];
      if (st) {
        if (st.err) {
          const t = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
          // an expired cached hash is the one failure worth a fresh hash next time
          this.expireHash(conn);
          throw new Error(`${step} failed ${sig}: ${JSON.stringify(st.err)}\n${t?.meta?.logMessages?.join("\n") ?? ""}`);
        }
        this.onTx?.(step, "tee", sig);
        return sig;
      }
      await sleep(250);
    }
    this.expireHash(conn);
    throw new Error(`${step} not confirmed ${sig}`);
  }

  /** The next send fetches a new hash; what was sent under the old one is kept in case the rollup hands it out again. */
  private expireHash(conn: Connection): void {
    const seen = this.hashes.get(conn);
    if (seen) seen.at = 0;
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
    if (!info || !info.owner.equals(VANGUARD_PROGRAM_ID)) return null;
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
  async readTable(viewer: PlayerSigner, ref: TableRef): Promise<TableState | null> {
    const address = tablePda(ref.generation, ref.index);
    const conn = await this.teeConnection(viewer);
    const info = await conn.getAccountInfo(address).catch(() => null);
    if (!info || (!info.owner.equals(DELEGATION_PROGRAM_ID) && !info.owner.equals(VANGUARD_PROGRAM_ID))) return null;
    return decodeTable(address, this.program.coder.accounts.decode("table", info.data));
  }

  /** The table as the base layer last saw it (what the last commit left): the result ring `finalize` reads. */
  async readTableOnBase(ref: TableRef): Promise<TableState | null> {
    const address = tablePda(ref.generation, ref.index);
    const info = await this.base.getAccountInfo(address);
    if (!info || (!info.owner.equals(DELEGATION_PROGRAM_ID) && !info.owner.equals(VANGUARD_PROGRAM_ID))) return null;
    return decodeTable(address, this.program.coder.accounts.decode("table", info.data));
  }

  /** The public Battle from the rollup. `null` if it does not exist there (yet, or any more). */
  async readBattle(viewer: PlayerSigner, ref: TableRef): Promise<Battle | null> {
    const conn = await this.teeConnection(viewer);
    const info = await conn.getAccountInfo(addresses(ref).battle).catch(() => null);
    if (!info || (!info.owner.equals(DELEGATION_PROGRAM_ID) && !info.owner.equals(VANGUARD_PROGRAM_ID))) return null;
    return decodeBattle(info.data);
  }

  /** The Battle on the base layer: the last Match committed on this table (the final board until a later Match's commit replaces it). */
  async readBattleOnBase(ref: TableRef): Promise<Battle | null> {
    const info = await this.base.getAccountInfo(addresses(ref).battle);
    if (!info || (!info.owner.equals(VANGUARD_PROGRAM_ID) && !info.owner.equals(DELEGATION_PROGRAM_ID))) return null;
    return decodeBattle(info.data);
  }

  /** Your own Army through your TEE token. `null` before the deal, and for anything you may not read (the opponent's reads as null too). */
  async readOwnArmy(player: PlayerSigner, ref: TableRef, seat: 0 | 1): Promise<ArmyAccount | null> {
    const ad = addresses(ref);
    const conn = await this.teeConnection(player);
    const info = await conn.getAccountInfo(seat === 0 ? ad.army0 : ad.army1).catch(() => null);
    if (!info || info.data.length === 0) return null;
    try {
      const a = decodeArmy(info.data);
      return a.side === 255 ? null : a;
    } catch {
      return null;
    }
  }

  /** Whether your own seat has your secret for the Match in it (a refused retry must never send a second secret). */
  async hasContributed(player: PlayerSigner, ref: TableRef, seat: 0 | 1): Promise<boolean> {
    const ad = addresses(ref);
    const conn = await this.teeConnection(player);
    const info = await conn.getAccountInfo(seat === 0 ? ad.army0 : ad.army1).catch(() => null);
    if (!info || info.data.length === 0) return false;
    try {
      const a = decodeArmy(info.data);
      return a.contributed || a.dealt;
    } catch {
      return false;
    }
  }

  /** Calls `onBattle` on every change of the Battle on the rollup. Returns the unsubscribe. */
  async watchBattle(viewer: PlayerSigner, ref: TableRef, onBattle: (b: Battle) => void): Promise<() => void> {
    const conn = await this.teeConnection(viewer);
    const id = conn.onAccountChange(
      addresses(ref).battle,
      (info) => {
        try {
          onBattle(decodeBattle(info.data));
        } catch {
          // an account that is mid-update can be empty; the poll covers it
        }
      },
      "confirmed",
    );
    return () => void conn.removeAccountChangeListener(id).catch(() => undefined);
  }

  /** Seat of `wallet` in this Battle, or -1. */
  static seatOf(battle: Battle, wallet: PublicKey): number {
    return battle.players.findIndex((p) => p.equals(wallet));
  }

  // -- base layer ----------------------------------------------------------------------------

  /**
   * Base layer, operator only (the table scheduler, ticket 19t). Binds an Active tesoro_core Match to `generation`/`index` at
   * the table's current `epoch`, once. The Players are copied from the Match.
   */
  async assignMatch(operator: PlayerSigner, match: PublicKey, seatA: PublicKey, seatB: PublicKey, generation: number, index: number, epoch: number): Promise<string> {
    const ix = await this.program.methods
      .assignMatch(generation, index, new anchor.BN(epoch))
      .accountsPartial({
        operator: operator.publicKey,
        tableConfig: tablesPda(),
        tesoroMatch: match,
        accountA: tesoroAccountPda(seatA),
        accountB: tesoroAccountPda(seatB),
        authority: authorityPda(),
        assignment: assignmentPda(match),
        tesoroProgram: TESORO_CORE_PROGRAM_ID,
      } as any)
      .instruction();
    return this.sendBase("assign_match", [ComputeBudgetProgram.setComputeUnitLimit({ units: CU.assign }), ix], [operator]);
  }

  /**
   * Base layer, permissionless. Settles (or, for a draw, a cancelled setup, a no-start or a table that moved past the Match,
   * refunds) the tesoro_core Match from the result in the committed table's ring, by CPI as the Game authority PDA. Returns ""
   * when it is already settled. Fails with `NoResult` / `MatchNotOver` until the commit has landed.
   */
  async finalize(payer: PlayerSigner, a: Assignment): Promise<string> {
    if (!this.isLive(await this.readTesoroMatch(a.tesoroMatch))) return "";
    const ix = await this.program.methods
      .finalize()
      .accountsPartial({
        caller: payer.publicKey,
        assignment: a.address,
        table: tablePda(a.generation, a.index),
        tesoroMatch: a.tesoroMatch,
        config: tesoroConfigPda(),
        ...gameAccounts(VANGUARD_PROGRAM_ID),
        authority: authorityPda(),
        receipt: settledPda(a.tesoroMatch),
        eventAuthority: eventAuthorityPda(),
        tesoroProgram: TESORO_CORE_PROGRAM_ID,
      } as any)
      .instruction();
    return this.sendBase("finalize", [ComputeBudgetProgram.setComputeUnitLimit({ units: CU.finalize }), ix], [payer]);
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

  private seatAccounts(caller: PublicKey, ref: TableRef) {
    const ad = addresses(ref);
    return {
      caller,
      table: ad.table,
      army0: ad.army0,
      army1: ad.army1,
      army0Permission: permissionPdaFromAccount(ad.army0),
      army1Permission: permissionPdaFromAccount(ad.army1),
      permissionProgram: PERMISSION_PROGRAM_ID,
      ephemeralVault: EPHEMERAL_VAULT,
      magicProgram: MAGIC_PROGRAM_ID,
    } as any;
  }

  /** Rollup, permissionless, once per table (the operator's setup). Creates the two Army seats, private to nobody until a Match is begun. */
  async initSeats(payer: PlayerSigner, ref: TableRef): Promise<string> {
    const ix = await this.program.methods.initSeats().accountsPartial(this.seatAccounts(payer.publicKey, ref)).instruction();
    return this.sendTee("init_seats", [ComputeBudgetProgram.setComputeUnitLimit({ units: CU.seats }), ix], payer);
  }

  /** Rollup, permissionless. Starts the Assignment's Match on its table (reserves a ring slot, binds the Battle); the seats are then handed over and the Players check in. */
  async beginMatch(payer: PlayerSigner, a: Assignment): Promise<string> {
    const ad = addresses(a);
    const ix = await this.program.methods
      .beginMatch()
      .accountsPartial({ caller: payer.publicKey, assignment: a.address, table: ad.table, battle: ad.battle, tesoroMatch: a.tesoroMatch, vanguardConfig: configPda() } as any)
      .instruction();
    return this.sendTee("begin_match", [ix], payer);
  }

  /** Rollup, permissionless. Hands each seat to its Player (the seat becomes readable by that Player only). */
  async seatPlayers(payer: PlayerSigner, ref: TableRef): Promise<string> {
    const ad = addresses(ref);
    const ix = await this.program.methods
      .seatPlayers()
      .accountsPartial({ ...this.seatAccounts(payer.publicKey, ref), battle: ad.battle })
      .instruction();
    return this.sendTee("seat_players", [ComputeBudgetProgram.setComputeUnitLimit({ units: CU.seats }), ix], payer);
  }

  /** Rollup. You are here. When both Players have, setup opens: each has a minute to fold a secret in. */
  async checkIn(player: PlayerSigner, ref: TableRef): Promise<string> {
    const ad = addresses(ref);
    const ix = await this.program.methods.checkIn().accountsPartial({ player: player.publicKey, table: ad.table, battle: ad.battle } as any).instruction();
    return this.sendTee("check_in", [ix], player);
  }

  // -- rollup: setup ---------------------------------------------------------------------------

  /**
   * Rollup. A Player's fresh secret, generated here and sent once, only inside the TEE, into your own seat. Never call it again
   * for the same Match after it was sent (a retry would send a second secret): `hasContributed` says. `withVrf` also requests the
   * randomness in the same transaction: pass it from the Player who contributes second.
   */
  async contributeEntropy(player: PlayerSigner, ref: TableRef, seat: 0 | 1, withVrf = false, oracleQueue?: PublicKey): Promise<string> {
    const ad = addresses(ref);
    const secret = Array.from(nacl.randomBytes(32));
    const ixs: TransactionInstruction[] = [
      await this.program.methods
        .contributeEntropy(secret)
        .accountsPartial({ player: player.publicKey, table: ad.table, battle: ad.battle, army: seat === 0 ? ad.army0 : ad.army1 } as any)
        .instruction(),
    ];
    if (withVrf) ixs.push(await this.requestVrfIx(player.publicKey, ref, oracleQueue));
    return this.sendTee(withVrf ? "contribute_entropy+request_vrf" : "contribute_entropy", ixs, player);
  }

  /** The `request_vrf` instruction, for a caller that sends or simulates it itself. The program accepts one request per Match; a second is refused. */
  async requestVrfIx(payer: PublicKey, ref: TableRef, oracleQueue?: PublicKey): Promise<TransactionInstruction> {
    const ad = addresses(ref);
    const queue = oracleQueue ?? (await this.readConfig()).oracleQueue;
    return this.program.methods
      .requestVrf()
      .accountsPartial({ payer, table: ad.table, battle: ad.battle, army0: ad.army0, army1: ad.army1, oracleQueue: queue } as any)
      .instruction();
  }

  /** Rollup, permissionless. Asks the oracle for this Match's randomness. Once per Match. */
  async requestVrf(payer: PlayerSigner, ref: TableRef, oracleQueue?: PublicKey): Promise<string> {
    return this.sendTee("request_vrf", [await this.requestVrfIx(payer.publicKey, ref, oracleQueue)], payer);
  }

  /** The `deal` instruction, for a caller that sends or simulates it itself. */
  dealIx(payer: PublicKey, ref: TableRef): Promise<TransactionInstruction> {
    const ad = addresses(ref);
    return this.program.methods
      .deal()
      .accountsPartial({ payer, table: ad.table, battle: ad.battle, army0: ad.army0, army1: ad.army1 } as any)
      .instruction();
  }

  /** Rollup, permissionless. Sets the board up once both secrets and the randomness are in. */
  async deal(payer: PlayerSigner, ref: TableRef): Promise<string> {
    return this.sendTee("deal", [await this.dealIx(payer.publicKey, ref)], payer);
  }

  // -- rollup: playing -----------------------------------------------------------------------

  private declareAccounts(player: PublicKey, ref: TableRef) {
    const ad = addresses(ref);
    return { player, table: ad.table, battle: ad.battle } as any;
  }

  /**
   * Rollup. Declare a move (or an attack) of `piece` to square `to` (`row * 10 + col`) on your turn. The program
   * checks only public state now; the rank rules and the fight are applied by `resolve` in a later slot, and a move
   * the rank rules refuse costs the turn. A declare cannot be taken back. Send `resolve` as soon as it lands.
   * `seal` is the Battle's `action_seq` you saw and the sealed Become a Spy byte (always sent, 0 sealed like any other).
   */
  async movePiece(player: PlayerSigner, ref: TableRef, piece: number, to: number, seal: DeclareSeal): Promise<string> {
    const ix = await this.program.methods.movePiece(piece, to, seal.expectedSeq, seal.sealedSwitch).accountsPartial(this.declareAccounts(player.publicKey, ref)).instruction();
    return this.sendTee("move_piece", [ComputeBudgetProgram.setComputeUnitLimit({ units: CU.declare }), ix], player);
  }

  /** Rollup. Declare an Engineer's Blast by `piece`. Whether it is an Engineer is decided by `resolve`; anything else costs the turn. */
  async blast(player: PlayerSigner, ref: TableRef, piece: number, seal: DeclareSeal): Promise<string> {
    const ix = await this.program.methods.blast(piece, seal.expectedSeq, seal.sealedSwitch).accountsPartial(this.declareAccounts(player.publicKey, ref)).instruction();
    return this.sendTee("blast", [ComputeBudgetProgram.setComputeUnitLimit({ units: CU.declare }), ix], player);
  }

  /** Rollup. Declare a Colonel's Rescue of the Truck by `piece`. Whether it is a Colonel with a Truck on the board is decided by `resolve`. */
  async rescue(player: PlayerSigner, ref: TableRef, piece: number, seal: DeclareSeal): Promise<string> {
    const ix = await this.program.methods.rescue(piece, seal.expectedSeq, seal.sealedSwitch).accountsPartial(this.declareAccounts(player.publicKey, ref)).instruction();
    return this.sendTee("rescue", [ComputeBudgetProgram.setComputeUnitLimit({ units: CU.declare }), ix], player);
  }

  /**
   * Rollup. Declare a pass, which counts as a missed turn. `sealedSlot` seals the Dig in (0 sealed is a plain pass): a
   * face-down Dig in is this very instruction, so nothing public tells the two apart.
   */
  async pass(player: PlayerSigner, ref: TableRef, seal: DeclareSeal & { sealedSlot: number }): Promise<string> {
    const ix = await this.program.methods.pass(seal.expectedSeq, seal.sealedSlot, seal.sealedSwitch).accountsPartial(this.declareAccounts(player.publicKey, ref)).instruction();
    return this.sendTee("pass", [ComputeBudgetProgram.setComputeUnitLimit({ units: CU.declare }), ix], player);
  }

  /** Rollup. Spend a banked Two-Step Turn before the first step of your turn. */
  async startTwoStep(player: PlayerSigner, ref: TableRef): Promise<string> {
    const ix = await this.program.methods.startTwoStep().accountsPartial(this.declareAccounts(player.publicKey, ref)).instruction();
    return this.sendTee("start_two_step", [ix], player);
  }

  /** The `claim_timeout` instruction, for a caller that simulates it first. */
  claimTimeoutIx(caller: PublicKey, ref: TableRef): Promise<TransactionInstruction> {
    const ad = addresses(ref);
    return this.program.methods
      .claimTimeout()
      .accountsPartial({ caller, table: ad.table, battle: ad.battle, army0: ad.army0, army1: ad.army1 } as any)
      .instruction();
  }

  /**
   * Rollup, permissionless. Once the turn's deadline has passed it declares a timeout (the turn is lost); past the
   * time cap it declares the tiebreak ending; past the start window or the setup windows it cancels (the ring gets a refund).
   * Declared timeouts are applied by `resolve`.
   */
  async claimTimeout(caller: PlayerSigner, ref: TableRef): Promise<string> {
    const ix = await this.claimTimeoutIx(caller.publicKey, ref);
    return this.sendTee("claim_timeout", [ComputeBudgetProgram.setComputeUnitLimit({ units: CU.declare }), ix], caller);
  }

  /**
   * Rollup, permissionless, no arguments. Applies the pending action (a declared move or timeout) in a slot after
   * its declare. Both Players' clients and the keeper send it as soon as the Battle shows a pending action; the
   * program refuses it in the declare's own slot (`TooSoon`), so a caller retries after a moment.
   */
  async resolve(caller: PlayerSigner, ref: TableRef): Promise<string> {
    const ad = addresses(ref);
    const ix = await this.program.methods
      .resolve()
      .accountsPartial({ caller: caller.publicKey, table: ad.table, battle: ad.battle, army0: ad.army0, army1: ad.army1 } as any)
      .instruction();
    return this.sendTee("resolve", [ComputeBudgetProgram.setComputeUnitLimit({ units: CU.resolve }), ix], caller);
  }

  // -- rollup: after the Match ---------------------------------------------------------------

  /**
   * Rollup, permissionless, once per result (the table is `dirty` until then). Commits the public table and its Battle to
   * Solana, paid by the Sponsor.
   */
  async commitTable(payer: PlayerSigner, ref: TableRef): Promise<string> {
    const ad = addresses(ref);
    const { teeValidator } = await this.readConfig();
    const ix = await this.program.methods
      .commitTable()
      .accountsPartial({
        caller: payer.publicKey,
        table: ad.table,
        battle: ad.battle,
        sponsor: sponsorPda(),
        vanguardConfig: configPda(),
        magicFeeVault: magicFeeVaultPda(teeValidator),
        magicContext: MAGIC_CONTEXT,
        magicProgram: MAGIC_PROGRAM_ID,
      } as any)
      .instruction();
    return this.sendTee("commit_table", [ComputeBudgetProgram.setComputeUnitLimit({ units: CU.commit }), ix], payer);
  }

  /** Rollup, permissionless, table scheduler (19t). Once the Match is over: zeroes both seats and swaps their permission members to nobody. */
  async wipeSeats(payer: PlayerSigner, ref: TableRef): Promise<string> {
    const ix = await this.program.methods.wipeSeats().accountsPartial(this.seatAccounts(payer.publicKey, ref)).instruction();
    return this.sendTee("wipe_seats", [ComputeBudgetProgram.setComputeUnitLimit({ units: CU.seats }), ix], payer);
  }

  /** Rollup, permissionless, table scheduler (19t). Wipes a finished, committed table with wiped seats and moves it to the next epoch. */
  async resetTable(payer: PlayerSigner, ref: TableRef): Promise<string> {
    const ad = addresses(ref);
    const ix = await this.program.methods.resetTable().accountsPartial({ caller: payer.publicKey, table: ad.table, battle: ad.battle } as any).instruction();
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
  async voidTable(payer: PlayerSigner, ref: TableRef, match: PublicKey): Promise<string> {
    const ad = addresses(ref);
    const ix = await this.program.methods
      .voidTable()
      .accountsPartial({ caller: payer.publicKey, table: ad.table, battle: ad.battle, receipt: settledPda(match) } as any)
      .instruction();
    return this.sendTee("void_table", [ix], payer);
  }

  /** Rollup, operator (19t). Moves lamports from a Fuel reserve into the Sponsor. */
  async refillSponsor(operator: PlayerSigner, fuel: number, amount: bigint): Promise<string> {
    const ix = await this.program.methods
      .refillSponsor(new anchor.BN(amount.toString()))
      .accountsPartial({ operator: operator.publicKey, tableConfig: tablesPda(), fuel: fuelPda(fuel), sponsor: sponsorPda() } as any)
      .instruction();
    return this.sendTee("refill_sponsor", [ix], operator);
  }
}
