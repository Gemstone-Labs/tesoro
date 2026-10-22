/**
 * The shared base-layer hub of the app's chain code: signers, the tesoro_core program, transaction sending (base and TEE),
 * and the Account/Match addresses every Game uses. The Block Burst program itself is in `./live-chain.ts`.
 */
import { matchAddressOf } from "../../lib/chain/match-id";
import { settledPda } from "../../lib/chain/basket";
import { protectionsPda } from "../../lib/chain/native";
import { gameAccounts, gameRecordPda } from "../../lib/chain/game-record";
import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import { MAGICBLOCK } from "../../lib/cluster-settings";
import { TxFailedError, TxUnconfirmedError, txOutcome, type TxOutcome } from "./tx";

export { TxFailedError, TxUnconfirmedError, type TxOutcome };

export const TESORO_CORE_PROGRAM_ID = new PublicKey("AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh");
export const BLOCK_PUZZLE_PROGRAM_ID = new PublicKey("5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj");
export const TEE_RPC = MAGICBLOCK.teeRpc;
export const TEE_WS = MAGICBLOCK.teeWs;

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
  coreIdl: Idl;
  teeRpc?: string;
  teeWs?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pk = (bytes: number[] | Uint8Array) => new PublicKey(Uint8Array.from(bytes));

/** An IDL program whose accounts are looked up by name at runtime (the IDLs are loaded as JSON). */
export type AnyProgram = Omit<Program<any>, "account"> & { account: Record<string, any> };

export class BlockPuzzleChain {
  readonly base: Connection;
  readonly core: AnyProgram;
  private readonly teeRpc: string;
  private readonly teeWs: string;
  private readonly tees = new Map<string, Connection>();

  constructor(cfg: ChainConfig) {
    this.base = cfg.base;
    this.teeRpc = cfg.teeRpc ?? TEE_RPC;
    this.teeWs = cfg.teeWs ?? TEE_WS;
    // Read-only provider: transactions are built here and signed by the caller's signer.
    const provider = new AnchorProvider(
      cfg.base,
      { publicKey: Keypair.generate().publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t },
      { commitment: "confirmed" },
    );
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
  /** The tesoro_core Match a key names: `matchKey` is `<opener Account>-<n>` (the Match is `["match", opener, n]`), or the Match address itself. */
  static addresses(matchKey: string | PublicKey) {
    const config = PublicKey.findProgramAddressSync([Buffer.from("config")], TESORO_CORE_PROGRAM_ID)[0];
    const match = typeof matchKey === "string" ? matchAddressOf(matchKey) : matchKey;
    if (!match) throw new Error(`Not a Match key: ${String(matchKey)}`);
    return { config, match };
  }

  // ---- transport ----------------------------------------------------------------------------

  /** True when this signer already has a rollup session, so reading through it asks for no signature. */
  hasTeeSession(signer: ChainSigner): boolean {
    return this.tees.has(signer.publicKey.toBase58());
  }

  /** One TEE connection per Player: the auth token binds reads to that wallet. */
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

  // ---- tesoro_core: create and join ---------------------------------------------------------

  /** The Protections address of the Account that opened the Match (a Player on a Break or Self-Excluded cannot be joined or kept waiting). */
  async openerProtections(matchId: string): Promise<PublicKey> {
    return protectionsPda(await this.openerAccount(matchId));
  }

  /** The record of the Game the Match was opened for (refunds go through whichever Game it is). */
  async gameRecordOf(matchId: string): Promise<PublicKey> {
    const m = await this.core.account.matchState.fetch(BlockPuzzleChain.addresses(matchId).match);
    return gameRecordPda(m.inner.game);
  }

  /** The Account that opened the Match. */
  async openerAccount(matchId: string): Promise<PublicKey> {
    const m = await this.core.account.matchState.fetch(BlockPuzzleChain.addresses(matchId).match);
    return new PublicKey(Uint8Array.from(m.inner.a.player));
  }

  /**
   * tesoro_core `refund_match`: the opener of an unjoined Match, anyone after the deadline. Starts the refund run (chunks give
   * the entries back). `payer` pays the receipt's rent: the caller, or the relayer when the Player has no SOL.
   */
  async refundMatchIx(caller: PublicKey, payer: PublicKey, matchId: string): Promise<TransactionInstruction> {
    const a = BlockPuzzleChain.addresses(matchId);
    const game = await this.gameOf(matchId);
    return this.core.methods
      .refundMatch()
      .accountsPartial({
        caller,
        payer,
        ...gameAccounts(game),
        matchState: a.match,
        receipt: settledPda(a.match),
        openerProtections: await this.openerProtections(matchId),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  async refundMatch(caller: ChainSigner, matchId: string) {
    const ix = await this.refundMatchIx(caller.publicKey, caller.publicKey, matchId);
    return this.sendBase(caller, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix]);
  }

  /** The Game program a Match was opened for. */
  async gameOf(matchId: string): Promise<PublicKey> {
    const m = await this.core.account.matchState.fetch(BlockPuzzleChain.addresses(matchId).match);
    return pk(m.inner.game);
  }
}
