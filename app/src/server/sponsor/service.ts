/**
 * The relayer's sponsored transactions. A Player's wallet asks for the instructions it wants paid; this module accepts
 * them against the allow-list (./rules), takes the quota (./policy), and builds the transaction itself: it adds the
 * compute budget, sets the relayer as fee payer and compiles the message. It never signs a transaction a client built:
 * the Player signs the message we built and sends it back with our MAC, and we sign (only) after the bytes match.
 *
 * Exits are not limited and not paused. Admissions hold a completion reserve for the exits they make possible.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import { BN, BorshAccountsCoder, BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import { gameRecordPda } from "@/lib/chain/game-record";
import { GAME_IDS } from "@/lib/chain/games";
import { HIDDEN_GAMES } from "@/lib/games";
import type { GameId } from "@/lib/mock/types";
import { DemoHttpError } from "../request-auth";
import { admissionFits, admit, checkOnboarding, exitFits, exitsBlocked, rentExitFits, onboardingAlertDue, onboardUserOf, recordCycle, recordFailure, takeOnboarding, type Balance, type Limits } from "./policy";
import { CORE_ID, PRIORITY_MICROLAMPORTS, RECEIPT_RENT, SETTLEMENT_RECEIPT_BYTES, RuleError, SIGNATURE_LAMPORTS, planTransaction, type Ix, type Plan } from "./rules";
import { EXIT_ATA_WINDOW_MS, verifyExitSetup } from "./exit-setup";
import type { UsageStore } from "./store";
import { ChainTransactionFailed } from "./chain-send";
import { completionEffects, completionInput, recoverCompletions, type CompletionChain } from "./completion";

const HOUR = 3_600_000;
/** How many times a Game step's cost is measured before it is called too expensive (see `checkGameStepSimulation`). */
const GAME_STEP_COST_READINGS = 3;
const DAY = 24 * HOUR;
/** A built message is good for this long (the blockhash lives about 90 s). */
export const BUILD_TTL_MS = 75_000;

export interface ChainReads extends CompletionChain {
  balance(key: PublicKey): Promise<bigint>;
  account(key: PublicKey): Promise<{ owner: PublicKey; data: Uint8Array } | null>;
  rent?(bytes: number): Promise<bigint>;
  latestBlockhash(): Promise<string>;
  /**
   * Runs `tx` unsigned against the chain as it is now and reports whether it would fail and what `watch` would hold after it.
   * A Game step is built only when this says it would succeed and cost the relayer no more than the fee and the receipt rent.
   */
  simulate?(tx: VersionedTransaction, watch: PublicKey): Promise<{ err: unknown; lamports: bigint | null }>;
  /** Sends and waits for confirmation; throws when the transaction fails. Returns the signature. */
  send(raw: Uint8Array): Promise<string>;
}

export interface SponsorDeps {
  relayer: Keypair;
  macKey: Buffer;
  store: UsageStore;
  limits: Limits;
  chain: ChainReads;
  /** Whether `program` is a Game in the registry, listed now. */
  isListed(program: PublicKey): Promise<boolean>;
  /** Lookup tables the server trusts for big chunk transactions. */
  lookupTables(): Promise<AddressLookupTableAccount[]>;
  /** The admission switch (env and the on-chain sponsor account). Exits ignore it. */
  paused(): Promise<boolean>;
  /** Mailed when the balance is low (at most once every four hours). */
  alertLowBalance(balance: bigint): Promise<void>;
  /** The relayer's balance below which we email. */
  lowBalance: bigint;
  /**
   * The Invite key (ADR 0012) and whether `authority` redeemed an Invite. Both are needed to co-sign a sponsored
   * `create_account` while the Invite gate is on; without them such an Account is refused.
   */
  invite?: { key: Keypair; redeemed(authority: string): Promise<boolean> };
  /** Mailed when the day's sponsored new Accounts reach `limits.onboardAlertAt` (at most once a day). */
  alertOnboarding?(used: number, max: number): Promise<void>;
  now(): number;
}

