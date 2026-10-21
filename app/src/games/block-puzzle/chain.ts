/**
 * On-chain client for Block Puzzle Matches (programs/block_puzzle + programs/tesoro_core).
 *
 * IDL-based: pass the two IDLs (`target/idl/block_puzzle.json`, `target/idl/tesoro_core.json`).
 * Needs `@coral-xyz/anchor`, `@solana/web3.js`, `@magicblock-labs/ephemeral-rollups-sdk` and
 * `tweetnacl` in the app.
 *
 * A Match is named by its MatchState address (`["match", opener Account, n]`, `MatchKey`); the
 * entry is drawn from the Account's basket into a Pot (a direct draw, or an Entry Ticket staged in
 * steps when the basket is fragmented).
 *
 * Lifecycle, in the order the app calls it (seat 0 opens the Match, seat 1 joins later):
 *   openMatch (also opens the Session) -> delegateOpener -> initVaultPermission + initPermission
 *   -> requestSeed (VRF, inside the TEE; the program picks the input) -> seedReady (poll) -> beginRun
 *   (returns the Seed) -> play (repeat) -> finish. The opener can play before anybody is paired.
 *   joinMatch (also joins the Session) -> delegateJoiner -> initPermission -> beginRun -> play -> finish.
 *   Then sealAndCommit (once both runs are closed) -> settle (starts the run) -> runChunks (anyone;
 *   pays out in chunks) -> closeMatch (rents back) -> fetchResult.
 * The Seed is never on the base layer: it lives in a SeedVault nobody can read and reaches a Player's
 * private Board only when their run begins.
 * A Player's `play` calls go to the private rollup (TEE); everything else to the base layer.
 * Scores are never sent: the program replays the moves with the same engine as `./engine.ts`.
 */
import { SIM_SOL_MINT, nativeCustodyPda } from "../../lib/chain/native";
import { gameAccounts, gameRecordPda, pairPda, programDataPda } from "../../lib/chain/game-record";
import {
  MAX_CHUNK_STEPS,
  MAX_DIRECT_LINES,
  MAX_STAGE_OPS,
  bookPda,
  basketPda,
  checkpointCandidates,
  countersPda,
  decodeLines,
  economyPda,
  eventAuthorityPda,
  matchAddress,
  potPayer,
  potSources,
  potSponsored,
  potTotal,
  protectionsPda,
  receiptPda,
  sponsorPda,
  spillPda,
  stageOf,
  ticketPda,
  type MatchStage,
} from "./match-accounts";
import { AnchorProvider, BN, Program, type Idl } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID,
  GetCommitmentSignature,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  getAuthToken,
  permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import { MAGICBLOCK } from "../../lib/cluster-settings";
import { TxFailedError, TxUnconfirmedError, txOutcome, type TxOutcome } from "./tx";

export { TxFailedError, TxUnconfirmedError, type TxOutcome };
export { batchOffsets, boardTiming, type BoardTiming, type MoveTiming } from "./move-timing";

export const BLOCK_PUZZLE_PROGRAM_ID = new PublicKey("5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj");
export const TESORO_CORE_PROGRAM_ID = new PublicKey("AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh");
export const TEE_RPC = MAGICBLOCK.teeRpc;
export const TEE_WS = MAGICBLOCK.teeWs;
export const TEE_VALIDATOR = new PublicKey(MAGICBLOCK.teeValidator);

const VRF_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
const EPHEMERAL_VAULT = new PublicKey("MagicVau1t999999999999999999999999999999999");
const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");

/** Mirrors programs/block_puzzle constants. */
export const PLAY_SECS = 90;
export const MAX_PLAY_BATCH = 40;

export type Move = { piece: number; x: number; y: number };
export type Seat = 0 | 1;

/** A Match is named by its MatchState address. */
export type MatchKey = PublicKey;
/** What the older callers still hold: a client-built Match id, which names nothing any more. */
export type LegacyMatchId = bigint;
const keyOf = (m: MatchKey | LegacyMatchId): PublicKey => {
  if (typeof m === "bigint") throw new Error("Matches are named by their MatchState address now (economy upgrade); this caller still holds a client-built id");
  return m;
};
/** Legacy transactions hold 1232 bytes. */
const TX_BYTES = 1232;

export type Result = "opener" | "joiner" | "draw";

export interface ChainSigner {
  publicKey: PublicKey;
  signTransaction(tx: Transaction): Promise<Transaction>;
  /** Signs a serialized transaction of either version, for the relayer's v0 messages. Missing: the signer cannot take part in sponsored transactions. */
  signSerialized?(tx: Uint8Array): Promise<Uint8Array>;
  /** Signs the TEE auth challenge (wallet `signMessage`). */
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

export function keypairSigner(kp: Keypair): ChainSigner {
  return {
    publicKey: kp.publicKey,
    signTransaction: async (tx) => {
      tx.partialSign(kp);
      return tx;
    },
    signMessage: async (m) => nacl.sign.detached(m, kp.secretKey),
  };
}

export interface ChainConfig {
  base: Connection;
  blockPuzzleIdl: Idl;
  coreIdl: Idl;
  teeRpc?: string;
  teeWs?: string;
  teeValidator?: PublicKey;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pk = (bytes: number[] | Uint8Array) => new PublicKey(Uint8Array.from(bytes));
const bn = (n: bigint | number) => new BN(n.toString());
/** A random pot nonce: unique per Account in practice (48 bits of entropy). */
const randomNonce = () => BigInt("0x" + Buffer.from(nacl.randomBytes(6)).toString("hex"));
/** Fee classes (Platform, Studio, Leaderboard) are never playable; the rest are. */
const FIRST_PLAYABLE_CLASS = 3;

/** An IDL program whose accounts are looked up by name at runtime (the IDLs are loaded as JSON). */
export type AnyProgram = Omit<Program<any>, "account"> & { account: Record<string, any> };

export class BlockPuzzleChain {
  readonly base: Connection;
  readonly bp: AnyProgram;
  readonly core: AnyProgram;
  private readonly teeRpc: string;
  private readonly teeWs: string;
  private readonly teeValidator: PublicKey;
  private readonly tees = new Map<string, Connection>();

