/**
 * On-chain client for the Vanguard Game (programs/vanguard).
 *
 * Layers: the tesoro_core Match is opened and joined on the base layer (Solana devnet). The Battle, the two
 * Armies and the Secret are delegated to the MagicBlock private rollup (TEE); every gameplay call goes there,
 * authenticated with a token the Player signs for. `finalize` runs on the base layer once the rollup has
 * committed the Battle back.
 *
 * Privacy: the Battle is readable by everyone, an Army only by its own Player, the Secret by nobody. A read of
 * an account the connection may not see returns `null`, indistinguishable from "does not exist".
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
import nacl from "tweetnacl";
import { fetchLeaderboardTerms } from "../../lib/chain/leaderboard";
import {
  TEE_RPC,
  TEE_WS,
  TESORO_CORE_PROGRAM_ID,
  computePayouts,
  defaultBaseConnection,
  keypairSigner,
  tesoroAccountPda,
  tesoroConfigPda,
  tesoroHoldingPda,
  tesoroMatchPda,
  type PlayerSigner,
} from "../holdem/chain";
import { STATUS, decodeArmy, decodeBattle, type ArmyAccount, type Battle } from "./decode";

export { keypairSigner, tesoroAccountPda, tesoroMatchPda, type PlayerSigner };

export const VANGUARD_PROGRAM_ID = new PublicKey("TS3iowavNFV2pMUrHcbmGNC9SW2Vv54i52DqjKebYKH");
const EPHEMERAL_VAULT = new PublicKey("MagicVau1t999999999999999999999999999999999");
const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");

/**
 * Compute limits. A declare (a move, a timeout claim) checks public state only: about 4-6k CU in LiteSVM. The resolve
 * does the rank rules, the fight, the turn pass and the "any action left?" scan over every shape a rank could make
 * (rules version 6): 135-145k in LiteSVM on compiled SBF whatever the board (a lost turn the same; endings that skip
 * the scan are cheaper). 200k leaves 30% over the worst reading (see ticket vgp 05). Delegation is Hold'em's 600k;
 * `finalize` pays out.
 */
export const CU = { declare: 40_000, resolve: 200_000, delegate: 600_000, finalize: 400_000 } as const;

const le64 = (n: bigint | number) => new anchor.BN(n.toString()).toArrayLike(Buffer, "le", 8);

export interface Addresses {
  battle: PublicKey;
  secret: PublicKey;
  army0: PublicKey;
  army1: PublicKey;
  authority: PublicKey;
  config: PublicKey;
}