/** The Player's basket PDA, whose totals say whether the Account holds Gemas. */
const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, CORE_ID)[0];
const matchCoder = new BorshAccountsCoder(coreIdl as unknown as Idl);
/** The Player and funder keys of a Match's two parties (empty when the data is not a MatchState). */
function partiesOf(data: Uint8Array): PublicKey[] {
  try {
    const m = matchCoder.decode("MatchState", Buffer.from(data)) as { inner: { a: { player: number[]; funder: number[] }; b: { player: number[]; funder: number[] } | null } };
    return [m.inner.a, m.inner.b].flatMap((p) => (p ? [new PublicKey(p.player), new PublicKey(p.funder)] : []));
  } catch {
    return [];
  }
}
const isPlayerKey = (k: PublicKey, player: PublicKey) => k.equals(player) || k.equals(accountPda(player));
export const accountPda = (authority: PublicKey) => pda([Buffer.from("account"), authority.toBuffer()]);
export const basketPda = (account: PublicKey) => pda([Buffer.from("basket"), account.toBuffer()]);
const BASKET_OWN_AT = 8 + 40;
const BASKET_WON_AT = 8 + 48;

/** Own plus won Gemas of a basket account's data (the LineStore header, after the 8-byte discriminator). */
export function basketGemas(data: Uint8Array): bigint {
  if (data.length < BASKET_WON_AT + 8) return 0n;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return dv.getBigUint64(BASKET_OWN_AT, true) + dv.getBigUint64(BASKET_WON_AT, true);
}

export interface WireIx {
  program: string;
  keys: { pubkey: string; signer: boolean; writable: boolean }[];
  /** base64 */
  data: string;
}

export function parseIntent(raw: unknown): Ix[] {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { ixs?: unknown }).ixs)) throw new DemoHttpError(400, "bad-request", "Malformed request.");
  try {
    return ((raw as { ixs: WireIx[] }).ixs).map((w) => ({
      programId: new PublicKey(w.program),
      keys: w.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: !!k.signer, isWritable: !!k.writable })),
      data: Buffer.from(w.data, "base64"),
    }));
  } catch {
    throw new DemoHttpError(400, "bad-request", "Malformed request.");
  }
}

export interface Built {
  /** Base64 of the unsigned v0 message the Player signs. */
  message: string;
  meta: string;
  mac: string;
  expiresAt: number;
  class: Plan["class"];
}

interface Meta {
  completion: ReturnType<typeof completionEffects>;
  player: string;
  exp: number;
  reserve: string;
  fronted: string;
  cycle: boolean;
  fee: string;
  /** The user counter of a sponsored new Account, taken when it is sent. */
  onboard: string | null;
  /** The Invite key signs this transaction too. */
  invite: boolean;
  /** Full fee and rent cost authenticated with the built message. Older builds expire in75s. */
  cost?: string;
  admission?: boolean;
  ataGrant?: string | null;
}

const mac = (key: Buffer, message: Uint8Array, meta: string) => createHmac("sha256", key).update(message).update("|").update(meta).digest("base64");
const macOk = (key: Buffer, message: Uint8Array, meta: string, given: string) => {
  const a = Buffer.from(mac(key, message, meta));
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
};

const refuse = (e: RuleError) => new DemoHttpError(e.code === "sponsor-paused" ? 503 : e.code.endsWith("limit") || e.code.startsWith("too-many") ? 429 : 400, e.code, e.message);

const coreCoder = new BorshInstructionCoder(coreIdl as Idl);

const namesKey = (v: unknown, ids: Set<string>): boolean => {
  if (v instanceof PublicKey) return ids.has(v.toBase58());
  if (Array.isArray(v) || ArrayBuffer.isView(v)) {
    const bytes = Uint8Array.from(v as ArrayLike<number>);
    return bytes.length === 32 && ids.has(new PublicKey(bytes).toBase58());
  }
  if (v && typeof v === "object" && !BN.isBN(v)) return Object.values(v).some((x) => namesKey(x, ids));
  return false;
};