  constructor(cfg: ChainConfig) {
    this.base = cfg.base;
    this.teeRpc = cfg.teeRpc ?? TEE_RPC;
    this.teeWs = cfg.teeWs ?? TEE_WS;
    this.teeValidator = cfg.teeValidator ?? TEE_VALIDATOR;
    // Read-only provider: transactions are built here and signed by the caller's signer.
    const provider = new AnchorProvider(
      cfg.base,
      { publicKey: Keypair.generate().publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t },
      { commitment: "confirmed" },
    );
    this.bp = new Program(cfg.blockPuzzleIdl, provider) as unknown as AnyProgram;
    this.core = new Program(cfg.coreIdl, provider) as unknown as AnyProgram;
  }

  // ---- addresses ----------------------------------------------------------------------------

  static coreAccount(authority: PublicKey) {
    return PublicKey.findProgramAddressSync([Buffer.from("account"), authority.toBuffer()], TESORO_CORE_PROGRAM_ID)[0];
  }
  /** An Account's basket and spill (ticket 08): PDAs of the Account, made by `create_account`. */
  static basket(account: PublicKey) {
    return PublicKey.findProgramAddressSync([Buffer.from("basket"), account.toBuffer()], TESORO_CORE_PROGRAM_ID)[0];
  }
  static spill(account: PublicKey) {
    return PublicKey.findProgramAddressSync([Buffer.from("spill"), account.toBuffer()], TESORO_CORE_PROGRAM_ID)[0];
  }
  static holding(account: PublicKey, source: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("holding"), account.toBuffer(), source.toBuffer()],
      TESORO_CORE_PROGRAM_ID,
    )[0];
  }
  static addresses(match: MatchKey | LegacyMatchId) {
    const matchKey = keyOf(match);
    const config = PublicKey.findProgramAddressSync([Buffer.from("config")], TESORO_CORE_PROGRAM_ID)[0];
    const bpPda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, BLOCK_PUZZLE_PROGRAM_ID)[0];
    const session = bpPda([Buffer.from("session"), matchKey.toBuffer()]);
    const board = (seat: Seat) => bpPda([Buffer.from("board"), session.toBuffer(), Buffer.from([seat])]);
    return {
      config,
      match: matchKey,
      session,
      vault: bpPda([Buffer.from("vault"), session.toBuffer()]),
      authority: bpPda([Buffer.from("authority")]),
      eventAuthority: bpPda([Buffer.from("__event_authority")]),
      boards: [board(0), board(1)] as [PublicKey, PublicKey],
    };
  }

  // ---- transport ----------------------------------------------------------------------------

  /** One TEE connection per Player: the auth token binds reads to that wallet. */
  /** True when this signer already has a rollup session, so reading through it asks for no signature. */
  hasTeeSession(signer: ChainSigner): boolean {
    return this.tees.has(signer.publicKey.toBase58());
  }

  async tee(signer: ChainSigner): Promise<Connection> {
    const k = signer.publicKey.toBase58();
    const cached = this.tees.get(k);
    if (cached) return cached;
    const { token } = await getAuthToken(this.teeRpc, signer.publicKey, (m: Uint8Array) => signer.signMessage(m));
    const conn = new Connection(`${this.teeRpc}?token=${token}`, {
      wsEndpoint: `${this.teeWs}?token=${token}`,
      commitment: "confirmed",
    });
    this.tees.set(k, conn);
    return conn;
  }

  async sendBase(signer: ChainSigner, ixs: TransactionInstruction[]): Promise<string> {
    const tx = new Transaction().add(...ixs);
    tx.feePayer = signer.publicKey;
    const { blockhash, lastValidBlockHeight } = await this.base.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    return this.sendSigned(await signer.signTransaction(tx), lastValidBlockHeight);
  }

  /**
   * Sends a fully signed base-layer transaction and waits for it to confirm. Once sent, it throws
   * only `TxFailedError` (landed and failed) or `TxUnconfirmedError` (may still land: see `txOutcome`).
   */
  async sendSigned(signed: Transaction, lastValidBlockHeight?: number): Promise<string> {
    const raw = signed.serialize();
    const sig = await this.base.sendRawTransaction(raw, { skipPreflight: true });
    // Poll instead of websockets: works through any RPC proxy.
    let err: unknown = null;
    let landed = false;
    for (let i = 0; i < 90 && !landed; i++) {
      try {
        if (i % 10 === 9) await this.base.sendRawTransaction(raw, { skipPreflight: true }).catch(() => undefined);
        const st = (await this.base.getSignatureStatuses([sig])).value[0];
        if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
          landed = true;
          err = st.err;
          continue;
        }
      } catch {
        // A failed status read says nothing about the transaction: keep waiting.
      }
      await sleep(500);
    }
    if (!landed) throw new TxUnconfirmedError(sig, lastValidBlockHeight);
    if (err) {
      const t = await this.base.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
      throw new TxFailedError(sig, err, t?.meta?.logMessages ?? []);
    }
    return sig;
  }

  /** What became of a base-layer transaction that threw `TxUnconfirmedError`. */
  txOutcome(e: TxUnconfirmedError): Promise<TxOutcome> {
    return txOutcome(this.base, e.sig, e.lastValidBlockHeight);
  }

  async sendTee(signer: ChainSigner, ixs: TransactionInstruction[]): Promise<string> {
    const conn = await this.tee(signer);
    const tx = new Transaction().add(...ixs);
    tx.feePayer = signer.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    const signed = await signer.signTransaction(tx);
    const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
    for (let i = 0; i < 60; i++) {
      const st = (await conn.getSignatureStatuses([sig])).value[0];
      if (st) {
        if (st.err) {
          const t = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
          throw new Error(`tee tx failed ${sig}: ${JSON.stringify(st.err)}\n${t?.meta?.logMessages?.join("\n") ?? ""}`);
        }
        return sig;
      }
      await sleep(500);
    }
    throw new Error(`tee tx not confirmed ${sig}`);
  }

  private async waitOwner(account: PublicKey, owner: PublicKey, tries = 60) {
    for (let i = 0; i < tries; i++) {
      const info = await this.base.getAccountInfo(account).catch(() => null);
      if (info?.owner.equals(owner)) return true;
      await sleep(1000);
    }
    return false;
  }

  // ---- tesoro_core: baskets, Tickets, create and join ---------------------------------------

  private async storeData(account: PublicKey) {
    const [basket, spill] = await this.base.getMultipleAccountsInfo([basketPda(account), spillPda(account)]);
    if (!basket || !spill) throw new Error("This Account has no basket yet. Create the Account first.");
    return { basket: basket.data, spill: spill.data };
  }

  /** The Account's playable lines (own and won, fee classes excluded), basket then spill. */
  private async playableLines(account: PublicKey) {
    const { basket, spill } = await this.storeData(account);
    return [...decodeLines(basket, 8), ...decodeLines(spill, 8)].filter((l) => l.class >= FIRST_PLAYABLE_CLASS && l.amount > 0n);
  }

  /** Slots of a spill that are free for new lines (not held for Matches in flight). */
  private spillFree(spill: Uint8Array): number {
    const buf = Buffer.from(spill.buffer, spill.byteOffset, spill.byteLength);
    const capacity = Math.floor((buf.length - 8 - 128) / 144);
    const first = buf.readUInt32LE(8 + 92);
    const len = buf.readUInt32LE(8 + 4);
    const reserved = buf.readUInt32LE(8 + 88);
    return capacity - first - len - reserved;
  }

  /** Anyone may grow an Account's spill. A Match holds room in the spills for every credit it may make, so open and join need it free. */
  async ensureSpillRoom(payer: ChainSigner, account: PublicKey, free: number) {
    const { spill } = await this.storeData(account);
    let need = free - this.spillFree(spill);
    while (need > 0) {
      const extra = Math.min(need, 70);
      const ix = await this.core.methods
        .growStore({ spill: {} }, extra)
        .accountsPartial({ payer: payer.publicKey, account, basket: basketPda(account), spill: spillPda(account), systemProgram: SystemProgram.programId })
        .instruction();
      await this.sendBase(payer, [ix]);
      need -= extra;
    }
  }

  /** The distinct Sources of the Account's lines, as the books an entry's draw or staging may touch. */
  private async bookAccounts(sources: PublicKey[]) {
    const metas: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
    for (const src of sources) {
      const candidates = [bookPda(src), ...checkpointCandidates(src)];
      const infos = await this.base.getMultipleAccountsInfo(candidates);
      candidates.forEach((pubkey, i) => {
        if (infos[i]) metas.push({ pubkey, isSigner: false, isWritable: true });
      });
    }
    return metas;
  }

  /**
   * Gets the entry out of the basket into a Pot: a direct draw when the Account has at most
   * MAX_DIRECT_LINES playable lines (the Pot is made by open/join itself), else an Entry Ticket
   * staged in steps first. Returns the Pot's address and the `pot_lines` argument.
   */
  private async preparePot(signer: ChainSigner, account: PublicKey, entry: bigint, game: PublicKey) {
    const lines = await this.playableLines(account);
    const nonce = randomNonce();
    const pot = ticketPda(account, nonce);
    if (lines.length <= MAX_DIRECT_LINES) {
      return { pot, nonce, potLines: Math.max(1, lines.length), remaining: await this.bookAccounts(distinct(lines.map((l) => l.source)).slice(0, 4)), ticket: false };
    }
    const ticketLines = Math.min(lines.length, 68);
    const open = await this.core.methods
      .openTicket(bn(nonce), { entry: {} }, game, bn(entry), ticketLines)
      .accountsPartial({
        payer: signer.publicKey,
        authority: signer.publicKey,
        requester: account,
        owner: account,
        basket: basketPda(account),
        spill: spillPda(account),
        ticket: pot,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    await this.sendBase(signer, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), open]);
    const books = await this.bookAccounts(distinct(lines.map((l) => l.source)).slice(0, 6));
    let last = -1n;
    for (let i = 0; i < 40; i++) {
      const info = await this.base.getAccountInfo(pot);
      const staged = info ? potTotal(info.data) : 0n;
      if (staged >= entry) break;
      if (staged === last) throw new Error("Staging the entry made no progress");
      last = staged;
      const stage = await this.core.methods
        .stageEntry(MAX_STAGE_OPS)
        .accountsPartial({ signer: signer.publicKey, owner: account, basket: basketPda(account), spill: spillPda(account), ticket: pot })
        .remainingAccounts(books)
        .instruction();
      await this.sendBase(signer, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), stage]);
    }
    return { pot, nonce, potLines: 1, remaining: [], ticket: true };
  }

  /** The number the Account's next Match gets (its own counter). */
  private async nextMatchNumber(account: PublicKey): Promise<bigint> {
    const counters: any = await this.core.account.accountCounters.fetchNullable(countersPda(account));
    return counters ? BigInt(counters.nextMatch.toString()) : 0n;
  }

  /**
   * Seat 0 opens a Match for `game` and draws `entry` Gemas from their basket into a Pot (for Block
   * Puzzle also its Session). `challenge` marks a Match made for a friend; `asset` is Trading
   * Duel's market. Returns the Match's address.
   */
  async openMatch(signer: ChainSigner, entry: number | bigint, opts: { game?: PublicKey; challenge?: boolean; asset?: number } = {}) {
    const game = opts.game ?? BLOCK_PUZZLE_PROGRAM_ID;
    const entryAmount = BigInt(entry);
    const account = BlockPuzzleChain.coreAccount(signer.publicKey);
    const n = await this.nextMatchNumber(account);
    const match = matchAddress(account, n);
    const prepared = await this.preparePot(signer, account, entryAmount, game);
    await this.ensureSpillRoom(signer, account, prepared.potLines * 2 + 4);
    const ix = await this.core.methods
      .openMatch(game, bn(entryAmount), bn(n), bn(prepared.nonce), opts.challenge ?? false, opts.asset ?? 0, prepared.potLines)
      .accountsPartial({
        payer: signer.publicKey,
        playerAuthority: signer.publicKey,
        config: BlockPuzzleChain.addresses(match).config,
        economy: economyPda(),
        ...gameAccounts(game),
        playerAccount: account,
        counters: countersPda(account),
        protections: protectionsPda(account),
        basket: basketPda(account),
        spill: spillPda(account),
        pot: prepared.pot,
        matchState: match,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(prepared.remaining)
      .instruction();
    const budget = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
    if (!game.equals(BLOCK_PUZZLE_PROGRAM_ID)) return { match, n, sig: await this.sendBase(signer, [budget, ix]) };
    const session = await this.openSessionIx(signer.publicKey, match, signer.publicKey);
    return { match, n, sig: await this.sendBaseFit(signer, [budget, ix], [session]) };
  }

  /** The Account that opened the Match. */
  async openerAccount(matchId: MatchKey | LegacyMatchId): Promise<PublicKey> {
    const m = await this.core.account.matchState.fetch(BlockPuzzleChain.addresses(matchId).match);
    return new PublicKey(Uint8Array.from(m.inner.a.player));
  }

  /** The Protections address of the Account that opened the Match (a Player on a Break or Self-Excluded cannot be joined or kept waiting). */
  async openerProtections(matchId: MatchKey | LegacyMatchId): Promise<PublicKey> {
    return protectionsPda(await this.openerAccount(matchId));
  }

  /** The record of the Game the Match was opened for (refunds go through whichever Game it is). */
  async gameRecordOf(matchId: MatchKey | LegacyMatchId): Promise<PublicKey> {
    const m = await this.core.account.matchState.fetch(BlockPuzzleChain.addresses(matchId).match);
    return gameRecordPda(pk(m.inner.game));
  }

  /** Seat 1 joins with an equal entry, drawn into their own Pot; for Block Puzzle also binds to the Session. */
  async joinMatch(signer: ChainSigner, matchId: MatchKey | LegacyMatchId, game: PublicKey = BLOCK_PUZZLE_PROGRAM_ID) {
    const a = BlockPuzzleChain.addresses(matchId);
    const m: any = await this.core.account.matchState.fetch(a.match);
    const opener = pk(m.inner.a.player);
    const openerFunder = pk(m.inner.a.funder);
    const joiner = BlockPuzzleChain.coreAccount(signer.publicKey);
    const prepared = await this.preparePot(signer, joiner, BigInt(m.inner.entry.toString()), game);
    const room = Number(m.inner.potLines[0]) + prepared.potLines + 2;
    for (const who of [joiner, opener, openerFunder]) await this.ensureSpillRoom(signer, who, room);
    const ix = await this.core.methods
      .joinMatch(bn(prepared.nonce), prepared.potLines)
      .accountsPartial({
        payer: signer.publicKey,
        playerAuthority: signer.publicKey,
        playerAccount: joiner,
        counters: countersPda(joiner),
        protections: protectionsPda(joiner),
        basket: basketPda(joiner),
        spill: spillPda(joiner),
        pot: prepared.pot,
        matchState: a.match,
        openerProtections: protectionsPda(opener),
        openerSpill: spillPda(opener),
        openerFunderSpill: spillPda(openerFunder),
        pair: pairPda(opener, joiner),
        ...gameAccounts(game),
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(prepared.remaining)
      .instruction();
    const budget = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
    if (!game.equals(BLOCK_PUZZLE_PROGRAM_ID)) return this.sendBase(signer, [budget, ix]);
    const session = await this.joinSessionIx(signer.publicKey, a.match, joiner);
    return this.sendBaseFit(signer, [budget, ix], [session]);
  }

  /** One transaction when it fits in 1232 bytes, else the extra instructions in a second one. */
  private async sendBaseFit(signer: ChainSigner, first: TransactionInstruction[], then: TransactionInstruction[]): Promise<string> {
    const probe = new Transaction().add(...first, ...then);
    probe.feePayer = signer.publicKey;
    probe.recentBlockhash = "11111111111111111111111111111111";
    let fits = true;
    try {
      fits = probe.serialize({ requireAllSignatures: false, verifySignatures: false }).length <= TX_BYTES;
    } catch {
      fits = false;
    }
    if (fits) return this.sendBase(signer, [...first, ...then]);
    await this.sendBase(signer, first);
    return this.sendBase(signer, then);
  }

  // ---- session, delegation and the hidden Seed ----------------------------------------------

  /** Base layer, anyone. Binds the Session, the opener's Board and the SeedVault to an Open Match. */
  async openSessionIx(payer: PublicKey, matchId: MatchKey | LegacyMatchId, opener: PublicKey) {
    const a = BlockPuzzleChain.addresses(matchId);
    return this.bp.methods
      .openSession()
      .accountsPartial({
        payer,
        matchState: a.match,
        accountA: BlockPuzzleChain.coreAccount(opener),
        session: a.session,
        board0: a.boards[0],
        vault: a.vault,
        authority: a.authority,
        tesoroCoreProgram: TESORO_CORE_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  /** Base layer, anyone (`accountB` is the joiner's TesoroAccount). Creates their Board and extends the Match's refund deadline. */
  async joinSessionIx(payer: PublicKey, matchId: MatchKey | LegacyMatchId, accountB: PublicKey) {
    const a = BlockPuzzleChain.addresses(matchId);
    return this.bp.methods
      .joinSession()
      .accountsPartial({
        payer,
        session: a.session,
        matchState: a.match,
        accountB,
        board1: a.boards[1],
        authority: a.authority,
        tesoroCoreProgram: TESORO_CORE_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  /** Anyone. Moves the opener's Board and the SeedVault to the TEE validator. */
  async delegateOpener(payer: ChainSigner, matchId: MatchKey | LegacyMatchId) {
    const a = BlockPuzzleChain.addresses(matchId);
    const ix = await this.bp.methods
      .delegateOpener()
      .accountsPartial({ payer: payer.publicKey, session: a.session, board0: a.boards[0], vault: a.vault, validator: this.teeValidator })
      .instruction();
    const sig = await this.sendBase(payer, [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ix]);
    const ok = (await this.waitOwner(a.boards[0], DELEGATION_PROGRAM_ID)) && (await this.waitOwner(a.vault, DELEGATION_PROGRAM_ID));
    if (!ok) throw new Error("opener accounts were not delegated");
    await sleep(4000);
    return sig;
  }

  /** Anyone, once a second Player joined. Moves the joiner's Board to the TEE validator. */
  async delegateJoiner(payer: ChainSigner, matchId: MatchKey | LegacyMatchId) {
    const a = BlockPuzzleChain.addresses(matchId);
    const ix = await this.bp.methods
      .delegateJoiner()
      .accountsPartial({ payer: payer.publicKey, session: a.session, board1: a.boards[1], validator: this.teeValidator })
      .instruction();
    const sig = await this.sendBase(payer, [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ix]);
    if (!(await this.waitOwner(a.boards[1], DELEGATION_PROGRAM_ID))) throw new Error("joiner Board was not delegated");
    await sleep(4000);
    return sig;
  }

  /** In the TEE. Makes a Board readable only by its Player. */
  async initPermission(signer: ChainSigner, matchId: MatchKey | LegacyMatchId, seat: Seat) {
    const board = BlockPuzzleChain.addresses(matchId).boards[seat];
    const ix = await this.bp.methods
      .initPermission()
      .accountsPartial({
        payer: signer.publicKey,
        board,
        permission: permissionPdaFromAccount(board),
        permissionProgram: PERMISSION_PROGRAM_ID,
        ephemeralVault: EPHEMERAL_VAULT,
        magicProgram: MAGIC_PROGRAM_ID,
      })
      .instruction();
    return this.sendTee(signer, [ix]);
  }

  /** In the TEE. Makes the SeedVault unreadable by every wallet (private, zero members). */
  async initVaultPermission(signer: ChainSigner, matchId: MatchKey | LegacyMatchId) {
    const vault = BlockPuzzleChain.addresses(matchId).vault;
    const ix = await this.bp.methods
      .initVaultPermission()
      .accountsPartial({
        payer: signer.publicKey,
        vault,
        permission: permissionPdaFromAccount(vault),
        permissionProgram: PERMISSION_PROGRAM_ID,
        ephemeralVault: EPHEMERAL_VAULT,
        magicProgram: MAGIC_PROGRAM_ID,
      })
      .instruction();
    return this.sendTee(signer, [ix]);
  }

  /**
   * In the TEE, anyone. Asks the VRF oracle for the Seed; the callback writes it into the SeedVault
   * only. The program picks the VRF input and accepts only the answer to its current request; a
   * second request is refused until `SEED_RETRY_SLOTS` (600 rollup slots, about 30 s) have passed.
   */
  async requestSeed(signer: ChainSigner, matchId: MatchKey | LegacyMatchId) {
    const vault = BlockPuzzleChain.addresses(matchId).vault;
    const ix = await this.bp.methods
      .requestSeed()
      .accountsPartial({ payer: signer.publicKey, vault, oracleQueue: VRF_QUEUE } as any)
      .instruction();
    return this.sendTee(signer, [ix]);
  }

  /** In the TEE. True once the Seed is drawn. Reveals nothing: the SeedVault cannot be read. */
  async seedReady(signer: ChainSigner, matchId: MatchKey | LegacyMatchId): Promise<boolean> {
    const vault = BlockPuzzleChain.addresses(matchId).vault;
    const ix = await this.bp.methods.checkSeed().accountsPartial({ payer: signer.publicKey, vault }).instruction();
    try {
      await this.sendTee(signer, [ix]);
      return true;
    } catch {
      return false;
    }
  }

  // ---- play (all in the TEE, by the Player) -------------------------------------------------

  /**
   * Starts the Player's 90 s clock. The program copies the Seed into the Player's own private Board
   * in the same transaction; this returns it (read from that Board), which is the first moment the
   * Player can know the piece sequence.
   */
  async beginRun(signer: ChainSigner, matchId: MatchKey | LegacyMatchId, seat: Seat): Promise<{ sig: string; seed: bigint }> {
    const a = BlockPuzzleChain.addresses(matchId);
    const ix = await this.bp.methods
      .beginRun()
      .accountsPartial({ player: signer.publicKey, board: a.boards[seat], vault: a.vault })
      .instruction();
    const sig = await this.sendTee(signer, [ix]);
    for (let i = 0; i < 20; i++) {
      const board = await this.fetchOwnBoard(signer, matchId, seat);
      if (board && !board.seed.isZero()) return { sig, seed: BigInt(board.seed.toString()) };
      await sleep(300);
    }
    throw new Error("Your pieces aren’t ready yet. Try again in a moment.");
  }

  /** Submits moves in batches of at most 40; an illegal move fails its whole batch. */
  async play(signer: ChainSigner, matchId: MatchKey | LegacyMatchId, seat: Seat, moves: Move[]): Promise<string[]> {
    const board = BlockPuzzleChain.addresses(matchId).boards[seat];
    const sigs: string[] = [];
    for (let i = 0; i < moves.length; i += MAX_PLAY_BATCH) {
      const ix = await this.bp.methods
        .play(moves.slice(i, i + MAX_PLAY_BATCH))
        .accountsPartial({ player: signer.publicKey, board })
        .instruction();
      sigs.push(await this.sendTee(signer, [ix]));
    }
    return sigs;
  }

  async finish(signer: ChainSigner, matchId: MatchKey | LegacyMatchId, seat: Seat) {
    const board = BlockPuzzleChain.addresses(matchId).boards[seat];
    const ix = await this.bp.methods.finish().accountsPartial({ player: signer.publicKey, board }).instruction();
    return this.sendTee(signer, [ix]);
  }

  /** A Player reads their own Board in the TEE (null for anyone else). Never call for the opponent. */
  async fetchOwnBoard(signer: ChainSigner, matchId: MatchKey | LegacyMatchId, seat: Seat) {
    const conn = await this.tee(signer);
    const board = BlockPuzzleChain.addresses(matchId).boards[seat];
    const info = await conn.getAccountInfo(board).catch(() => null);
    return info ? (this.bp.coder.accounts.decode("board", info.data) as any) : null;
  }

  /**
   * Anyone, once both runs are closed (or the submission deadline passed: the permissionless
   * timeout). Seals both Boards, closes their permissions and commits + undelegates them.
   * Waits for the Boards to be back on the base layer and returns the commit signature.
   */
  async sealAndCommit(payer: ChainSigner, matchId: MatchKey | LegacyMatchId, onSent?: () => void): Promise<{ teeSig: string; commitSig?: string }> {
    const a = BlockPuzzleChain.addresses(matchId);
    const seal = await this.bp.methods
      .seal()
      .accountsPartial({ payer: payer.publicKey, board0: a.boards[0], board1: a.boards[1] })
      .instruction();
    const commit = await this.bp.methods
      .commitBoards()
      .accountsPartial({
        payer: payer.publicKey,
        board0: a.boards[0],
        board1: a.boards[1],
        vault: a.vault,
        permission0: permissionPdaFromAccount(a.boards[0]),
        permission1: permissionPdaFromAccount(a.boards[1]),
        vaultPermission: permissionPdaFromAccount(a.vault),
        permissionProgram: PERMISSION_PROGRAM_ID,
        ephemeralVault: EPHEMERAL_VAULT,
        magicProgram: MAGIC_PROGRAM_ID,
        magicContext: MAGIC_CONTEXT,
      })
      .instruction();
    const teeSig = await this.sendTee(payer, [seal, commit]);
    onSent?.();
    const back = (await this.waitOwner(a.boards[0], BLOCK_PUZZLE_PROGRAM_ID)) && (await this.waitOwner(a.boards[1], BLOCK_PUZZLE_PROGRAM_ID)) && (await this.waitOwner(a.vault, BLOCK_PUZZLE_PROGRAM_ID));
    if (!back) throw new Error("boards did not return to the base layer");
    const commitSig = await GetCommitmentSignature(teeSig, await this.tee(payer)).catch(() => undefined);
    return { teeSig, commitSig };
  }

  // ---- settlement ---------------------------------------------------------------------------

  /**
   * Anyone. Starts the settlement through tesoro_core from the committed Boards (the program picks
   * the winner) and writes the receipt. The payouts follow in chunks: `runChunks`, then `closeMatch`.
   */
  async settle(payer: ChainSigner, matchId: MatchKey | LegacyMatchId) {
    const a = BlockPuzzleChain.addresses(matchId);
    const [b0, b1]: any[] = await Promise.all(a.boards.map((b) => this.bp.account.board.fetch(b)));
    const result = decide([b0.startedAt.isZero(), b1.startedAt.isZero()], [b0.score, b1.score]);
    const ix = await this.bp.methods.settle().accountsPartial(this.settleAccounts(payer, a)).instruction();
    return { sig: await this.sendBase(payer, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix]), result };
  }

  /** tesoro_core `refund_match`: the opener of an unjoined Match, anyone after the deadline. Starts the refund; `runChunks` and `closeMatch` finish it. */
  async refundMatch(caller: ChainSigner, matchId: MatchKey | LegacyMatchId) {
    const a = BlockPuzzleChain.addresses(matchId);
    const m: any = await this.core.account.matchState.fetch(a.match);
    const game = pk(m.inner.game);
    const ix = await this.core.methods
      .refundMatch()
      .accountsPartial({
        caller: caller.publicKey,
        payer: caller.publicKey,
        ...gameAccounts(game),
        matchState: a.match,
        receipt: receiptPda(a.match),
        openerProtections: protectionsPda(pk(m.inner.a.player)),
        systemProgram: SystemProgram.programId,
        eventAuthority: eventAuthorityPda(),
        program: TESORO_CORE_PROGRAM_ID,
      })
      .instruction();
    return this.sendBase(caller, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix]);
  }

  /** Anyone, after the submission deadline, for a joined Match whose Boards were never delegated. Starts refunding both; `runChunks` and `closeMatch` finish it. */
  async claimTimeout(payer: ChainSigner, matchId: MatchKey | LegacyMatchId) {
    const a = BlockPuzzleChain.addresses(matchId);
    const ix = await this.bp.methods.claimTimeout().accountsPartial(this.settleAccounts(payer, a)).instruction();
    return this.sendBase(payer, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix]);
  }

  private settleAccounts(payer: ChainSigner, a: ReturnType<typeof BlockPuzzleChain.addresses>) {
    return {
      payer: payer.publicKey,
      session: a.session,
      board0: a.boards[0],
      board1: a.boards[1],
      authority: a.authority,
      config: a.config,
      gameRecord: gameRecordPda(BLOCK_PUZZLE_PROGRAM_ID),
      matchState: a.match,
      gameProgram: BLOCK_PUZZLE_PROGRAM_ID,
      programData: programDataPda(BLOCK_PUZZLE_PROGRAM_ID),
      receipt: receiptPda(a.match),
      systemProgram: SystemProgram.programId,
      coreEventAuthority: eventAuthorityPda(),
      tesoroCoreProgram: TESORO_CORE_PROGRAM_ID,
      eventAuthority: a.eventAuthority,
      program: BLOCK_PUZZLE_PROGRAM_ID,
    };
  }

  /** The Accounts that get paid (or refunded) in a Match: both sides, their funders and an outside Studio. */
  private owners(m: any): PublicKey[] {
    const out: PublicKey[] = [];
    const add = (k: PublicKey) => {
      if (!out.some((o) => o.equals(k))) out.push(k);
    };
    add(pk(m.inner.a.player));
    add(pk(m.inner.a.funder));
    if (m.inner.b) {
      add(pk(m.inner.b.player));
      add(pk(m.inner.b.funder));
    }
    if (m.inner.terms.studioOwner) add(pk(m.inner.terms.studioOwner));
    return out;
  }

  /**
   * The accounts one settlement chunk reads and writes besides the Match and its Pots: every
   * credited Account's basket and spill, and for each Source with Gemas left in the Pots its book
   * (with checkpoint pages), SourceState and Position, plus the custody and rate account of the
   * Position's kind. A superset of the program's next-steps list (see `potSources`).
   */
  private async chunkAccounts(m: any, potData: (Uint8Array | null)[]) {
    const meta = (pubkey: PublicKey, isWritable: boolean) => ({ pubkey, isSigner: false, isWritable });
    const out = [];
    for (const o of this.owners(m)) out.push(meta(basketPda(o), true), meta(spillPda(o), true));
    const sources = potSources(potData);
    const states: any[] = sources.length ? await this.core.account.sourceState.fetchMultiple(sources) : [];
    const positions: PublicKey[] = states.map((s, i) => {
      if (!s) throw new Error(`Source ${sources[i].toBase58()} not found`);
      return pk(s.inner.position);
    });
    const positionStates: any[] = positions.length ? await this.core.account.positionState.fetchMultiple(positions) : [];
    const extra = new Map<string, PublicKey>();
    for (const p of positionStates) {
      if (!p) continue;
      const solana = "solana" in p.inner.sourceChain;
      const asset = pk(p.inner.sourceAsset);
      if (!solana) continue;
      if (asset.equals(SIM_SOL_MINT)) {
        const custody = nativeCustodyPda();
        extra.set(custody.toBase58(), custody);
        const c: any = await this.core.account.nativeCustody.fetch(custody);
        extra.set(c.pool.toBase58(), c.pool);
      } else if (!new BN(p.inner.stakeRateOpen.toString()).isZero()) {
        const custody = PublicKey.findProgramAddressSync([Buffer.from("stake_custody"), asset.toBuffer()], TESORO_CORE_PROGRAM_ID)[0];
        extra.set(custody.toBase58(), custody);
        const c: any = await this.core.account.stakeCustody.fetch(custody);
        extra.set(c.pool.toBase58(), c.pool);
      }
    }
    for (let i = 0; i < sources.length; i++) {
      out.push(...(await this.bookAccounts([sources[i]])), meta(sources[i], false), meta(positions[i], true));
    }
    for (const k of extra.values()) out.push(meta(k, false));
    return out;
  }

  /** The Pot accounts of a Match that have been made (side B only once somebody joined). */
  private potKeys(m: any): PublicKey[] {
    return (m.pots as PublicKey[]).filter((k) => !k.equals(PublicKey.default));
  }

  /** Anyone. One `match_chunk` of at most `steps` steps. Returns false once the run is complete. */
  async chunk(caller: ChainSigner, matchId: MatchKey | LegacyMatchId, steps = MAX_CHUNK_STEPS): Promise<boolean> {
    const a = BlockPuzzleChain.addresses(matchId);
    const m: any = await this.core.account.matchState.fetch(a.match);
    if (stageOf(m.inner.stage) === "closed") return false;
    const pots = this.potKeys(m);
    const potData = (await this.base.getMultipleAccountsInfo(pots)).map((i) => i?.data ?? null);
    const remaining = await this.chunkAccounts(m, potData);
    const ix = await this.core.methods
      .matchChunk(steps)
      .accountsPartial({
        caller: caller.publicKey,
        matchState: a.match,
        potA: pots[0],
        potB: pots[1] ?? null,
        eventAuthority: eventAuthorityPda(),
        program: TESORO_CORE_PROGRAM_ID,
      })
      .remainingAccounts(remaining)
      .instruction();
    await this.sendBase(caller, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix]);
    return true;
  }

  /** Anyone. Chunks until the Settling or Refunding run is complete (the Match is then Closed). */
  async runChunks(caller: ChainSigner, matchId: MatchKey | LegacyMatchId, steps = MAX_CHUNK_STEPS): Promise<MatchStage> {
    const a = BlockPuzzleChain.addresses(matchId);
    for (let i = 0; i < 200; i++) {
      const m: any = await this.core.account.matchState.fetch(a.match);
      const stage = stageOf(m.inner.stage);
      if (stage === "closed") return stage;
      if (stage !== "settling" && stage !== "refunding") throw new Error(`The Match is ${stage}: no settlement is running`);
      await this.chunk(caller, a.match, steps);
    }
    throw new Error("The settlement did not finish in 200 chunks");
  }

  /** Anyone, once the Match is Closed: gives the account rents back and frees the opener's and joiner's Match slots. */
  async closeMatch(caller: ChainSigner, matchId: MatchKey | LegacyMatchId) {
    const a = BlockPuzzleChain.addresses(matchId);
    const m: any = await this.core.account.matchState.fetch(a.match);
    const pots = this.potKeys(m);
    const potInfos = await this.base.getMultipleAccountsInfo(pots);
    const payers = potInfos.map((i) => (i ? potPayer(i.data) : PublicKey.default));
    const sponsored = potInfos.some((i) => i && potSponsored(i.data) > 0n);
    const remaining = [
      ...this.owners(m).map((o) => ({ pubkey: spillPda(o), isSigner: false, isWritable: true })),
      { pubkey: countersPda(pk(m.inner.a.player)), isSigner: false, isWritable: true },
      ...(m.inner.b ? [{ pubkey: countersPda(pk(m.inner.b.player)), isSigner: false, isWritable: true }] : []),
    ];
    const ix = await this.core.methods
      .closeMatch()
      .accountsPartial({
        caller: caller.publicKey,
        matchState: a.match,
        matchPayer: m.payer,
        potA: pots[0],
        potAPayer: payers[0],
        potB: pots[1] ?? null,
        potBPayer: pots[1] ? payers[1] : null,
        sponsor: sponsored ? sponsorPda() : null,
      })
      .remainingAccounts(remaining)
      .instruction();
    return this.sendBase(caller, [ix]);
  }

  // ---- results ------------------------------------------------------------------------------

  async fetchSession(matchId: MatchKey | LegacyMatchId) {
    return this.bp.account.session.fetch(BlockPuzzleChain.addresses(matchId).session) as Promise<any>;
  }

  /** Public result: readable by anyone once settled (and each Board's move log after commit). */
  async fetchResult(matchId: MatchKey | LegacyMatchId) {
    const s = await this.fetchSession(matchId);
    const m: any = await this.core.account.matchState.fetch(BlockPuzzleChain.addresses(matchId).match);
    return {
      settled: s.settled as boolean,
      result: (["opener", "joiner", "draw"] as const)[s.result as number],
      scores: (s.scores as number[]).map(Number) as [number, number],
      matchStatus: stageOf(m.inner.stage),
      seed: BigInt(s.seed.toString()),
      deadline: Number(s.deadline.toString()),
    };
  }
}

/** Same rule as the program: a Player who never began forfeits; higher score wins; equal draws. */
export function decide(forfeited: [boolean, boolean], scores: [number, number]): Result {
  if (forfeited[0] && forfeited[1]) return "draw";
  if (forfeited[0]) return "joiner";
  if (forfeited[1]) return "opener";
  return scores[0] > scores[1] ? "opener" : scores[0] < scores[1] ? "joiner" : "draw";
}

const distinct = (keys: PublicKey[]) => keys.filter((k, i) => keys.findIndex((o) => o.equals(k)) === i);
