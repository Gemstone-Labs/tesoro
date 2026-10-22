/**
 * On-chain client for the Hold'em Game (programs/holdem).
 *
 * Layers: the tesoro_core Match is opened and joined on the base layer (Solana devnet). The table
 * (`GameMatch`), the hidden Deck and the two Hole accounts are delegated to the MagicBlock
 * private rollup (TEE); every gameplay call goes there, authenticated with a token the Player
 * signs for. `finalize` runs on the base layer once the rollup has committed the result.
 *
 * The client is IDL-based and takes the two IDLs (`target/idl/holdem.json`,
 * `target/idl/tesoro_core.json`) as arguments so it does not depend on how the app bundles JSON.
 * Runtime dependencies: `@coral-xyz/anchor`, `@solana/web3.js` (v1), `@magicblock-labs/ephemeral-rollups-sdk`,
 * `tweetnacl` (only for the Keypair adapter).
 *
 * Privacy: `readOwnHole` works only for the Player's own Hole account; every other read of a
 * hidden account returns `null` (indistinguishable from "does not exist"), never an RPC error.
 */
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
  GetCommitmentSignature,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  getAuthToken,
  permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import { gameAccounts, gameRecordPda } from "../../lib/chain/game-record";
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

export interface Addresses {
  gameMatch: PublicKey;
  deck: PublicKey;
  hole0: PublicKey;
  hole1: PublicKey;
  authority: PublicKey;
}

/** PDAs of one table. `match` is the address of the tesoro_core Match (`["match", opener, n]`). */
export function addresses(match: PublicKey): Addresses {
  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, HOLDEM_PROGRAM_ID)[0];
  const gameMatch = pda([Buffer.from("match"), match.toBuffer()]);
  return {
    gameMatch,
    deck: pda([Buffer.from("deck"), gameMatch.toBuffer()]),
    hole0: pda([Buffer.from("hole"), gameMatch.toBuffer(), Buffer.from([0])]),
    hole1: pda([Buffer.from("hole"), gameMatch.toBuffer(), Buffer.from([1])]),
    authority: PublicKey.findProgramAddressSync([Buffer.from("authority")], HOLDEM_PROGRAM_ID)[0],
  };
}

const tesoroPda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, TESORO_CORE_PROGRAM_ID)[0];
export const tesoroAccountPda = (authority: PublicKey) => tesoroPda([Buffer.from("account"), authority.toBuffer()]);
export const tesoroConfigPda = () => tesoroPda([Buffer.from("config")]);
export const settledPda = (match: PublicKey) => tesoroPda([Buffer.from("settled"), match.toBuffer()]);
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

// ---------------------------------------------------------------------------------------------
// Decoded state

export interface Table {
  address: PublicKey;
  tesoroMatch: PublicKey;
  /** seat 0 opened the tesoro_core Match, seat 1 joined */
  players: [PublicKey, PublicKey];
  speed: number;
  status: number;
  finalized: boolean;
  winner: number;
  startDeadline: number;
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
}

const big = (n: anchor.BN) => BigInt(n.toString());
const pair = (a: anchor.BN[]): [bigint, bigint] => [big(a[0]), big(a[1])];