/**
 * A hand-built request must not play a Game this environment hides: no instruction may call or name its program,
 * name its Game record account, or carry its program id as an argument (open_match, create_request, open_ticket).
 */
export function refuseHiddenGames(ixs: Ix[], hidden: ReadonlySet<GameId> = HIDDEN_GAMES) {
  if (hidden.size === 0) return;
  const ids = new Set<string>();
  for (const g of hidden) {
    ids.add(GAME_IDS[g].toBase58());
    ids.add(gameRecordPda(GAME_IDS[g]).toBase58());
  }
  for (const ix of ixs) {
    const named = ids.has(ix.programId.toBase58()) || ix.keys.some((k) => ids.has(k.pubkey.toBase58()));
    const decoded = ix.programId.equals(CORE_ID) ? coreCoder.decode(Buffer.from(ix.data)) : null;
    if (named || (decoded && namesKey(decoded.data, ids))) throw refuse(new RuleError("game-hidden", "That Game is not available."));
  }
}

export class Sponsor {
  constructor(private readonly d: SponsorDeps) {}

  get relayer(): PublicKey {
    return this.d.relayer.publicKey;
  }

  async status() {
    const balance = await this.d.chain.balance(this.relayer);
    return { relayer: this.relayer.toBase58(), paused: await this.d.paused(), low: balance < this.d.lowBalance };
  }

  private async balance(): Promise<Balance> {
    return { lamports: await this.d.chain.balance(this.relayer), held: await this.d.store.held() };
  }

  private async checkLow(lamports: bigint) {
    if (lamports >= this.d.lowBalance) return;
    if (await this.d.store.take("lowbal-alert", 1, 1, 4 * HOUR, this.d.now())) await this.d.alertLowBalance(lamports).catch((e) => console.error("[sponsor] low-balance email failed", e));
  }

  private async plan(ixs: Ix[], player: PublicKey): Promise<Plan> {
    refuseHiddenGames(ixs);
    const listed = new Set<string>();
    for (const p of new Set(ixs.map((i) => i.programId.toBase58()))) if (p !== CORE_ID.toBase58() && (await this.d.isListed(new PublicKey(p)))) listed.add(p);
    try {
      return planTransaction(ixs, { relayer: this.relayer, player, isGame: (p) => listed.has(p.toBase58()), inviteKey: this.d.invite?.key.publicKey });
    } catch (e) {
      if (e instanceof RuleError) throw refuse(e);
      throw e;
    }
  }

  /** An obligation (Match or Ticket) must exist before it is continued or exited; an admission creates its own. */
  private async requireObligations(plan: Plan) {
    const mustExist = plan.class === "admission" ? (plan.names.includes("join_match") ? plan.obligations.slice(0, 1) : []) : plan.obligations;
    for (const key of mustExist) {
      const a = await this.d.chain.account(key);
      if (!a || !a.owner.equals(CORE_ID)) throw new DemoHttpError(400, "no-obligation", "There is nothing open there to continue.");
    }
  }

  /**
   * A Game step the relayer sends for a Player (ticket 04): the Player must be one of the Match's two Players (or their
   * funder), the Match may be sent each step a few times only, and the day's rent-fronting steps are capped overall.
   */
  private receiptRentCache: bigint | null = null;
  /** What the relayer fronts for a settlement receipt: the chain's own rent for the receipt's size, read once. */
  private async receiptRent(): Promise<bigint> {
    if (this.receiptRentCache === null) this.receiptRentCache = this.d.chain.rent ? await this.d.chain.rent(SETTLEMENT_RECEIPT_BYTES) : RECEIPT_RENT;
    return this.receiptRentCache;
  }

