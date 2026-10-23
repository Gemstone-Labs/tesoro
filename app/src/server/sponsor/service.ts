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
import { GAME_IDS } from "@/lib/chain/games";
import { HIDDEN_GAMES } from "@/lib/games";
import { DemoHttpError } from "../request-auth";
import { admissionFits, admit, checkOnboarding, exitFits, exitsBlocked, onboardingAlertDue, onboardUserOf, recordCycle, recordFailure, takeOnboarding, type Balance, type Limits } from "./policy";
import { CORE_ID, PRIORITY_MICROLAMPORTS, RuleError, SIGNATURE_LAMPORTS, planTransaction, type Ix, type Plan } from "./rules";
import type { UsageStore } from "./store";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A built message is good for this long (the blockhash lives about 90 s). */
export const BUILD_TTL_MS = 75_000;

export interface ChainReads {
  balance(key: PublicKey): Promise<bigint>;
  account(key: PublicKey): Promise<{ owner: PublicKey; data: Uint8Array } | null>;
  latestBlockhash(): Promise<string>;
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
  player: string;
  exp: number;
  release: string[];
  /** Obligations whose completion reserve is held once the transaction is submitted (not when it is built). */
  hold: string[];
  reserve: string;
  fronted: string;
  cycle: boolean;
  fee: string;
  /** The user counter of a sponsored new Account, taken when it is sent. */
  onboard: string | null;
  /** The Invite key signs this transaction too. */
  invite: boolean;
}

const mac = (key: Buffer, message: Uint8Array, meta: string) => createHmac("sha256", key).update(message).update("|").update(meta).digest("base64");
const macOk = (key: Buffer, message: Uint8Array, meta: string, given: string) => {
  const a = Buffer.from(mac(key, message, meta));
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
};

const refuse = (e: RuleError) => new DemoHttpError(e.code === "sponsor-paused" ? 503 : e.code.endsWith("limit") || e.code.startsWith("too-many") ? 429 : 400, e.code, e.message);

/** A hand-built request must not play a Game this environment hides: no instruction may call or name its program. */
export function refuseHiddenGames(ixs: Ix[]) {
  for (const g of HIDDEN_GAMES) {
    const id = GAME_IDS[g];
    if (ixs.some((ix) => ix.programId.equals(id) || ix.keys.some((k) => k.pubkey.equals(id)))) throw refuse(new RuleError("game-hidden", "That Game is not available."));
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
    const now = this.d.now();
    const who = player.toBase58();
    const ixs = parseIntent(raw);
    const plan = await this.plan(ixs, player);
    if (plan.class === "admission" && !plan.signers.some((s) => s.equals(player))) throw new DemoHttpError(400, "bad-signer", "The Player must sign what is sponsored for them.");
    if (plan.playerSigns && !plan.signers.some((sg) => sg.equals(player))) throw new DemoHttpError(400, "bad-signer", "The Player must sign what is sponsored for them.");
    // Admissions and exits have separate build counters: spam on one can never use up the other (exits always work).
    const bucket = plan.class === "admission" ? "build" : "buildx";
    if (!(await this.d.store.take(`${bucket}:${who}`, 1, this.d.limits.buildsPerDay, DAY, now))) throw new DemoHttpError(429, "account-limit", "Too many requests today.");

    const fee = SIGNATURE_LAMPORTS * BigInt(1 + plan.signers.length) + (BigInt(plan.cu) * BigInt(PRIORITY_MICROLAMPORTS)) / 1_000_000n;
    const balance = await this.balance();
    await this.checkLow(balance.lamports);
    const release: string[] = [];
    const hold: string[] = [];
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
      if (reserve > 0n) hold.push(...plan.obligations.map((o) => o.toBase58()));
    } else {
      if (await exitsBlocked(this.d.store, this.d.limits, who, now)) throw new DemoHttpError(429, "too-many-failures", "Too many failed transactions today. Pay the network fee from your own SOL to finish this.");
      await this.requireAccount(player);
      await this.requireOtherSigners(plan, player);
      await this.requireObligations(plan);
      if (!exitFits(balance, fee)) throw new DemoHttpError(503, "sponsor-empty", "Free transactions are unavailable. Pay the network fee from your own SOL to finish this.");
      if (plan.names.some((n) => n === "close_match" || n === "close_ticket")) release.push(...plan.obligations.map((o) => o.toBase58()));
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
    const bytes = message.serialize();
    const meta: Meta = { player: who, exp: now + BUILD_TTL_MS, release, hold, reserve: reserve.toString(), fronted: fronted.toString(), cycle: plan.names.some((n) => n === "cancel_ticket" || n === "refund_match"), fee: fee.toString(), onboard, invite: plan.invite };
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
    if (!exitFits(await this.balance(), BigInt(meta.fee))) throw new DemoHttpError(503, "sponsor-empty", "Free transactions are unavailable. Pay the network fee from your own SOL.");
    // The completion reserve is held only for transactions that are really sent, so an unsent build holds nothing.
    const held: string[] = [];
    if (meta.hold.length) {
      if (!admissionFits(this.d.limits, await this.balance(), BigInt(meta.fronted), BigInt(meta.reserve))) {
        throw new DemoHttpError(503, "sponsor-paused", "Free transactions are used up for now. You can still play: pay the network fee from your own SOL.");
      }
      for (const o of meta.hold) if (await this.d.store.hold(o, BigInt(meta.reserve))) held.push(o);
    }
    // One sponsored Account per user: the slot is taken when the transaction is really sent and given back if it fails.
    let giveBack: (() => Promise<void>) | null = null;
    if (meta.onboard) {
      try {
        giveBack = await takeOnboarding(this.d.store, this.d.limits, meta.onboard, now);
      } catch (e) {
        for (const o of held) await this.d.store.release(o);
        if (e instanceof RuleError) throw refuse(e);
        throw e;
      }
    }
    tx.sign(inviteKey ? [this.d.relayer, inviteKey] : [this.d.relayer]);

    let signature: string;
    try {
      signature = await this.d.chain.send(tx.serialize());
    } catch (e) {
      await recordFailure(this.d.store, meta.player, now);
      await giveBack?.();
      for (const o of held) await this.d.store.release(o);
      throw new DemoHttpError(502, "chain", `Transaction failed: ${(e as Error).message}`.slice(0, 300));
    }
    for (const k of meta.release) await this.d.store.release(k);
    if (meta.cycle) await recordCycle(this.d.store, meta.player, now);
    if (meta.onboard && this.d.alertOnboarding) {
      const used = await onboardingAlertDue(this.d.store, this.d.limits, now);
      if (used !== null) await this.d.alertOnboarding(used, this.d.limits.onboardPerDay).catch((e) => console.error("[sponsor] onboarding alert failed", e));
    }
    await this.checkLow(await this.d.chain.balance(this.relayer));
    return { signature };
  }
}