export function decodeTable(address: PublicKey, m: any): Table {
  const committed = pair(m.committed);
  return {
    address,
    tesoroMatch: m.tesoroMatch,
    players: m.players,
    speed: m.speed,
    status: m.status,
    finalized: m.finalized,
    winner: m.winner,
    startDeadline: m.startDeadline.toNumber(),
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
  };
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
  readonly program: anchor.Program<any>;
  readonly tesoro: anchor.Program<any>;
  private readonly teeRpc: string;
  private readonly teeWs: string;
  private readonly tee = new Map<string, Connection>();
  /** Step logger; a UI may replace it while it is mounted. */
  onTx?: HoldemChainOptions["onTx"];

  constructor(holdemIdl: any, tesoroIdl: any, opts: HoldemChainOptions = {}) {
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

  private async waitOwner(address: PublicKey, owner: PublicKey, tries = 60): Promise<boolean> {
    for (let i = 0; i < tries; i++) {
      const info = await this.base.getAccountInfo(address).catch(() => null);
      if (info?.owner.equals(owner)) return true;
      await sleep(1000);
    }
    return false;
  }

  // -- base layer ----------------------------------------------------------------------------

  /**
   * Base layer. Binds a holdem table to an Active tesoro_core Match (opened and joined already)
   * and delegates it to the TEE. Either Player may call it.
   * `seatA` / `seatB` are the wallets of the opener and the joiner.
   */
  async createAndDelegate(
    creator: PlayerSigner,
    match: PublicKey,
    seatA: PublicKey,
    seatB: PublicKey,
    speed: number = SPEED_STANDARD,
  ): Promise<Addresses> {
    await this.createTable(creator, match, seatA, seatB, speed);
    return this.delegateTable(creator, match);
  }

  /** Base layer. Binds the table to the Active tesoro_core Match (step one of `createAndDelegate`). */
  async createTable(
    creator: PlayerSigner,
    match: PublicKey,
    seatA: PublicKey,
    seatB: PublicKey,
    speed: number = SPEED_STANDARD,
  ): Promise<string> {
    const ad = addresses(match);
    const create = await this.program.methods
      .createMatch(speed)
      .accountsPartial({
        creator: creator.publicKey,
        tesoroMatch: match,
        gameRecord: gameRecordPda(HOLDEM_PROGRAM_ID),
        accountA: tesoroAccountPda(seatA),
        accountB: tesoroAccountPda(seatB),
        authority: ad.authority,
        gameMatch: ad.gameMatch,
        deck: ad.deck,
        hole0: ad.hole0,
        hole1: ad.hole1,
      } as any)
      .instruction();
    return this.sendBase("create_match", [create], [creator]);
  }

  /** Base layer. Delegates a created table (and its hidden accounts) to the TEE (step two). */
  async delegateTable(creator: PlayerSigner, match: PublicKey): Promise<Addresses> {
    const ad = addresses(match);
    const delegate = await this.program.methods
      .delegateMatch(match)
      .accountsPartial({
        payer: creator.publicKey,
        gameMatch: ad.gameMatch,
        deck: ad.deck,
        hole0: ad.hole0,
        hole1: ad.hole1,
        validator: TEE_VALIDATOR,
      } as any)
      .instruction();
    await this.sendBase(
      "delegate_match",
      [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), delegate],
      [creator],
    );
    await this.waitOwner(ad.gameMatch, DELEGATION_PROGRAM_ID);
    await this.waitOwner(ad.deck, DELEGATION_PROGRAM_ID);
    await sleep(4000);
    return ad;
  }

  /** The tesoro_core Match state (base layer), decoded. */
  /** A tesoro_core Match that can still be settled (Active); false once settled, refunded or gone. */
  private isLive(tesoroMatch: any | null): boolean {
    return !!tesoroMatch && "active" in tesoroMatch.inner.stage;
  }

  async readTesoroMatch(match: PublicKey): Promise<any | null> {
    const info = await this.base.getAccountInfo(match);
    return info ? this.tesoro.coder.accounts.decode("matchState", info.data) : null;
  }

  /**
   * Base layer, permissionless. After the rollup committed the result (`closeMatch`, then wait
   * for the table to be owned by holdem again), settles or refunds the tesoro_core Match by CPI as
   * the Game authority PDA. Returns "" without
   * sending when the Match is already settled or refunded (the other Player, or the keeper, got
   * there first), so a lost race costs no fee.
   */
  async finalize(payer: PlayerSigner, match: PublicKey): Promise<string> {
    const ad = addresses(match);
    if (!(await this.waitOwner(ad.gameMatch, HOLDEM_PROGRAM_ID, 90))) {
      throw new Error("the table has not been committed back to the base layer yet");
    }
    if (!this.isLive(await this.readTesoroMatch(match))) return "";
    const ix = await this.program.methods
      .finalize()
      .accountsPartial({
        caller: payer.publicKey,
        gameMatch: ad.gameMatch,
        tesoroMatch: match,
        config: tesoroConfigPda(),
        ...gameAccounts(HOLDEM_PROGRAM_ID),
        authority: ad.authority,
        receipt: settledPda(match),
        eventAuthority: eventAuthorityPda(),
        tesoroProgram: TESORO_CORE_PROGRAM_ID,
      } as any)
      .instruction();
    return this.sendBase("finalize", [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix], [payer]);
  }

  // -- rollup --------------------------------------------------------------------------------

  /** Rollup. Creates the permissions and starts the Match (equal Chips, blinds posted). Anyone. */
  async start(payer: PlayerSigner, match: PublicKey): Promise<string> {
    const ad = addresses(match);
    const ix = await this.program.methods
      .initPermissions()
      .accountsPartial({
        payer: payer.publicKey,
        gameMatch: ad.gameMatch,
        deck: ad.deck,
        hole0: ad.hole0,
        hole1: ad.hole1,
        matchPermission: permissionPdaFromAccount(ad.gameMatch),
        deckPermission: permissionPdaFromAccount(ad.deck),
        hole0Permission: permissionPdaFromAccount(ad.hole0),
        hole1Permission: permissionPdaFromAccount(ad.hole1),
        permissionProgram: PERMISSION_PROGRAM_ID,
        ephemeralVault: EPHEMERAL_VAULT,
        magicProgram: MAGIC_PROGRAM_ID,
      } as any)
      .instruction();
    return this.sendTee("init_permissions", [ix], payer);
  }

  /**
   * Rollup. A Player's fresh secret for this hand, generated here and sent only inside the TEE.
   * Call once per hand. `withVrf` also requests the VRF output in the same transaction: pass it
   * from the Player who contributes second (the program refuses the request until both are in).
   */
  async contributeEntropy(player: PlayerSigner, match: PublicKey, withVrf = false): Promise<string> {
    const ad = addresses(match);
    const secret = Array.from(nacl.randomBytes(32));
    const ixs: TransactionInstruction[] = [
      await this.program.methods
        .contributeEntropy(secret)
        .accountsPartial({ player: player.publicKey, gameMatch: ad.gameMatch, deck: ad.deck } as any)
        .instruction(),
    ];
    if (withVrf) ixs.push(await this.requestVrfIx(player.publicKey, ad));
    return this.sendTee(withVrf ? "contribute_entropy+request_vrf" : "contribute_entropy", ixs, player);
  }

  private requestVrfIx(payer: PublicKey, ad: Addresses) {
    return this.program.methods
      .requestVrf(7)
      .accountsPartial({ payer, gameMatch: ad.gameMatch, deck: ad.deck, oracleQueue: ORACLE_QUEUE } as any)
      .instruction();
  }

  /** Rollup. Re-requests the VRF output if it has not arrived (idempotent until it does). */
  async requestVrf(payer: PlayerSigner, match: PublicKey): Promise<string> {
    return this.sendTee("request_vrf", [await this.requestVrfIx(payer.publicKey, addresses(match))], payer);
  }

  /** Rollup. Shuffles and deals once both secrets and the VRF output are in. Anyone may call it. */
  async deal(payer: PlayerSigner, match: PublicKey): Promise<string> {
    const ad = addresses(match);
    const ix = await this.program.methods
      .deal()
      .accountsPartial({
        payer: payer.publicKey,
        gameMatch: ad.gameMatch,
        deck: ad.deck,
        hole0: ad.hole0,
        hole1: ad.hole1,
      } as any)
      .instruction();
    return this.sendTee("deal", [ix], payer);
  }

  /** Rollup. A betting action on your turn. */
  async act(player: PlayerSigner, match: PublicKey, action: Action): Promise<string> {
    const ad = addresses(match);
    const ix = await this.program.methods
      .act(action as any)
      .accountsPartial({
        player: player.publicKey,
        gameMatch: ad.gameMatch,
        deck: ad.deck,
        hole0: ad.hole0,
        hole1: ad.hole1,
      } as any)
      .instruction();
    return this.sendTee(`act ${Object.keys(action)[0]}`, [ix], player);
  }

  /**
   * Rollup, permissionless. Once `table.deadline` has passed: checks or folds the idle Player,
   * cancels a no-show, forfeits after three missed turns.
   */
  async claimTimeout(caller: PlayerSigner, match: PublicKey): Promise<string> {
    const ad = addresses(match);
    const ix = await this.program.methods
      .claimTimeout()
      .accountsPartial({
        caller: caller.publicKey,
        gameMatch: ad.gameMatch,
        deck: ad.deck,
        hole0: ad.hole0,
        hole1: ad.hole1,
      } as any)
      .instruction();
    return this.sendTee("claim_timeout", [ix], caller);
  }

  /**
   * Rollup. When the table is over (or cancelled): wipes the hidden accounts, closes their
   * permissions and commits everything back. Returns the rollup signature and the base-layer
   * commitment signature.
   */
  async closeMatch(payer: PlayerSigner, match: PublicKey): Promise<{ tee: string; commit: string }> {
    const ad = addresses(match);
    const ix = await this.program.methods
      .closeMatch()
      .accountsPartial({
        payer: payer.publicKey,
        gameMatch: ad.gameMatch,
        deck: ad.deck,
        hole0: ad.hole0,
        hole1: ad.hole1,
        deckPermission: permissionPdaFromAccount(ad.deck),
        hole0Permission: permissionPdaFromAccount(ad.hole0),
        hole1Permission: permissionPdaFromAccount(ad.hole1),
        permissionProgram: PERMISSION_PROGRAM_ID,
        ephemeralVault: EPHEMERAL_VAULT,
        magicProgram: MAGIC_PROGRAM_ID,
        magicContext: MAGIC_CONTEXT,
      } as any)
      .instruction();
    const tee = await this.sendTee("close_match", [ix], payer);
    const conn = await this.teeConnection(payer);
    const commit = await GetCommitmentSignature(tee, conn);
    this.onTx?.("close_match commit", "base", commit);
    return { tee, commit };
  }

  // -- reads ---------------------------------------------------------------------------------

  /**
   * Public table state, as the Player sees it: stacks, bets, pot, revealed board, whose turn and
   * until when, the last hand's result. Readable by both Players only (the table's permission
   * lists exactly them). Returns `null` if this connection may not read it or it does not exist.
   */
  async readTable(viewer: PlayerSigner, match: PublicKey): Promise<Table | null> {
    const ad = addresses(match);
    const conn = await this.teeConnection(viewer);
    const info = await conn.getAccountInfo(ad.gameMatch).catch(() => null);
    if (!info || !info.owner.equals(DELEGATION_PROGRAM_ID) && !info.owner.equals(HOLDEM_PROGRAM_ID)) {
      return null;
    }
    return decodeTable(ad.gameMatch, this.program.coder.accounts.decode("gameMatch", info.data));
  }

  /** The table on the base layer (final result once committed back). */
  async readTableOnBase(match: PublicKey): Promise<Table | null> {
    const ad = addresses(match);
    const info = await this.base.getAccountInfo(ad.gameMatch);
    if (!info || !info.owner.equals(HOLDEM_PROGRAM_ID)) return null;
    return decodeTable(ad.gameMatch, this.program.coder.accounts.decode("gameMatch", info.data));
  }

  /**
   * Your own hole cards for the current hand, read through your TEE auth token. Returns `null`
   * before the deal (or if the account is unreadable): a Player can never read the opponent's.
   */
  async readOwnHole(player: PlayerSigner, match: PublicKey, seat: 0 | 1): Promise<{ handNo: number; cards: [number, number] } | null> {
    const ad = addresses(match);
    const conn = await this.teeConnection(player);
    const info = await conn.getAccountInfo(seat === 0 ? ad.hole0 : ad.hole1).catch(() => null);
    if (!info) return null;
    const hole: any = this.program.coder.accounts.decode("hole", info.data);
    if (!hole.dealt) return null;
    return { handNo: hole.handNo, cards: [hole.cards[0], hole.cards[1]] };
  }

  /** Seat of `wallet` at this table, or -1. */
  static seatOf(table: Table, wallet: PublicKey): number {
    return table.players.findIndex((p) => p.equals(wallet));
  }
}
