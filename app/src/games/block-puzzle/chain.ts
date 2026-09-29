/**
 * On-chain client for Block Puzzle Matches (programs/block_puzzle + programs/tesoro_core).
 *
 * IDL-based: pass the two IDLs (`target/idl/block_puzzle.json`, `target/idl/tesoro_core.json`).
 * Needs `@coral-xyz/anchor`, `@solana/web3.js`, `@magicblock-labs/ephemeral-rollups-sdk` and
 * `tweetnacl` in the app.
 *
 * Lifecycle, in the order the app calls it (seat 0 opens the Match, seat 1 joins):
 *   openMatch -> joinMatch -> startSession -> revealSeed (waits for the committed slot)
 *   -> delegateBoards -> initPermission (each Player, own Board) -> beginRun -> play (repeat)
 *   -> finish -> sealAndCommit -> settle -> fetchResult.
 * A Player's `play` calls go to the private rollup (TEE); everything else to the base layer.
 * Scores are never sent: the program replays the moves with the same engine as `./engine.ts`.
 */
import { AnchorProvider, BN, Program, type Idl } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_SLOT_HASHES_PUBKEY,
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

export const BLOCK_PUZZLE_PROGRAM_ID = new PublicKey("5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj");
export const TESORO_CORE_PROGRAM_ID = new PublicKey("AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh");
export const TEE_RPC = "https://devnet-tee.magicblock.app";
export const TEE_WS = "wss://devnet-tee.magicblock.app";
export const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
export const BASE_RPC = "https://rpc.magicblock.app/devnet";

const EPHEMERAL_VAULT = new PublicKey("MagicVau1t999999999999999999999999999999999");
const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");

/** Mirrors programs/block_puzzle constants. */
export const PLAY_SECS = 90;
export const MAX_PLAY_BATCH = 40;

export type Move = { piece: number; x: number; y: number };
export type Seat = 0 | 1;
export type Result = "opener" | "joiner" | "draw";