  private async admitGameStep(plan: Plan, player: PublicKey, now: number): Promise<() => Promise<void>> {
    const match = plan.obligations[0];
    const a = await this.d.chain.account(match);
    if (!a || !partiesOf(a.data).some((k) => isPlayerKey(k, player))) throw new DemoHttpError(403, "not-your-match", "Free transactions are for the Players of a Match.");
    const perMatch = `gstep:${match.toBase58()}:${plan.names[0]}`;
    if (!(await this.d.store.take(perMatch, 1, this.d.limits.gameStepsPerMatch, 10 * 60_000, now))) throw new DemoHttpError(429, "match-limit", "That step was already sent for this Match.");
    const rent = plan.spend.refundable > 0n;
    if (rent && !(await this.d.store.take("gstep:day", 1, this.d.limits.rentExitsPerDay, DAY, now))) {
      await this.d.store.refund(perMatch, 1, now);
      throw new DemoHttpError(503, "sponsor-empty", "Free transactions are used up for today. Pay the network fee from your own SOL to finish this.");
    }
    return async () => {
      await this.d.store.refund(perMatch, 1, now);
      if (rent) await this.d.store.refund("gstep:day", 1, now);
    };
  }

  /**
   * Runs the finished Game step against the chain before anything is signed: it must succeed, and the relayer must end up
   * poorer by no more than the fee and the receipt's rent (what the step is meant to cost).
   */
  private async checkGameStepSimulation(message: ReturnType<TransactionMessage["compileToV0Message"]>, allowed: bigint) {
    if (!this.d.chain.simulate) throw new DemoHttpError(503, "sponsor-empty", "Free transactions are unavailable. Pay the network fee from your own SOL to finish this.");
    // The RPC reports the balance after the simulation but not before it, so the cost is the gap to a balance read just ahead,
    // and any other transaction the relayer pays in between (it pays for every Player) shows up as cost. A real overspend is the
    // same every time; a concurrent spend inflates one reading. So the least cost of up to three readings decides, and a
    // concurrent refund can only lower a reading (what the instructions allow to leave is bounded by the allow-list).
    const limit = allowed + BigInt(SIGNATURE_LAMPORTS);
    let cheapest: bigint | null = null;
    for (let attempt = 0; attempt < GAME_STEP_COST_READINGS; attempt++) {
      const before = await this.d.chain.balance(this.relayer);
      const sim = await this.d.chain.simulate(new VersionedTransaction(message), this.relayer);
      if (sim.err) throw new DemoHttpError(409, "would-fail", "That step cannot go through yet.");
      if (sim.lamports === null) break;
      const cost = before - sim.lamports;
      cheapest = cheapest === null || cost < cheapest ? cost : cheapest;
      if (cheapest <= limit) return;
    }
    throw new DemoHttpError(409, "costs-too-much", "That step would cost more than the fee and the receipt.");
  }

  /** Exits and continues are for Accounts: a throwaway key cannot make the relayer pay fees. */
  private async requireAccount(authority: PublicKey) {
    const a = await this.d.chain.account(accountPda(authority));
    if (!a || !a.owner.equals(CORE_ID)) throw new DemoHttpError(403, "no-account", "Free transactions are for Accounts.");
  }

  /** A transaction with several signers (a Backing Ticket): every one of them is an Account, not a throwaway key. */
  private async requireOtherSigners(plan: Plan, player: PublicKey) {
    for (const sg of plan.signers) if (!sg.equals(player)) await this.requireAccount(sg);
  }

  /** `sub` is the Privy user id the request came with (null only off production), the key of the one-Account-per-user gate. */
  async build(player: PublicKey, raw: unknown, sub: string | null = null): Promise<Built> {
    // A Game step spends the Match's tries and the day's cap when it is admitted; any failure after that gives them back.
    const held: { undo: (() => Promise<void>) | null } = { undo: null };
    try {
      return await this.buildWith(player, raw, sub, held);
    } catch (e) {
      await held.undo?.();
      throw e;
    }
  }

