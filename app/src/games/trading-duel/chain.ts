/**
 * On-chain client for the Trading Duel Game (programs/trading_duel).
 *
 * Layers: the tesoro_core Match is opened and joined on the base layer (Solana devnet). The Duel
 * (public: the line's range per column, revealed picks, points) and the two Books (each Player's
 * picks, readable only by that Player until a column locks) are delegated to the MagicBlock
 * private rollup (TEE); picks and ticks go there, authenticated with a token the Player signs for. `finalize` runs on the base layer once the rollup has committed the result.
 *
 * Shares the Player signer, payout maths and tesoro_core PDAs with the Hold'em client.
 */
import * as anchor from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID,
  GetCommitmentSignature,
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
  computePayouts,
  tesoroAccountPda,
  tesoroConfigPda,
  tesoroHoldingPda,
  tesoroMatchPda,
  type PlayerSigner,
} from "../holdem/chain";
import { MAGICBLOCK } from "../../lib/cluster-settings";
import { fetchLeaderboardTerms } from "../../lib/chain/leaderboard";
import { COLUMNS, type Track } from "./grid";
import { gameRecordPda } from "../../lib/chain/game-record";

export { keypairSigner, type PlayerSigner } from "../holdem/chain";

export const TRADING_DUEL_PROGRAM_ID = new PublicKey("CNETsX9Gc78iApRNiGyAtiERKiHeD1yhHS8MwrfBAYyj");
const EPHEMERAL_VAULT = new PublicKey("MagicVau1t999999999999999999999999999999999");
const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");

/** Public rollup RPC / WebSocket for the price feeds (the same accounts live on the TEE). */
export const ER_RPC = MAGICBLOCK.erRpc;
export const ER_WS = MAGICBLOCK.erWs;

export const STATUS = { created: 0, live: 1, over: 2, cancelled: 3 } as const;
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

/**
 * Match id: `ms * 8 + asset * 2 + challenge`. Bit 0 marks a Challenge (as for every Game), bits 1
 * and 2 are the asset the program trades. The id fixes the asset on chain: nobody can change it.
 */
export function duelMatchId(asset: 0 | 1 | 2, challenge: boolean, ms = Date.now()): bigint {
  return BigInt(ms) * 8n + BigInt(asset) * 2n + (challenge ? 1n : 0n);
}
export function assetOfMatchId(id: bigint): Asset | null {
  return ASSETS[Number((id >> 1n) & 3n)] ?? null;
}

export interface Addresses {
  duel: PublicKey;
  book0: PublicKey;
  book1: PublicKey;
  authority: PublicKey;
}

const le64 = (n: bigint | number | anchor.BN) => new anchor.BN(n.toString()).toArrayLike(Buffer, "le", 8);

export function addresses(matchId: bigint | number | anchor.BN): Addresses {
  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, TRADING_DUEL_PROGRAM_ID)[0];
  const duel = pda([Buffer.from("duel"), le64(matchId)]);
  return {
    duel,
    book0: pda([Buffer.from("book"), duel.toBuffer(), Buffer.from([0])]),
    book1: pda([Buffer.from("book"), duel.toBuffer(), Buffer.from([1])]),
    authority: PublicKey.findProgramAddressSync([Buffer.from("authority")], TRADING_DUEL_PROGRAM_ID)[0],
  };
}

// ---------------------------------------------------------------------------------------------
// Decoded state

const big = (n: anchor.BN) => BigInt(n.toString());