/** PDAs of one Battle. `matchId` is the tesoro_core Match id. */
export function addresses(matchId: bigint | number): Addresses {
  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, VANGUARD_PROGRAM_ID)[0];
  const battle = pda([Buffer.from("battle"), le64(matchId)]);
  return {
    battle,
    secret: pda([Buffer.from("secret"), battle.toBuffer()]),
    army0: pda([Buffer.from("army"), battle.toBuffer(), Buffer.from([0])]),
    army1: pda([Buffer.from("army"), battle.toBuffer(), Buffer.from([1])]),
    authority: pda([Buffer.from("authority")]),
    config: pda([Buffer.from("config")]),
  };
}

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
  private readonly hashes = new Map<Connection, { hash: string; at: number }>();
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
        .fetch(addresses(0).config)
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

  private async blockhash(conn: Connection): Promise<string> {
    const seen = this.hashes.get(conn);
    if (seen && Date.now() - seen.at < BLOCKHASH_TTL_MS) return seen.hash;
    const hash = (await withRetry(() => conn.getLatestBlockhash())).blockhash;
    this.hashes.set(conn, { hash, at: Date.now() });
    return hash;
  }

  private async sendTee(step: string, ixs: TransactionInstruction[], signer: PlayerSigner): Promise<string> {
    const conn = await this.teeConnection(signer);
    const tx = new Transaction().add(...ixs);
    tx.feePayer = signer.publicKey;
    tx.recentBlockhash = await this.blockhash(conn);
    const signed = await signer.signTransaction(tx);
    const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
    for (let i = 0; i < 120; i++) {
      const st = (await conn.getSignatureStatuses([sig])).value[0];
      if (st) {
        if (st.err) {
          const t = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
          // an expired cached hash is the one failure worth a fresh hash next time
          this.hashes.delete(conn);
          throw new Error(`${step} failed ${sig}: ${JSON.stringify(st.err)}\n${t?.meta?.logMessages?.join("\n") ?? ""}`);
        }
        this.onTx?.(step, "tee", sig);
        return sig;
      }
      await sleep(250);
    }
    this.hashes.delete(conn);
    throw new Error(`${step} not confirmed ${sig}`);
  }

  private pause = sleep;

  private async waitOwner(address: PublicKey, owner: PublicKey, tries = 60): Promise<boolean> {
    for (let i = 0; i < tries; i++) {
      const info = await this.base.getAccountInfo(address).catch(() => null);
      if (info?.owner.equals(owner)) return true;
      await sleep(1000);
    }
    return false;
  }

  // -- base layer ----------------------------------------------------------------------------

  /** Base layer. Binds a Battle to an Active tesoro_core Match. `seatA` / `seatB` are the opener and the joiner. */
  async createMatch(creator: PlayerSigner, matchId: bigint | number, seatA: PublicKey, seatB: PublicKey): Promise<string> {
    const ad = addresses(matchId);
    const ix = await this.program.methods
      .createMatch(new anchor.BN(matchId.toString()))
      .accountsPartial({
        creator: creator.publicKey,
        tesoroMatch: tesoroMatchPda(matchId),
        config: tesoroConfigPda(),
        vanguardConfig: ad.config,
        accountA: tesoroAccountPda(seatA),
        accountB: tesoroAccountPda(seatB),
        authority: ad.authority,
        battle: ad.battle,
        secret: ad.secret,
        army0: ad.army0,
        army1: ad.army1,
      } as any)
      .instruction();
    return this.sendBase("create_match", [ix], [creator]);
  }

  /** Base layer. Delegates a created Battle (and its private accounts) to the TEE. */
  async delegateMatch(payer: PlayerSigner, matchId: bigint | number): Promise<Addresses> {
    const ad = addresses(matchId);
    const { teeValidator } = await this.readConfig();
    const ix = await this.program.methods
      .delegateMatch(new anchor.BN(matchId.toString()))
      .accountsPartial({
        payer: payer.publicKey,
        battle: ad.battle,
        secret: ad.secret,
        army0: ad.army0,
        army1: ad.army1,
        config: ad.config,
        validator: teeValidator,
      } as any)
      .instruction();
    await this.sendBase("delegate_match", [ComputeBudgetProgram.setComputeUnitLimit({ units: CU.delegate }), ix], [payer]);
    await this.waitOwner(ad.battle, DELEGATION_PROGRAM_ID);
    await this.waitOwner(ad.army0, DELEGATION_PROGRAM_ID);
    await this.pause(4000);
    return ad;
  }

  async readTesoroMatch(matchId: bigint | number): Promise<any | null> {
    const info = await this.base.getAccountInfo(tesoroMatchPda(matchId));
    return info ? this.tesoro.coder.accounts.decode("matchState", info.data) : null;
  }

  /** A tesoro_core Match that can still be settled (Active); false once settled, refunded or gone. */
  private isLive(tesoroMatch: any | null): boolean {
    return !!tesoroMatch && "active" in tesoroMatch.inner.status;
  }

  /**
   * Base layer, permissionless. After the rollup committed the Battle back, settles or refunds the tesoro_core
   * Match by CPI as the Game authority PDA, creating the Holdings the payout needs first. Returns "" without
   * sending when the Match is already settled or refunded (the other Player or the keeper got there first).
   */
  async finalize(payer: PlayerSigner, matchId: bigint | number): Promise<string> {
    const ad = addresses(matchId);
    if (!(await this.waitOwner(ad.battle, VANGUARD_PROGRAM_ID, 90))) {
      throw new Error("the Battle has not been committed back to the base layer yet");
    }
    const battle = await this.readBattleOnBase(matchId);
    const tesoroMatch = await this.readTesoroMatch(matchId);
    if (!battle || !this.isLive(tesoroMatch)) return "";
    // a win names the winning seat (0 opener, 1 joiner); a draw, or a Match that never started, refunds
    const winner = battle.status === STATUS.over && (battle.winner === 0 || battle.winner === 1) ? battle.winner : null;
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
    // Opening Holdings takes a few seconds: look again before paying for a transaction that would fail.
    if (!this.isLive(await this.readTesoroMatch(matchId))) return "";
    const ix = await this.program.methods
      .finalize()
      .accountsPartial({
        caller: payer.publicKey,
        battle: ad.battle,
        tesoroMatch: tesoroMatchPda(matchId),
        config: tesoroConfigPda(),
        authority: ad.authority,
        tesoroProgram: TESORO_CORE_PROGRAM_ID,
      } as any)
      .remainingAccounts(remaining)
      .instruction();
    return this.sendBase("finalize", [ComputeBudgetProgram.setComputeUnitLimit({ units: CU.finalize }), ix], [payer]);
  }

  // -- rollup --------------------------------------------------------------------------------

  /** Rollup. Creates the permissions. Anyone. */
  async initPermissions(payer: PlayerSigner, matchId: bigint | number): Promise<string> {
    const ad = addresses(matchId);
    const ix = await this.program.methods
      .initPermissions()
      .accountsPartial({
        payer: payer.publicKey,
        battle: ad.battle,
        secret: ad.secret,
        army0: ad.army0,
        army1: ad.army1,
        battlePermission: permissionPdaFromAccount(ad.battle),
        secretPermission: permissionPdaFromAccount(ad.secret),
        army0Permission: permissionPdaFromAccount(ad.army0),
        army1Permission: permissionPdaFromAccount(ad.army1),
        permissionProgram: PERMISSION_PROGRAM_ID,
        ephemeralVault: EPHEMERAL_VAULT,
        magicProgram: MAGIC_PROGRAM_ID,
      } as any)
      .instruction();
    return this.sendTee("init_permissions", [ix], payer);
  }

  /**
   * Rollup. A Player's fresh secret, generated here and sent only inside the TEE. `withVrf` also requests the
   * randomness in the same transaction: pass it from the Player who contributes second. `oracleQueue` is the
   * Battle's own (default: the program config's).
   */
  async contributeEntropy(player: PlayerSigner, matchId: bigint | number, withVrf = false, oracleQueue?: PublicKey): Promise<string> {
    const ad = addresses(matchId);
    const secret = Array.from(nacl.randomBytes(32));
    const ixs: TransactionInstruction[] = [
      await this.program.methods.contributeEntropy(secret).accountsPartial({ player: player.publicKey, battle: ad.battle, secret: ad.secret } as any).instruction(),
    ];
    if (withVrf) ixs.push(await this.requestVrfIx(player.publicKey, matchId, oracleQueue));
    return this.sendTee(withVrf ? "contribute_entropy+request_vrf" : "contribute_entropy", ixs, player);
  }

  /** The `request_vrf` instruction, for a caller that sends or simulates it itself. */
  async requestVrfIx(payer: PublicKey, matchId: bigint | number, oracleQueue?: PublicKey): Promise<TransactionInstruction> {
    const ad = addresses(matchId);
    const queue = oracleQueue ?? (await this.readConfig()).oracleQueue;
    return this.program.methods
      .requestVrf(7)
      .accountsPartial({ payer, battle: ad.battle, secret: ad.secret, oracleQueue: queue } as any)
      .instruction();
  }

  /** Rollup. Re-requests the randomness if it has not arrived. */
  async requestVrf(payer: PlayerSigner, matchId: bigint | number, oracleQueue?: PublicKey): Promise<string> {
    return this.sendTee("request_vrf", [await this.requestVrfIx(payer.publicKey, matchId, oracleQueue)], payer);
  }

  /** The `deal` instruction, for a caller that sends or simulates it itself. */
  dealIx(payer: PublicKey, matchId: bigint | number): Promise<TransactionInstruction> {
    const ad = addresses(matchId);
    return this.program.methods
      .deal()
      .accountsPartial({ payer, battle: ad.battle, secret: ad.secret, army0: ad.army0, army1: ad.army1 } as any)
      .instruction();
  }

  /** Rollup, permissionless. Sets the board up once both secrets and the randomness are in. */
  async deal(payer: PlayerSigner, matchId: bigint | number): Promise<string> {
    return this.sendTee("deal", [await this.dealIx(payer.publicKey, matchId)], payer);
  }

  /**
   * Rollup. Declare a move (or an attack) of `piece` to square `to` (`row * 10 + col`) on your turn. The program
   * checks only public state now; the rank rules and the fight are applied by `resolve` in a later slot, and a move
   * the rank rules refuse costs the turn. A declare cannot be taken back. Send `resolve` as soon as it lands.
   */
  async movePiece(
    player: PlayerSigner,
    matchId: bigint | number,
    piece: number,
    to: number,
    seal: { expectedSeq: number; sealedSwitch: number },
  ): Promise<string> {
    const ad = addresses(matchId);
    const ix = await this.program.methods
      .movePiece(piece, to, seal.expectedSeq, seal.sealedSwitch)
      .accountsPartial({ player: player.publicKey, battle: ad.battle } as any)
      .instruction();
    return this.sendTee("move_piece", [ComputeBudgetProgram.setComputeUnitLimit({ units: CU.declare }), ix], player);
  }

  /** Rollup. Spend a banked Two-Step Turn before the first step of your turn. */
  async startTwoStep(player: PlayerSigner, matchId: bigint | number): Promise<string> {
    const ad = addresses(matchId);
    const ix = await this.program.methods.startTwoStep().accountsPartial({ player: player.publicKey, battle: ad.battle } as any).instruction();
    return this.sendTee("start_two_step", [ix], player);
  }

  /**
   * Rollup, permissionless. Once the turn's deadline has passed it declares a timeout (the turn is lost); past the
   * time cap it declares the tiebreak ending; past the start window it cancels. Declared timeouts are applied by
   * `resolve`.
   */
  async claimTimeout(caller: PlayerSigner, matchId: bigint | number): Promise<string> {
    const ad = addresses(matchId);
    const ix = await this.program.methods
      .claimTimeout()
      .accountsPartial({ caller: caller.publicKey, battle: ad.battle, secret: ad.secret } as any)
      .instruction();
    return this.sendTee("claim_timeout", [ComputeBudgetProgram.setComputeUnitLimit({ units: CU.declare }), ix], caller);
  }

  /**
   * Rollup, permissionless, no arguments. Applies the pending action (a declared move or timeout) in a slot after
   * its declare. Both Players' clients and the keeper send it as soon as the Battle shows a pending action; the
   * program refuses it in the declare's own slot (`TooSoon`), so a caller retries after a moment.
   */
  async resolve(caller: PlayerSigner, matchId: bigint | number): Promise<string> {
    const ad = addresses(matchId);
    const ix = await this.program.methods
      .resolve()
      .accountsPartial({ caller: caller.publicKey, battle: ad.battle, army0: ad.army0, army1: ad.army1, secret: ad.secret } as any)
      .instruction();
    return this.sendTee("resolve", [ComputeBudgetProgram.setComputeUnitLimit({ units: CU.resolve }), ix], caller);
  }

  /**
   * Rollup. When the Battle is over or cancelled: wipes the private accounts, closes their permissions and
   * commits everything back. Returns the rollup signature and the base-layer commitment signature.
   */
  async closeMatch(payer: PlayerSigner, matchId: bigint | number): Promise<{ tee: string; commit: string }> {
    const ad = addresses(matchId);
    const ix = await this.program.methods
      .closeMatch()
      .accountsPartial({
        payer: payer.publicKey,
        battle: ad.battle,
        secret: ad.secret,
        army0: ad.army0,
        army1: ad.army1,
        battlePermission: permissionPdaFromAccount(ad.battle),
        secretPermission: permissionPdaFromAccount(ad.secret),
        army0Permission: permissionPdaFromAccount(ad.army0),
        army1Permission: permissionPdaFromAccount(ad.army1),
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

  /** Rollup. Commits back a Battle that was cancelled before its permissions existed. */
  async closeUnstarted(payer: PlayerSigner, matchId: bigint | number): Promise<string> {
    const ad = addresses(matchId);
    const ix = await this.program.methods
      .closeUnstarted()
      .accountsPartial({ payer: payer.publicKey, battle: ad.battle, secret: ad.secret, army0: ad.army0, army1: ad.army1, magicProgram: MAGIC_PROGRAM_ID, magicContext: MAGIC_CONTEXT } as any)
      .instruction();
    return this.sendTee("close_unstarted", [ix], payer);
  }

  // -- reads ---------------------------------------------------------------------------------

  /** The public Battle from the rollup. `null` if it does not exist there (yet, or any more). */
  async readBattle(viewer: PlayerSigner, matchId: bigint | number): Promise<Battle | null> {
    const conn = await this.teeConnection(viewer);
    const info = await conn.getAccountInfo(addresses(matchId).battle).catch(() => null);
    if (!info || (!info.owner.equals(DELEGATION_PROGRAM_ID) && !info.owner.equals(VANGUARD_PROGRAM_ID))) return null;
    return decodeBattle(info.data);
  }

  /** The Battle on the base layer (the final result once committed back). */
  async readBattleOnBase(matchId: bigint | number): Promise<Battle | null> {
    const info = await this.base.getAccountInfo(addresses(matchId).battle);
    if (!info || !info.owner.equals(VANGUARD_PROGRAM_ID)) return null;
    return decodeBattle(info.data);
  }

  /** Your own Army, read with your TEE token. `null` before it exists; the opponent's reads as null too. */
  async readOwnArmy(player: PlayerSigner, matchId: bigint | number, seat: 0 | 1): Promise<ArmyAccount | null> {
    const ad = addresses(matchId);
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

  /** Calls `onBattle` on every change of the Battle on the rollup. Returns the unsubscribe. */
  async watchBattle(viewer: PlayerSigner, matchId: bigint | number, onBattle: (b: Battle) => void): Promise<() => void> {
    const conn = await this.teeConnection(viewer);
    const id = conn.onAccountChange(
      addresses(matchId).battle,
      (info) => {
        try {
          onBattle(decodeBattle(info.data));
        } catch {
          // an account that is mid-undelegation can be empty; the poll covers it
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
}