  private async buildWith(player: PublicKey, raw: unknown, sub: string | null, held: { undo: (() => Promise<void>) | null }): Promise<Built> {
    const now = this.d.now();
    const who = player.toBase58();
    const ixs = parseIntent(raw);
    const plan = await this.plan(ixs, player);
    if (plan.kind === "game" && plan.spend.refundable > 0n) plan.spend.refundable = await this.receiptRent();
    const setup = await verifyExitSetup(plan, player, this.d.chain);
    plan.spend.sunk += setup.rent;
    if (setup.ataGrant && await this.d.store.used(setup.ataGrant, EXIT_ATA_WINDOW_MS, now) >= 1) throw new DemoHttpError(409, "setup-already-funded", "This payout token account was already funded. Restore it using the SOL returned when it was closed.");
    if (plan.class === "admission" && !plan.signers.some((s) => s.equals(player))) throw new DemoHttpError(400, "bad-signer", "The Player must sign what is sponsored for them.");
    if (plan.playerSigns && !plan.signers.some((sg) => sg.equals(player))) throw new DemoHttpError(400, "bad-signer", "The Player must sign what is sponsored for them.");
    // Admissions and exits have separate build counters: spam on one can never use up the other (exits always work).
    const bucket = plan.class === "admission" ? "build" : "buildx";
    if (!(await this.d.store.take(`${bucket}:${who}`, 1, this.d.limits.buildsPerDay, DAY, now))) throw new DemoHttpError(429, "account-limit", "Too many requests today.");

    const fee = SIGNATURE_LAMPORTS * BigInt(1 + plan.signers.length) + (BigInt(plan.cu) * BigInt(PRIORITY_MICROLAMPORTS)) / 1_000_000n;
    const balance = await this.balance();
    await this.checkLow(balance.lamports);
    let reserve = 0n;
    let fronted = 0n;
    let onboard: string | null = null;

    if (plan.onboarding) {
      // A new Player has no Account and no Gemas: the gate is one Account per user, a daily cap, and the Invite when it is on.
      if (plan.signers.length !== 1 || !plan.signers[0].equals(player)) throw new DemoHttpError(400, "bad-signer", "Only the Player signs a new Account.");
      if (await this.d.chain.account(accountPda(player))) throw new DemoHttpError(409, "has-account", "This wallet already has an Account.");
      if (plan.invite && !(this.d.invite && (await this.d.invite.redeemed(who)))) throw new DemoHttpError(403, "invite-required", "Redeem your Invite first.");
      onboard = onboardUserOf(sub, who);
      try {
        await checkOnboarding(this.d.store, this.d.limits, onboard, now);
      } catch (e) {
        if (e instanceof RuleError) throw refuse(e);
        throw e;
      }
    }
    if (plan.class === "admission") {
      if (await this.d.paused()) throw new DemoHttpError(503, "sponsor-paused", "Free transactions are paused. You can still play: pay the network fee from your own SOL.");
      // The Gemas that fund it must exist: the Player's own, or the Backer's when a Backer's lines are drawn.
      for (const funder of plan.onboarding || plan.noGemas ? [] : plan.funders.length ? plan.funders : [accountPda(player)]) {
        const basket = await this.d.chain.account(basketPda(funder));
        if (!basket || !basket.owner.equals(CORE_ID) || basketGemas(basket.data) === 0n) throw new DemoHttpError(403, "no-gemas", "Free transactions are for Accounts that hold Gemas.");
      }
      if (plan.funders.length || plan.noGemas) await this.requireAccount(player);
      await this.requireOtherSigners(plan, player);
      await this.requireObligations(plan);
      reserve = plan.names.some((n) => n === "open_match" || n === "join_match" || n === "open_ticket") ? this.d.limits.completionReserve : 0n;
      if (!admissionFits(this.d.limits, balance, plan.spend.refundable + plan.spend.sunk + fee, reserve)) {
        throw new DemoHttpError(503, "sponsor-paused", "Free transactions are used up for now. You can still play: pay the network fee from your own SOL.");
      }
      try {
        await admit(this.d.store, this.d.limits, plan, who, now);
      } catch (e) {
        if (e instanceof RuleError) throw refuse(e);
        throw e;
      }
      fronted = plan.spend.refundable + plan.spend.sunk + fee;
    } else {
      if (await exitsBlocked(this.d.store, this.d.limits, who, now)) throw new DemoHttpError(429, "too-many-failures", "Too many failed transactions today. Pay the network fee from your own SOL to finish this.");
      await this.requireAccount(player);
      await this.requireOtherSigners(plan, player);
      await this.requireObligations(plan);
      const gameStep = plan.kind === "game" && plan.obligations.length > 0;
      if (gameStep) held.undo = await this.admitGameStep(plan, player, now);
      const cost = fee + plan.spend.sunk + plan.spend.refundable;
      if (!(gameStep && plan.spend.refundable > 0n ? rentExitFits(balance, cost) : exitFits(balance, cost))) throw new DemoHttpError(503, "sponsor-empty", "Free transactions are unavailable. Pay the network fee from your own SOL to finish this.");
    }

    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: plan.cu }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICROLAMPORTS }),
      // Rebuilt from the accepted instructions: the flags are the ones the allow-list checked.
      ...ixs.map((i) => new TransactionInstruction({ programId: i.programId, keys: i.keys, data: Buffer.from(i.data) })),
    ];
    const message = new TransactionMessage({ payerKey: this.relayer, recentBlockhash: await this.d.chain.latestBlockhash(), instructions }).compileToV0Message(
      await this.d.lookupTables(),
    );
    let bytes: Uint8Array;
    try {
      bytes = message.serialize();
      if (new VersionedTransaction(message).serialize().length > 1232) throw new RangeError("packet size");
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      throw new DemoHttpError(400, "too-large", "This transaction is too large. Prepare fewer items at a time.");
    }
    if (held.undo) await this.checkGameStepSimulation(message, fee + plan.spend.refundable);
    const meta: Meta = { completion: completionEffects(ixs), player: who, exp: now + BUILD_TTL_MS, reserve: reserve.toString(), fronted: fronted.toString(), cycle: plan.names.some((n) => n === "cancel_ticket" || n === "refund_match"), fee: fee.toString(), onboard, invite: plan.invite, cost: (fee + plan.spend.sunk + plan.spend.refundable).toString(), admission: plan.class === "admission", ataGrant: setup.ataGrant };
    const metaText = JSON.stringify(meta);
    return { message: Buffer.from(bytes).toString("base64"), meta: metaText, mac: mac(this.d.macKey, bytes, metaText), expiresAt: meta.exp, class: plan.class };
  }

  /** Signs as fee payer and sends the message we built, once the Player's signature is on it. */
  async submit(txBase64: string, metaText: string, given: string): Promise<{ signature: string }> {
    const now = this.d.now();
    let tx: VersionedTransaction;
    try {
      tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
    } catch {
      throw new DemoHttpError(400, "bad-request", "Malformed transaction.");
    }
    const bytes = tx.message.serialize();
    if (!macOk(this.d.macKey, bytes, metaText, given)) throw new DemoHttpError(400, "not-ours", "That is not a transaction we built.");
    const meta = JSON.parse(metaText) as Meta;
    if (!meta.completion) throw new DemoHttpError(409, "rebuild", "Build this transaction again.");
    if (now > meta.exp) throw new DemoHttpError(400, "expired", "That transaction expired. Try again.");

    const keys = tx.message.staticAccountKeys;
    const required = tx.message.header.numRequiredSignatures;
    if (!keys[0].equals(this.relayer)) throw new DemoHttpError(400, "not-ours", "That is not a transaction we built.");
    const inviteKey = meta.invite ? this.d.invite?.key : undefined;
    if (meta.invite && !inviteKey) throw new DemoHttpError(400, "not-ours", "That is not a transaction we built.");
    for (let i = 1; i < required; i++) {
      if (inviteKey && keys[i].equals(inviteKey.publicKey)) continue;
      const sig = tx.signatures[i];
      if (!sig || !nacl.sign.detached.verify(bytes, sig, keys[i].toBytes())) throw new DemoHttpError(400, "unsigned", "The transaction is not signed by the Player.");
    }
    if (!exitFits(await this.balance(), BigInt(meta.cost ?? meta.fee))) throw new DemoHttpError(503, "sponsor-empty", "Free transactions are unavailable. Pay the network fee from your own SOL.");
    // The completion reserve is held only for transactions that are really sent, so an unsent build holds nothing.
    if (meta.admission) {
      if (!admissionFits(this.d.limits, await this.balance(), BigInt(meta.fronted), BigInt(meta.reserve))) {
        throw new DemoHttpError(503, "sponsor-paused", "Free transactions are used up for now. You can still play: pay the network fee from your own SOL.");
      }
    }
    // One sponsored Account per user: the slot is taken when the transaction is really sent and given back if it fails.
    let giveBack: (() => Promise<void>) | null = null;
    if (meta.onboard) {
      try {
        giveBack = await takeOnboarding(this.d.store, this.d.limits, meta.onboard, now);
      } catch (e) {
        if (e instanceof RuleError) throw refuse(e);
        throw e;
      }
    }
    if (meta.ataGrant && !(await this.d.store.take(meta.ataGrant, 1, 1, EXIT_ATA_WINDOW_MS, now))) {
      await giveBack?.();
      throw new DemoHttpError(409, "setup-already-funded", "This payout token account was already funded.");
    }
    tx.sign(inviteKey ? [this.d.relayer, inviteKey] : [this.d.relayer]);

    const hasCompletion = Object.values(meta.completion).some((keys) => keys.length > 0);
    const input = hasCompletion ? completionInput(tx, meta.completion, BigInt(meta.reserve)) : null;
    let fresh: boolean;
    try {
      fresh = input ? await this.d.store.prepareCompletion(input) : true;
    } catch (e) {
      await giveBack?.();
      if (meta.ataGrant) await this.d.store.refund(meta.ataGrant, 1, now);
      throw e;
    }
    let signature: string;
    try {
      signature = await this.d.chain.send(tx.serialize());
    } catch (e) {
      await recordFailure(this.d.store, meta.player, now);
      if (e instanceof ChainTransactionFailed && e.beforeBroadcast && fresh) {
        if (input) await this.d.store.finishCompletion(input.signature, false, true);
        await giveBack?.();
      }
      if (e instanceof ChainTransactionFailed && !e.beforeBroadcast) {
        if (input) await recoverCompletions(this.d.store, this.d.chain);
        await giveBack?.();
      }
      // An unknown broadcast outcome retains the grant: it may still land. Definite atomic failures spent no rent.
      if (meta.ataGrant && e instanceof ChainTransactionFailed && (e.beforeBroadcast ? fresh : true)) await this.d.store.refund(meta.ataGrant, 1, now);
      throw new DemoHttpError(502, "chain", `Transaction failed: ${(e as Error).message}`.slice(0, 300));
    }
    // Accounting failures after a successful send leave durable work for the keeper, without refunding admission holds.
    if (input) await recoverCompletions(this.d.store, this.d.chain, 1).catch((e) => console.error("[sponsor] completion recovery pending", e));
    if (meta.cycle && fresh) await recordCycle(this.d.store, meta.player, now);
    if (meta.onboard && this.d.alertOnboarding) {
      const used = await onboardingAlertDue(this.d.store, this.d.limits, now);
      if (used !== null) await this.d.alertOnboarding(used, this.d.limits.onboardPerDay).catch((e) => console.error("[sponsor] onboarding alert failed", e));
    }
    await this.checkLow(await this.d.chain.balance(this.relayer));
    return { signature };
  }
}