export interface Duel {
  address: PublicKey;
  matchId: bigint;
  tesoroMatch: PublicKey;
  /** seat 0 opened the tesoro_core Match, seat 1 joined */
  players: [PublicKey, PublicKey];
  asset: Asset;
  status: number;
  finalized: boolean;
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
  duel: PublicKey;
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

export function decodeDuel(address: PublicKey, d: any): Duel {
  return {
    address,
    matchId: big(d.matchId),
    tesoroMatch: d.tesoroMatch,
    players: d.players,
    asset: ASSETS[d.asset] ?? ASSETS[0],
    status: d.status,
    finalized: d.finalized,
    winner: d.winner,
    startDeadline: d.startDeadline.toNumber(),
    startsAt: d.startsAt.toNumber(),
    gridAt: d.gridAt.toNumber(),
    endsAt: d.endsAt.toNumber(),
    anchor: big(d.anchor),
    step: big(d.step),
    lastTick: d.lastTick.toNumber(),
    track: decodeTrack(d.track),
    revealed: [[...d.revealed[0]], [...d.revealed[1]]],
    scores: [d.scores[0], d.scores[1]],
  };
}

export function decodeBook(address: PublicKey, b: any): Book {
  return { address, duel: b.duel, player: b.player, seat: b.seat, picks: [...b.picks], pickCount: b.pickCount };
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
  readonly program: anchor.Program<any>;
  readonly tesoro: anchor.Program<any>;
  private readonly teeRpc: string;
  private readonly teeWs: string;
  private readonly tee = new Map<string, Connection>();
  onTx?: DuelChainOptions["onTx"];

  constructor(duelIdl: any, tesoroIdl: any, opts: DuelChainOptions = {}) {
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

  private async waitOwner(address: PublicKey, owner: PublicKey, tries = 60): Promise<boolean> {
    for (let i = 0; i < tries; i++) {
      const info = await this.base.getAccountInfo(address).catch(() => null);
      if (info?.owner.equals(owner)) return true;
      await sleep(1000);
    }
    return false;
  }

  // -- base layer ----------------------------------------------------------------------------

  /** Base layer. Binds a Duel to an Active tesoro_core Match (asset from the id) and creates the Books. */
  async createDuel(creator: PlayerSigner, matchId: bigint | number, seatA: PublicKey, seatB: PublicKey): Promise<string> {
    const ad = addresses(matchId);
    const ix = await this.program.methods
      .createMatch(new anchor.BN(matchId.toString()))
      .accountsPartial({
        creator: creator.publicKey,
        tesoroMatch: tesoroMatchPda(matchId),
        gameRecord: gameRecordPda(TRADING_DUEL_PROGRAM_ID),
        accountA: tesoroAccountPda(seatA),
        accountB: tesoroAccountPda(seatB),
        authority: ad.authority,
        duel: ad.duel,
        book0: ad.book0,
        book1: ad.book1,
      } as any)
      .instruction();
    return this.sendBase("create_match", [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix], [creator]);
  }

  /** Base layer. Delegates the Duel and both Books to the TEE. */
  async delegateDuel(creator: PlayerSigner, matchId: bigint | number): Promise<Addresses> {
    const ad = addresses(matchId);
    const ix = await this.program.methods
      .delegateMatch(new anchor.BN(matchId.toString()))
      .accountsPartial({ payer: creator.publicKey, duel: ad.duel, book0: ad.book0, book1: ad.book1, validator: TEE_VALIDATOR } as any)
      .instruction();
    await this.sendBase("delegate_match", [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ix], [creator]);
    await this.waitOwner(ad.duel, DELEGATION_PROGRAM_ID);
    await this.waitOwner(ad.book1, DELEGATION_PROGRAM_ID);
    await sleep(3000);
    return ad;
  }

  async readTesoroMatch(matchId: bigint | number): Promise<any | null> {
    const info = await this.base.getAccountInfo(tesoroMatchPda(matchId));
    return info ? this.tesoro.coder.accounts.decode("matchState", info.data) : null;
  }

  private isLive(tesoroMatch: any | null): boolean {
    return !!tesoroMatch && "active" in tesoroMatch.inner.status;
  }

  /**
   * Base layer, permissionless. After the rollup committed the result, settles (or, for a draw or
   * a cancelled Match, refunds) the tesoro_core Match by CPI as the Game authority PDA. Returns ""
   * when it is already settled.
   */
  async finalize(payer: PlayerSigner, matchId: bigint | number): Promise<string> {
    const ad = addresses(matchId);
    if (!(await this.waitOwner(ad.duel, TRADING_DUEL_PROGRAM_ID, 90))) {
      throw new Error("the Duel has not been committed back to the base layer yet");
    }
    const info = await this.base.getAccountInfo(ad.duel);
    const duel = decodeDuel(ad.duel, this.program.coder.accounts.decode("duel", info!.data));
    const tesoroMatch = await this.readTesoroMatch(matchId);
    if (!this.isLive(tesoroMatch)) return "";
    const winner = duel.status === STATUS.over && duel.winner !== DRAW ? (duel.winner as 0 | 1) : null;
    const payouts = computePayouts(tesoroMatch.inner, winner, await fetchLeaderboardTerms(this.base));
    const holdings = payouts.map((p) => tesoroHoldingPda(p.recipient, p.source));
    const existing = await this.base.getMultipleAccountsInfo(holdings);
    const missing: TransactionInstruction[] = [];
    for (let i = 0; i < payouts.length; i++) {
      if (existing[i]) continue;
      missing.push(
        await this.tesoro.methods
          .openHolding()
          .accountsPartial({ payer: payer.publicKey, account: payouts[i].recipient, source: payouts[i].source, holding: holdings[i] } as any)
          .instruction(),
      );
    }
    for (let i = 0; i < missing.length; i += 5) await this.sendBase("open_holding", missing.slice(i, i + 5), [payer]);
    const remaining: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
    payouts.forEach((p, i) => remaining.push({ pubkey: p.recipient, isSigner: false, isWritable: true }, { pubkey: holdings[i], isSigner: false, isWritable: true }));
    if (!this.isLive(await this.readTesoroMatch(matchId))) return "";
    const ix = await this.program.methods
      .finalize()
      .accountsPartial({
        caller: payer.publicKey,
        duel: ad.duel,
        tesoroMatch: tesoroMatchPda(matchId),
        config: tesoroConfigPda(),
        gameRecord: gameRecordPda(TRADING_DUEL_PROGRAM_ID),
        authority: ad.authority,
        tesoroProgram: TESORO_CORE_PROGRAM_ID,
      } as any)
      .remainingAccounts(remaining)
      .instruction();
    return this.sendBase("finalize", [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix], [payer]);
  }

  // -- rollup --------------------------------------------------------------------------------

  /** Rollup. Creates the permissions and starts the Match at the live price: the head start runs, then 12 columns. Anyone. */
  async start(payer: PlayerSigner, matchId: bigint | number, asset: Asset): Promise<string> {
    const ad = addresses(matchId);
    const ix = await this.program.methods
      .initPermissions()
      .accountsPartial({
        payer: payer.publicKey,
        duel: ad.duel,
        book0: ad.book0,
        book1: ad.book1,
        duelPermission: permissionPdaFromAccount(ad.duel),
        book0Permission: permissionPdaFromAccount(ad.book0),
        book1Permission: permissionPdaFromAccount(ad.book1),
        permissionProgram: PERMISSION_PROGRAM_ID,
        ephemeralVault: EPHEMERAL_VAULT,
        magicProgram: MAGIC_PROGRAM_ID,
        priceFeed: asset.feed,
      } as any)
      .instruction();
    return this.sendTee("init_permissions", [ix], payer);
  }

  /** Rollup. Picks `band` (signed, 0 starts at the anchor) for `column`, or clears the pick with `NO_PICK`. Only until the column locks. */
  async setPick(player: PlayerSigner, matchId: bigint | number, seat: 0 | 1, column: number, band: number): Promise<string> {
    const ad = addresses(matchId);
    const ix = await this.program.methods
      .setPick(column, band)
      .accountsPartial({ player: player.publicKey, duel: ad.duel, book: seat === 0 ? ad.book0 : ad.book1 } as any)
      .instruction();
    return this.sendTee("set_pick", [ix], player);
  }

  private crankAccounts(caller: PublicKey, matchId: bigint | number, asset: Asset) {
    const ad = addresses(matchId);
    return { caller, duel: ad.duel, book0: ad.book0, book1: ad.book1, priceFeed: asset.feed } as any;
  }

  /** Rollup, permissionless. Records the live price into the line, reveals the columns that locked, scores the ones that ended. */
  async tick(payer: PlayerSigner, matchId: bigint | number, asset: Asset): Promise<string> {
    const ix = await this.program.methods.tick().accountsPartial(this.crankAccounts(payer.publicKey, matchId, asset)).instruction();
    return this.sendTee("tick", [ix], payer);
  }

  /** Rollup, permissionless. After the window: carries the line through any column it missed, scores every column and decides the Match. Reads no price. */
  async end(payer: PlayerSigner, matchId: bigint | number): Promise<string> {
    const ad = addresses(matchId);
    const ix = await this.program.methods.endMatch().accountsPartial({ caller: payer.publicKey, duel: ad.duel, book0: ad.book0, book1: ad.book1 } as any).instruction();
    return this.sendTee("end_match", [ix], payer);
  }

  /** Rollup, permissionless. Cancels a Duel that was delegated but never started before its deadline. */
  async claimTimeout(caller: PlayerSigner, matchId: bigint | number): Promise<string> {
    const ad = addresses(matchId);
    const ix = await this.program.methods.claimTimeout().accountsPartial({ caller: caller.publicKey, duel: ad.duel } as any).instruction();
    return this.sendTee("claim_timeout", [ix], caller);
  }

  /**
   * Rollup. Over: closes the permissions and commits everything (Books included, now public).
   * Cancelled (never started, so no permissions exist): commits the accounts as they are.
   */
  async closeMatch(payer: PlayerSigner, matchId: bigint | number): Promise<{ tee: string; commit: string }> {
    const ad = addresses(matchId);
    const duel = await this.readDuel(payer, matchId);
    const cancelled = duel?.status === STATUS.cancelled;
    const ix = cancelled
      ? await this.program.methods
          .closeUnstarted()
          .accountsPartial({ payer: payer.publicKey, duel: ad.duel, book0: ad.book0, book1: ad.book1, magicContext: MAGIC_CONTEXT, magicProgram: MAGIC_PROGRAM_ID } as any)
          .instruction()
      : await this.program.methods
          .closeMatch()
          .accountsPartial({
            payer: payer.publicKey,
            duel: ad.duel,
            book0: ad.book0,
            book1: ad.book1,
            duelPermission: permissionPdaFromAccount(ad.duel),
            book0Permission: permissionPdaFromAccount(ad.book0),
            book1Permission: permissionPdaFromAccount(ad.book1),
            permissionProgram: PERMISSION_PROGRAM_ID,
            ephemeralVault: EPHEMERAL_VAULT,
            magicContext: MAGIC_CONTEXT,
            magicProgram: MAGIC_PROGRAM_ID,
          } as any)
          .instruction();
    const tee = await this.sendTee("close_match", [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix], payer);
    const conn = await this.teeConnection(payer);
    // The commitment signature is evidence only; the commit itself landed when the Duel is program-owned again.
    const commit = await GetCommitmentSignature(tee, conn).catch(() => "");
    if (commit) this.onTx?.("close_match commit", "base", commit);
    return { tee, commit };
  }

  // -- reads ---------------------------------------------------------------------------------

  /** The public Duel in the rollup (readable by anyone through a Player's token). */
  async readDuel(viewer: PlayerSigner, matchId: bigint | number): Promise<Duel | null> {
    const ad = addresses(matchId);
    const conn = await this.teeConnection(viewer);
    const info = await conn.getAccountInfo(ad.duel).catch(() => null);
    if (!info || (!info.owner.equals(DELEGATION_PROGRAM_ID) && !info.owner.equals(TRADING_DUEL_PROGRAM_ID))) return null;
    return decodeDuel(ad.duel, this.program.coder.accounts.decode("duel", info.data));
  }

  /** The Duel on the base layer (final result once committed back). */
  async readDuelOnBase(matchId: bigint | number): Promise<Duel | null> {
    const ad = addresses(matchId);
    const info = await this.base.getAccountInfo(ad.duel);
    if (!info || !info.owner.equals(TRADING_DUEL_PROGRAM_ID)) return null;
    return decodeDuel(ad.duel, this.program.coder.accounts.decode("duel", info.data));
  }

  /** Your own Book through your TEE token; `null` for anything you may not read. */
  async readOwnBook(player: PlayerSigner, matchId: bigint | number, seat: 0 | 1): Promise<Book | null> {
    const ad = addresses(matchId);
    const conn = await this.teeConnection(player);
    const address = seat === 0 ? ad.book0 : ad.book1;
    const info = await conn.getAccountInfo(address).catch(() => null);
    if (!info) return null;
    return decodeBook(address, this.program.coder.accounts.decode("book", info.data));
  }

  static seatOf(duel: Duel, wallet: PublicKey): number {
    return duel.players.findIndex((p) => p.equals(wallet));
  }
}