export interface ChainSigner {
  publicKey: PublicKey;
  signTransaction(tx: Transaction): Promise<Transaction>;
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

type Line = { source: PublicKey; amount: bigint };
type Payout = { recipient: PublicKey; source: PublicKey; amount: bigint };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const le8 = (n: bigint | number | BN) => new BN(n.toString()).toArrayLike(Buffer, "le", 8);
const keyCmp = (a: PublicKey, b: PublicKey) => Buffer.compare(a.toBuffer(), b.toBuffer());
const pk = (bytes: number[] | Uint8Array) => new PublicKey(Uint8Array.from(bytes));

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
  static holding(account: PublicKey, source: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("holding"), account.toBuffer(), source.toBuffer()],
      TESORO_CORE_PROGRAM_ID,
    )[0];
  }
  static addresses(matchId: bigint | number | BN) {
    const config = PublicKey.findProgramAddressSync([Buffer.from("config")], TESORO_CORE_PROGRAM_ID)[0];
    const match = PublicKey.findProgramAddressSync([Buffer.from("match"), le8(matchId)], TESORO_CORE_PROGRAM_ID)[0];
    const bpPda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, BLOCK_PUZZLE_PROGRAM_ID)[0];
    const session = bpPda([Buffer.from("session"), match.toBuffer()]);
    const board = (seat: Seat) => bpPda([Buffer.from("board"), session.toBuffer(), Buffer.from([seat])]);
    return {
      config,
      match,
      session,
      authority: bpPda([Buffer.from("authority")]),
      boards: [board(0), board(1)] as [PublicKey, PublicKey],
    };
  }

  // ---- transport ----------------------------------------------------------------------------

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
    tx.recentBlockhash = (await this.base.getLatestBlockhash()).blockhash;
    return this.sendSigned(await signer.signTransaction(tx));
  }

  /** Sends a fully signed base-layer transaction and waits for it to confirm. */
  async sendSigned(signed: Transaction): Promise<string> {
    const sig = await this.base.sendRawTransaction(signed.serialize(), { skipPreflight: true });
    // Poll instead of websockets: works through any RPC proxy.
    let err: unknown = null;
    let landed = false;
    for (let i = 0; i < 90 && !landed; i++) {
      const st = (await this.base.getSignatureStatuses([sig])).value[0];
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
        landed = true;
        err = st.err;
      } else {
        await sleep(500);
        if (i % 10 === 9) await this.base.sendRawTransaction(signed.serialize(), { skipPreflight: true }).catch(() => undefined);
      }
    }
    if (!landed) throw new Error(`base tx not confirmed ${sig}`);
    if (err) {
      const t = await this.base.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      throw new Error(`base tx failed ${sig}: ${JSON.stringify(err)}\n${t?.meta?.logMessages?.join("\n") ?? ""}`);
    }
    return sig;
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

  /** Seat 0 opens a Match for Block Puzzle. `holdings`: own-sourced first, then won (see tesoro-core.md). */
  async openMatch(signer: ChainSigner, matchId: bigint, entry: number, holdings: PublicKey[]) {
    const a = BlockPuzzleChain.addresses(matchId);
    const ix = await this.core.methods
      .openMatch(new BN(matchId.toString()), BLOCK_PUZZLE_PROGRAM_ID, new BN(entry))
      .accountsPartial({
        playerAuthority: signer.publicKey,
        config: a.config,
        playerAccount: BlockPuzzleChain.coreAccount(signer.publicKey),
        matchState: a.match,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(holdings.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })))
      .instruction();
    return this.sendBase(signer, [ix]);
  }

  /** Seat 1 joins with an equal entry. */
  async joinMatch(signer: ChainSigner, matchId: bigint, holdings: PublicKey[]) {
    const a = BlockPuzzleChain.addresses(matchId);
    const ix = await this.core.methods
      .joinMatch()
      .accountsPartial({
        playerAuthority: signer.publicKey,
        playerAccount: BlockPuzzleChain.coreAccount(signer.publicKey),
        matchState: a.match,
      })
      .remainingAccounts(holdings.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })))
      .instruction();
    return this.sendBase(signer, [ix]);
  }

  // ---- session and Seed ---------------------------------------------------------------------

  /** Anyone. Binds a Session and both Boards to the Active Match. */
  async startSession(payer: ChainSigner, matchId: bigint) {
    const a = BlockPuzzleChain.addresses(matchId);
    const m: any = await this.core.account.matchState.fetch(a.match);
    const accountA = pk(m.inner.a.player);
    const accountB = pk(m.inner.b.player);
    const ix = await this.bp.methods
      .startSession()
      .accountsPartial({
        payer: payer.publicKey,
        matchState: a.match,
        accountA,
        accountB,
        session: a.session,
        board0: a.boards[0],
        board1: a.boards[1],
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    return this.sendBase(payer, [ix]);
  }

  /** Anyone. Waits until the committed slot has passed, then derives the Seed and sets the deadline. */
  async revealSeed(payer: ChainSigner, matchId: bigint): Promise<{ sig: string; seed: bigint }> {
    const a = BlockPuzzleChain.addresses(matchId);
    for (let attempt = 0; attempt < 6; attempt++) {
      const s: any = await this.bp.account.session.fetch(a.session);
      if (s.seedReady) return { sig: "", seed: BigInt(s.seed.toString()) };
      while ((await this.base.getSlot("confirmed")) <= Number(s.commitSlot.toString()) + 1) await sleep(400);
      const ix = await this.bp.methods
        .revealSeed()
        .accountsPartial({
          payer: payer.publicKey,
          session: a.session,
          board0: a.boards[0],
          board1: a.boards[1],
          slotHashes: SYSVAR_SLOT_HASHES_PUBKEY,
          authority: a.authority,
          config: a.config,
          matchState: a.match,
          tesoroCoreProgram: TESORO_CORE_PROGRAM_ID,
        })
        .instruction();
      const sig = await this.sendBase(payer, [ix]);
      const after: any = await this.bp.account.session.fetch(a.session);
      if (after.seedReady) return { sig, seed: BigInt(after.seed.toString()) };
    }
    throw new Error("seed was not revealed");
  }

  // ---- delegation and privacy ---------------------------------------------------------------

  /** Anyone. Moves both Boards to the TEE validator. */
  async delegateBoards(payer: ChainSigner, matchId: bigint) {
    const a = BlockPuzzleChain.addresses(matchId);
    const ix = await this.bp.methods
      .delegateBoards()
      .accountsPartial({
        payer: payer.publicKey,
        session: a.session,
        board0: a.boards[0],
        board1: a.boards[1],
        validator: this.teeValidator,
      })
      .instruction();
    const sig = await this.sendBase(payer, [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ix]);
    const ok = (await this.waitOwner(a.boards[0], DELEGATION_PROGRAM_ID)) && (await this.waitOwner(a.boards[1], DELEGATION_PROGRAM_ID));
    if (!ok) throw new Error("boards were not delegated");
    await sleep(4000);
    return sig;
  }

  /** In the TEE. Makes a Board readable only by its Player. */
  async initPermission(signer: ChainSigner, matchId: bigint, seat: Seat) {
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

  // ---- play (all in the TEE, by the Player) -------------------------------------------------

  async beginRun(signer: ChainSigner, matchId: bigint, seat: Seat) {
    const board = BlockPuzzleChain.addresses(matchId).boards[seat];
    const ix = await this.bp.methods.beginRun().accountsPartial({ player: signer.publicKey, board }).instruction();
    return this.sendTee(signer, [ix]);
  }

  /** Submits moves in batches of at most 40; an illegal move fails its whole batch. */
  async play(signer: ChainSigner, matchId: bigint, seat: Seat, moves: Move[]): Promise<string[]> {
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

  async finish(signer: ChainSigner, matchId: bigint, seat: Seat) {
    const board = BlockPuzzleChain.addresses(matchId).boards[seat];
    const ix = await this.bp.methods.finish().accountsPartial({ player: signer.publicKey, board }).instruction();
    return this.sendTee(signer, [ix]);
  }

  /** A Player reads their own Board in the TEE (null for anyone else). Never call for the opponent. */
  async fetchOwnBoard(signer: ChainSigner, matchId: bigint, seat: Seat) {
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
  async sealAndCommit(payer: ChainSigner, matchId: bigint): Promise<{ teeSig: string; commitSig?: string }> {
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
        permission0: permissionPdaFromAccount(a.boards[0]),
        permission1: permissionPdaFromAccount(a.boards[1]),
        permissionProgram: PERMISSION_PROGRAM_ID,
        ephemeralVault: EPHEMERAL_VAULT,
        magicProgram: MAGIC_PROGRAM_ID,
        magicContext: MAGIC_CONTEXT,
      })
      .instruction();
    const teeSig = await this.sendTee(payer, [seal, commit]);
    const back = (await this.waitOwner(a.boards[0], BLOCK_PUZZLE_PROGRAM_ID)) && (await this.waitOwner(a.boards[1], BLOCK_PUZZLE_PROGRAM_ID));
    if (!back) throw new Error("boards did not return to the base layer");
    const commitSig = await GetCommitmentSignature(teeSig, await this.tee(payer)).catch(() => undefined);
    return { teeSig, commitSig };
  }

  // ---- settlement ---------------------------------------------------------------------------

  /** Anyone. Settles through tesoro_core from the committed Boards (the program picks the winner). */
  async settle(payer: ChainSigner, matchId: bigint) {
    const a = BlockPuzzleChain.addresses(matchId);
    const [b0, b1]: any[] = await Promise.all(a.boards.map((b) => this.bp.account.board.fetch(b)));
    const result = decide([b0.startedAt.isZero(), b1.startedAt.isZero()], [b0.score, b1.score]);
    const remaining = await this.payoutAccounts(payer, matchId, result);
    const ix = await this.bp.methods
      .settle()
      .accountsPartial(this.settleAccounts(payer, a))
      .remainingAccounts(remaining)
      .instruction();
    return { sig: await this.sendBase(payer, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix]), result };
  }

  /** tesoro_core `refund_match`: the opener of an unjoined Match, anyone after the deadline. Returns the entries. */
  async refundMatch(caller: ChainSigner, matchId: bigint) {
    const a = BlockPuzzleChain.addresses(matchId);
    const remaining = await this.payoutAccounts(caller, matchId, "draw");
    const ix = await this.core.methods
      .refundMatch()
      .accountsPartial({ caller: caller.publicKey, config: a.config, matchState: a.match })
      .remainingAccounts(remaining)
      .instruction();
    return this.sendBase(caller, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix]);
  }

  /** Anyone, after the deadline, for a Match whose Boards were never delegated. Refunds both. */
  async claimTimeout(payer: ChainSigner, matchId: bigint) {
    const a = BlockPuzzleChain.addresses(matchId);
    const remaining = await this.payoutAccounts(payer, matchId, "draw");
    const ix = await this.bp.methods
      .claimTimeout()
      .accountsPartial(this.settleAccounts(payer, a))
      .remainingAccounts(remaining)
      .instruction();
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
      matchState: a.match,
      tesoroCoreProgram: TESORO_CORE_PROGRAM_ID,
    };
  }

  /** Payout accounts in tesoro_core's order; opens any Holding a recipient is missing first. */
  private async payoutAccounts(payer: ChainSigner, matchId: bigint, result: Result) {
    const m: any = await this.core.account.matchState.fetch(BlockPuzzleChain.addresses(matchId).match);
    const payouts = computePayouts(m.inner, result);
    const metas: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
    for (const p of payouts) {
      const holding = BlockPuzzleChain.holding(p.recipient, p.source);
      if (!(await this.base.getAccountInfo(holding))) {
        const ix = await this.core.methods
          .openHolding()
          .accountsPartial({ payer: payer.publicKey, account: p.recipient, source: p.source, holding, systemProgram: SystemProgram.programId })
          .instruction();
        await this.sendBase(payer, [ix]);
      }
      metas.push({ pubkey: p.recipient, isSigner: false, isWritable: true }, { pubkey: holding, isSigner: false, isWritable: true });
    }
    return metas;
  }

  // ---- results ------------------------------------------------------------------------------

  async fetchSession(matchId: bigint) {
    return this.bp.account.session.fetch(BlockPuzzleChain.addresses(matchId).session) as Promise<any>;
  }

  /** Public result: readable by anyone once settled (and each Board's move log after commit). */
  async fetchResult(matchId: bigint) {
    const s = await this.fetchSession(matchId);
    const m: any = await this.core.account.matchState.fetch(BlockPuzzleChain.addresses(matchId).match);
    return {
      settled: s.settled as boolean,
      result: (["opener", "joiner", "draw"] as const)[s.result as number],
      scores: (s.scores as number[]).map(Number) as [number, number],
      matchStatus: Object.keys(m.inner.status)[0],
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

const big = (n: any) => BigInt(n.toString());
const normalize = (lines: any[]): Line[] => {
  const out: Line[] = [];
  const sorted = lines.map((l) => ({ source: pk(l.source), amount: big(l.amount) })).filter((l) => l.amount > 0n);
  sorted.sort((x, y) => keyCmp(x.source, y.source));
  for (const l of sorted) {
    const last = out[out.length - 1];
    if (last && last.source.equals(l.source)) last.amount += l.amount;
    else out.push({ ...l });
  }
  return out;
};
const take = (lines: Line[], amount: bigint): Line[] => {
  const taken: Line[] = [];
  for (const l of lines) {
    if (amount === 0n) break;
    const t = l.amount < amount ? l.amount : amount;
    if (t > 0n) {
      l.amount -= t;
      amount -= t;
      taken.push({ source: l.source, amount: t });
    }
  }
  return taken;
};
const sum = (lines: Line[]) => lines.reduce((a, l) => a + l.amount, 0n);

/** Port of `Match::settle` payouts in programs/tesoro_core/src/ledger/matches.rs (merged and sorted). */
export function computePayouts(m: any, result: Result): Payout[] {
  const out: Payout[] = [];
  const push = (recipient: PublicKey, lines: Line[]) => {
    for (const l of lines) if (l.amount > 0n) out.push({ recipient, source: l.source, amount: l.amount });
  };
  const sideA = m.a;
  const sideB = m.b;
  if (result === "draw") {
    push(pk(sideA.funder), normalize(sideA.lines));
    if (sideB) push(pk(sideB.funder), normalize(sideB.lines));
  } else {
    const [winner, loser] = result === "opener" ? [sideA, sideB] : [sideB, sideA];
    const pot = big(m.entry) * 2n;
    const platform = (pot * BigInt(m.fees.platformBps)) / 10_000n;
    const studio = (pot * BigInt(m.fees.studioBps)) / 10_000n;
    const rest = normalize(loser.lines);
    push(pk(m.fees.platformRecipient), take(rest, platform));
    push(pk(m.fees.studioRecipient), take(rest, studio));
    if (pk(winner.funder).equals(pk(winner.player)) === false) {
      const surplus = sum(rest);
      push(pk(winner.funder), normalize(winner.lines));
      const share = (surplus * BigInt(winner.shareBps)) / 10_000n;
      push(pk(winner.player), take(rest, share));
      push(pk(winner.funder), rest);
    } else {
      push(pk(winner.player), normalize(winner.lines));
      push(pk(winner.player), rest);
    }
  }
  out.sort((x, y) => keyCmp(x.recipient, y.recipient) || keyCmp(x.source, y.source));
  const merged: Payout[] = [];
  for (const p of out) {
    const last = merged[merged.length - 1];
    if (last && last.recipient.equals(p.recipient) && last.source.equals(p.source)) last.amount += p.amount;
    else merged.push({ ...p });
  }
  return merged;
}
