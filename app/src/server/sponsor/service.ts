/**
 * The relayer's sponsored transactions. A Player's wallet asks for the instructions it wants paid; this module accepts
 * them against the allow-list (./rules), takes the quota (./policy), and builds the transaction itself: it adds the
 * compute budget, sets the relayer as fee payer and compiles the message. It never signs a transaction a client built:
 * the Player signs the message we built and sends it back with our MAC, and we sign (only) after the bytes match.
 *
 * Exits are not limited and not paused. Admissions hold a completion reserve for the exits they make possible.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  type AccountMeta,
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
import { GAME_IDS, gameOfProgram } from "@/lib/chain/games";
import { HIDDEN_GAMES } from "@/lib/games";
import type { GameId } from "@/lib/mock/types";
import { DemoHttpError } from "../request-auth";
import { carNamesSeatKey, isManySeat, matchNamesSeatKey, matchSides } from "../seat-keys";
import { seatMarkPda } from "@/lib/chain/many-seat";
import { TxTooLarge, checkedV0 } from "@/lib/chain/tx-size";
import { admissionFits, admit, checkOnboarding, exitFits, exitsBlocked, rentExitFits, onboardingAlertDue, onboardUserOf, recordCycle, recordFailure, takeOnboarding, type Balance, type Limits } from "./policy";
import { CORE_ID, PRIORITY_MICROLAMPORTS, PROTECTIONS_BYTES, RECEIPT_RENT, SETTLEMENT_RECEIPT_BYTES, RuleError, SIGNATURE_LAMPORTS, planTransaction, type Ix, type Plan } from "./rules";
import { EXIT_ATA_WINDOW_MS, verifyCkptPages, verifyExitSetup } from "./exit-setup";
import { matchCutPages } from "@/lib/chain/match-cut-pages";
import type { Reader } from "@/lib/chain/settle-plan";
import type { UsageStore } from "./store";
import { ChainTransactionFailed } from "./chain-send";
import { completionEffects, completionInput, holdSeeds, recoverCompletions, type CompletionChain, type HoldSeed } from "./completion";
import { releaseClosedHolds, type ClosureReads } from "./closure";
import { assetOfIndex } from "@/games/trading-duel/chain";
import { RIDE_STEP_NAMES } from "@/games/railcar/finish-steps";
import { countersPda } from "@/lib/chain/basket";
import { decodeTicketHead, type TicketFacts } from "@/lib/chain/pot-store";
import { offerPda } from "@/lib/chain/backing-ix";
import { GROW_COUNTERS_CU, GROW_COUNTERS_RENT, growIxsFor } from "@/lib/chain/grow-counters";
import { canAssign } from "./assign-ix";
import { joinOf, PlayerBusy, type Assigner, type Assignment, type LeaseRef } from "./assign";
import { admitPages, admitSends, type BridgeSendGuard } from "./bridge-sends";

const HOUR = 3_600_000;
/** How many times a Game step's cost is measured before it is called too expensive (see `checkGameStepSimulation`). */
const GAME_STEP_COST_READINGS = 3;
const DAY = 24 * HOUR;
/** A built message is good for this long (the blockhash lives about 90 s). */
export const BUILD_TTL_MS = 75_000;
/**
 * Who vouches for a build request. `wallet`: the Account's wallet signed it (every instruction is open to it). `token`: only
 * the Privy login did, so only an entry is built (the wallet and the seat key sign the transaction, which `submit` checks).
 * `seat`: the Match's seat key for this Account signed it, for the Match's own finish steps only.
 */
export type BuildAuth = { kind: "wallet" } | { kind: "token" } | { kind: "seat"; signer: PublicKey; match: PublicKey };

/** What a token-only request may build: the entry and the growth that travels with it. */
const ENTRY_NAMES = new Set(["open_match", "join_match", "open_ticket", "stage_entry", "grow_store_sponsored", "join_many_seat_match", "open_car", "check_departure"]);
/** What a seat key may ask for: a Game's finish steps and the Match's own finish, never a move of value. */
/** What a seat key may ask the sponsor for (by instruction name). */
export const SEAT_STEP_NAMES: ReadonlySet<string> = new Set([
  "finalize",
  "refund_untabled",
  "close_assignment",
  "match_chunk",
  "close_match",
  "refund_match",
  // What a Railcar page sends after boarding: the departure and every finish step (games/railcar/finish-steps.ts).
  ...RIDE_STEP_NAMES,
]);
const JOIN_SEAT_AT = (coreIdl as unknown as { instructions: { name: string; accounts: { name: string }[] }[] }).instructions.find((i) => i.name === "join_match")!.accounts.findIndex((a) => a.name === "seat_signer");

/** One rent top-up build per Account in this window: longer than a built message lives, so two cannot both land. */
const TOPUP_WINDOW_MS = 15 * 60_000;
/** Compute budget `assign_match` adds to a join (measured 28k to 36k CU). */
const ASSIGN_CU = 40_000;

export interface ChainReads extends CompletionChain, Partial<ClosureReads> {
  balance(key: PublicKey): Promise<bigint>;
  account(key: PublicKey): Promise<{ owner: PublicKey; data: Uint8Array } | null>;
  rent?(bytes: number): Promise<bigint>;
  /** The cluster's current epoch (a stake pool update is paid for only while the pool is behind it). */
  epoch?(): Promise<bigint>;
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
  /** Assigns a joined Match to a table in the join's own transaction (ticket 07); without it the keeper assigns. */
  assigner?: Assigner;
  /** What the relayer checks before it pays a LayerZero fee inside a Player's transaction (ticket 15). Without it such a transaction is refused. */
  bridgeSends?: BridgeSendGuard;
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
/** The opener's Account of an Open Match nobody has joined yet (null once it has a second Player or left Open, or when the data is not a MatchState). */
function openerAccountOf(data: Uint8Array): PublicKey | null {
  try {
    const m = matchCoder.decode("MatchState", Buffer.from(data)) as { inner: { a: { player: number[] }; b: unknown | null; stage: object } };
    return m.inner.b || !("Open" in m.inner.stage) ? null : new PublicKey(m.inner.a.player);
  } catch {
    return null;
  }
}
/** The asset a Match trades (`meta.asset`; 0 for every Game but Trading Duel), or null when the data is not a MatchState. */
function matchAssetOf(data: Uint8Array): number | null {
  try {
    return (matchCoder.decode("MatchState", Buffer.from(data)) as { inner: { meta: { asset: number } } }).inner.meta.asset;
  } catch {
    return null;
  }
}
/** The Game program of a Match (its 32 bytes), or null when the data is not a MatchState. */
function matchGameOf(data: Uint8Array): Uint8Array | null {
  try {
    return Uint8Array.from((matchCoder.decode("MatchState", Buffer.from(data)) as { inner: { game: number[] } }).inner.game);
  } catch {
    return null;
  }
}
/** The opener and number of a Match, from its data (null when it is not a MatchState or a many-seat car). */
function matchSeedOf(data: Uint8Array): HoldSeed | null {
  if (isManySeat({ owner: CORE_ID, data })) {
    const id = Buffer.from(data).subarray(8 + 1 + 4 + 32, 8 + 1 + 4 + 32 + 40);
    return { kind: "match", account: new PublicKey(id.subarray(0, 32)).toBase58(), n: id.readBigUInt64LE(32).toString() };
  }
  try {
    const m = matchCoder.decode("MatchState", Buffer.from(data)) as { inner: { id: { opener: number[]; n: { toString(): string } } } };
    return { kind: "match", account: new PublicKey(m.inner.id.opener).toBase58(), n: m.inner.id.n.toString() };
  } catch {
    return null;
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

/** What the client sends beside the instructions (`SponsorHint` in sponsor-client.ts): the Offer of a Backing Ticket it stages. */
export interface Hint {
  offer?: PublicKey;
}

export function parseHint(raw: unknown): Hint {
  const offer = (raw as { offer?: unknown } | null)?.offer;
  if (offer === undefined) return {};
  try {
    return { offer: new PublicKey(String(offer)) };
  } catch {
    throw new DemoHttpError(400, "bad-request", "Malformed request.");
  }
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
  /** A join was built without its table assignment (no table was free, or the packet was full): once the join confirms, ask for the table with `buildTable`. */
  table?: boolean;
}

interface Meta {
  completion: ReturnType<typeof completionEffects>;
  /** Where the created and ensured addresses come from, so a close can be proved without the keeper. */
  seeds?: Record<string, HoldSeed>;
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
  /** The table lease taken for the `assign_match` that rides with the join; the operator signs the transaction too. */
  assign?: { leaseKey: string; holder: string; lockKey?: string; claim?: Assignment["claim"] };
}

/** What a self-paid build's MAC covers besides its meta: that meta only proves the build to `confirmSelfPaid`, never a transaction. */
const SELF_CONFIRM = Buffer.from("self-paid-confirm");
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

interface Held {
  undo: (() => Promise<void>) | null;
  /** Gives back the day's bridge-send count when the build fails after it was taken. */
  undoSends: (() => Promise<void>) | null;
  assignment: Assignment | null;
}

/**
 * What the relayer sends for an accepted request, in order: the compute limit and price, the counter grows, the Player's
 * instructions (rebuilt from the accepted ones: the flags are those the allow-list checked), and the table assignment.
 * The sponsor compiles exactly this (`checkedV0`); the LiteSVM ride test sends exactly this.
 */
export function sponsoredInstructions(o: {
  cu: number;
  grows: TransactionInstruction[];
  ixs: { programId: PublicKey; keys: AccountMeta[]; data: Uint8Array }[];
  assignment: TransactionInstruction | null;
}): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: o.cu }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICROLAMPORTS }),
    ...o.grows,
    ...o.ixs.map((i) => new TransactionInstruction({ programId: i.programId, keys: i.keys, data: Buffer.from(i.data) })),
    ...(o.assignment ? [o.assignment] : []),
  ];
}

export class Sponsor {
  constructor(private readonly d: SponsorDeps) {}

  get relayer(): PublicKey {
    return this.d.relayer.publicKey;
  }

  async status() {
    const balance = await this.d.chain.balance(this.relayer);
    return { relayer: this.relayer.toBase58(), paused: await this.d.paused(), low: balance < this.d.lowBalance, tables: (await this.d.lookupTables()).map((t) => t.key.toBase58()) };
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
    const joins = plan.names.includes("join_match") || plan.names.includes("join_many_seat_match");
    const mustExist = plan.class === "admission" ? (joins ? plan.obligations.slice(0, 1) : []) : plan.obligations;
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

  /**
   * Gives back the float of every sponsored Match, Ticket or Pot that has since been closed, by whoever closed it. Runs before
   * an admission is weighed, so a full float frees up the moment closes are visible on chain.
   */
  private async releaseClosed(): Promise<void> {
    if (!this.d.chain.accountsTogether) return;
    try {
      await releaseClosedHolds(this.d.store, { accountsTogether: this.d.chain.accountsTogether.bind(this.d.chain) });
    } catch (e) {
      console.error("[sponsor] releasing closed holds failed", e);
    }
  }

  /**
   * `grow_counters` for each of these Accounts' counters that the instructions use and that are still the 25 bytes of an earlier
   * build: the program cannot read them otherwise, so the grow goes in front. `payer` pays its 8 bytes of rent.
   */
  private async growsFor(payer: PublicKey, accounts: PublicKey[], ixs: Ix[]): Promise<TransactionInstruction[]> {
    const used = new Set(ixs.flatMap((i) => i.keys.map((k) => k.pubkey.toBase58())));
    const keys = [...new Map(accounts.map((a) => countersPda(a)).filter((k) => used.has(k.toBase58())).map((k) => [k.toBase58(), k])).values()];
    const infos = await Promise.all(keys.map((k) => this.d.chain.account(k)));
    return growIxsFor(payer, keys, infos);
  }

  private async admitGameStep(plan: Plan, player: PublicKey, now: number): Promise<() => Promise<void>> {
    const match = plan.obligations[0];
    const a = await this.d.chain.account(match);
    // A many-seat car (Railcar) names its Players in their seat marks: `["seat", car, Account]` exists for a rider or a funder.
    const rider = a && isManySeat(a) ? !!(await this.d.chain.account(seatMarkPda(match, accountPda(player)))) : false;
    if (!a || !(rider || partiesOf(a.data).some((k) => isPlayerKey(k, player)))) throw new DemoHttpError(403, "not-your-match", "Free transactions are for the Players of a Match.");
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
  private async requireOtherSigners(plan: Plan, player: PublicKey, auth: BuildAuth, hint: Hint) {
    const seats = plan.seatSigners ?? [];
    // a seat request's key was checked by checkAuth: the Match names it for this Player
    const checked = auth.kind === "seat" ? auth.signer : null;
    for (const sg of plan.signers) {
      if (sg.equals(player) || checked?.equals(sg) || seats.some((k) => k.equals(sg)) || (await this.ticketNamesSeatKey(plan, player, sg, hint))) continue;
      await this.requireAccount(sg);
    }
  }

  /**
   * A Ticket step signed by the seat key the Ticket recorded at `open_ticket` (core checks the same), for this Player: their
   * own Entry Ticket, or a Backing Ticket they opened as the Requester of the Offer the request names (`hint.offer`).
   */
  private async ticketNamesSeatKey(plan: Plan, player: PublicKey, signer: PublicKey, hint: Hint): Promise<boolean> {
    for (const t of plan.ticketSigners ?? []) {
      if (!t.signer.equals(signer)) continue;
      const a = await this.d.chain.account(t.ticket);
      if (!a || !a.owner.equals(CORE_ID)) continue;
      let head: TicketFacts;
      try {
        head = decodeTicketHead(a.data);
      } catch {
        // not a Ticket: the signer needs an Account of its own
        continue;
      }
      if (!head.signer.equals(signer)) continue;
      if (head.kind === "entry" ? head.account.equals(accountPda(player)) : await this.requestersOffer(hint.offer, head, player)) return true;
    }
    return false;
  }

  /**
   * A Backing Ticket names the Backer and the Requester's seat key, not the Requester: the Offer the request names must be
   * core's, at its own address, name this open Ticket (the Backer's, by its number), and have this Player as its player.
   * So a free stage step always counts against the Player who asked for it.
   */
  private async requestersOffer(offer: PublicKey | undefined, head: TicketFacts, player: PublicKey): Promise<boolean> {
    if (!offer || head.state !== "open") return false;
    const a = await this.d.chain.account(offer);
    if (!a || !a.owner.equals(CORE_ID)) return false;
    let o: { nonce: BN; inner: { backer: number[]; player: number[] | null; ticket_open: boolean; ticket_nonce: BN | null } };
    try {
      o = matchCoder.decode("OfferState", Buffer.from(a.data));
    } catch {
      return false;
    }
    const backer = new PublicKey(o.inner.backer);
    return (
      offerPda(backer, BigInt(o.nonce.toString())).equals(offer) &&
      backer.equals(head.account) &&
      o.inner.ticket_open &&
      o.inner.ticket_nonce !== null &&
      BigInt(o.inner.ticket_nonce.toString()) === head.nonce &&
      o.inner.player !== null &&
      new PublicKey(o.inner.player).equals(accountPda(player))
    );
  }

  /** Refuses what the way the request was vouched for does not allow (see `BuildAuth`). */
  private async checkAuth(auth: BuildAuth, plan: Plan, ixs: Ix[], player: PublicKey) {
    if (auth.kind === "token") {
      if (plan.kind !== "core" || plan.onboarding || plan.playerSigns || !plan.names.some((n) => n !== "grow_store_sponsored") || !plan.names.every((n) => ENTRY_NAMES.has(n))) {
        throw new DemoHttpError(403, "wallet-only", "This needs your wallet.");
      }
      // Railcar's departure check is an entry step only inside a boarding transaction.
      if (plan.names.includes("check_departure") && !plan.names.includes("join_many_seat_match")) throw new DemoHttpError(403, "wallet-only", "This needs your wallet.");
    } else if (auth.kind === "seat") {
      if (!plan.names.every((n) => SEAT_STEP_NAMES.has(n))) throw new DemoHttpError(403, "wallet-only", "This needs your wallet.");
      // Checkpoint pages name a Source's book, not the Match: each must be one this Match's fee cuts will write (below).
      const pagesOnly = plan.names.every((n) => n === "init_ckpt_page");
      if (!pagesOnly && !ixs.some((i) => i.keys.some((k) => k.pubkey.equals(auth.match)))) throw new DemoHttpError(400, "bad-request", "The request names another Match than the transaction.");
      const match = await this.d.chain.account(auth.match);
      // A many-seat car names each seat's key in the seat (read through the Player's seat mark); a head-to-head Match on its sides.
      const named =
        match && isManySeat(match)
          ? await carNamesSeatKey((k) => this.d.chain.account(k), auth.match, accountPda(player), auth.signer)
          : // A cancel is the opener's, and only while the Match is Open; the seat key of the other side cannot send it.
            matchNamesSeatKey(match, accountPda(player), auth.signer, plan.names.includes("refund_match"));
      if (!named) throw new DemoHttpError(403, "not-your-seat-key", "That key is not this Player's key for the Match.");
      if (pagesOnly) {
        const needed = new Set((await matchCutPages(this.reader, auth.match)).map((k) => k.toBase58()));
        if (!(plan.pages ?? []).every((p) => needed.has(p.page.toBase58()))) throw new DemoHttpError(403, "not-this-match", "This Match's settlement does not need those checkpoint pages.");
      }
    }
  }

  /** The chain reads as the shared planners take them. */
  private readonly reader: Reader = {
    many: (keys) => Promise.all(keys.map(async (k) => {
      const a = await this.d.chain.account(k);
      return a && { owner: a.owner, data: Buffer.from(a.data), lamports: 0, executable: false, rentEpoch: 0 };
    })),
  };

  /** The `assign_match` for the Match a join enters, or null (no free table, an unreadable Match, a Game we do not assign): the join then goes alone, flagged `table` so the page asks for the table once it confirms. */
  private async assignJoin(join: NonNullable<ReturnType<typeof joinOf>>, holder: string, who: string): Promise<Assignment | "busy" | "own" | null> {
    try {
      const m = await this.d.chain.account(join.match);
      const opener = m && m.owner.equals(CORE_ID) ? openerAccountOf(m.data) : null;
      const seed = m && matchSeedOf(m.data);
      // Trading Duel's assign_match refuses an unknown asset, and the join with it: such a Match is left to the keeper's refund path.
      if (join.game === "trading-duel" && assetOfIndex(matchAssetOf(m?.data ?? new Uint8Array()) ?? -1) === null) return null;
      if (opener?.equals(join.joiner)) return "own";
      return opener && seed ? await this.d.assigner!.assign(join.game, join.match, opener, join.joiner, holder, `${seed.account}-${seed.n}`, who) : null;
    } catch (e) {
      if (e instanceof PlayerBusy) return "busy";
      console.error("[sponsor] table assignment failed; the join travels alone", e);
      return null;
    }
  }

  /** `sub` is the Privy user id the request came with (null only off production), the key of the one-Account-per-user gate. */
  async build(player: PublicKey, raw: unknown, sub: string | null = null, auth: BuildAuth = { kind: "wallet" }): Promise<Built> {
    // A Game step spends the Match's tries and the day's cap when it is admitted; any failure after that gives them back.
    const held: Held = { undo: null, undoSends: null, assignment: null };
    try {
      return await this.buildWith(player, raw, sub, held, auth);
    } catch (e) {
      await held.undo?.();
      await held.undoSends?.();
      if (held.assignment) await this.d.assigner?.release(held.assignment).catch(() => undefined);
      throw e;
    }
  }

  private async buildWith(player: PublicKey, raw: unknown, sub: string | null, held: Held, auth: BuildAuth): Promise<Built> {
    const now = this.d.now();
    const who = player.toBase58();
    const ixs = parseIntent(raw);
    const hint = parseHint(raw);
    const plan = await this.plan(ixs, player);
    await this.checkAuth(auth, plan, ixs, player);
    if (plan.kind === "game" && plan.spend.refundable > 0n) plan.spend.refundable = await this.receiptRent();
    const setup = await verifyExitSetup(plan, player, this.d.chain);
    plan.spend.sunk += setup.rent + (await verifyCkptPages(plan.pages ?? [], this.d.chain));
    const grows = await this.growsFor(this.relayer, [accountPda(player), ...plan.funders, ...plan.signers.map(accountPda)], ixs);
    plan.cu += GROW_COUNTERS_CU * grows.length;
    plan.spend.sunk += GROW_COUNTERS_RENT * BigInt(grows.length);
    if (setup.ataGrant && await this.d.store.used(setup.ataGrant, EXIT_ATA_WINDOW_MS, now) >= 1) throw new DemoHttpError(409, "setup-already-funded", "This payout token account was already funded. Restore it using the SOL returned when it was closed.");
    if (plan.topUp) {
      // The rent is a one-time gift: nothing closes a Protections account, so it is sent only while there is none, to an Account that exists, and one build at a time
      // (otherwise several builds made before the first lands would each hand out the rent).
      if (!(await this.d.chain.account(accountPda(player)))) throw new DemoHttpError(400, "no-account", "There is no Account to protect yet.");
      if (!this.d.chain.rent) throw new DemoHttpError(503, "no-rent", "Rent cannot be read right now.");
      if (plan.topUp.lamports !== (await this.d.chain.rent(PROTECTIONS_BYTES))) throw new DemoHttpError(400, "bad-topup", "The top-up must be exactly the rent of the protections account.");
      if (await this.d.chain.account(plan.topUp.protections)) throw new DemoHttpError(409, "has-protections", "This Account's protections already exist, so a Break needs no top-up.");
      if (!(await this.d.store.take(`topup:${who}`, 1, 1, TOPUP_WINDOW_MS, now))) throw new DemoHttpError(429, "topup-limit", "A top-up for your Break was just built. Try again in a few minutes.");
    }
    if (plan.class === "admission" && !plan.signers.some((s) => s.equals(player))) throw new DemoHttpError(400, "bad-signer", "The Player must sign what is sponsored for them.");
    if (plan.playerSigns && !plan.signers.some((sg) => sg.equals(player))) throw new DemoHttpError(400, "bad-signer", "The Player must sign what is sponsored for them.");
    // Admissions and exits have separate build counters: spam on one can never use up the other (exits always work).
    // A join also carries the table assignment: the Table operator signs it and the relayer pays for that signature.
    const joining = this.d.assigner && plan.class === "admission" ? joinOf(ixs) : null;
    if (joining) plan.cu += ASSIGN_CU;
    const bucket = plan.class === "admission" ? "build" : "buildx";
    // A token-only request names its Account without proving it owns it, so it spends its own user's count, never the Account's.
    const counted = auth.kind === "token" && sub ? `user:${sub}` : who;
    if (!(await this.d.store.take(`${bucket}:${counted}`, 1, this.d.limits.buildsPerDay, DAY, now))) throw new DemoHttpError(429, "account-limit", "Too many requests today.");

    const fee = SIGNATURE_LAMPORTS * BigInt(1 + plan.signers.length + (joining ? 1 : 0)) + (BigInt(plan.cu) * BigInt(PRIORITY_MICROLAMPORTS)) / 1_000_000n;
    if (plan.class === "admission") await this.releaseClosed();
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
      await this.requireOtherSigners(plan, player, auth, hint);
      await this.requireObligations(plan);
      reserve = plan.names.some((n) => n === "open_match" || n === "join_match" || n === "open_ticket" || n === "join_many_seat_match") ? this.d.limits.completionReserve : 0n;
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
      await this.requireOtherSigners(plan, player, auth, hint);
      await this.requireObligations(plan);
      if (plan.pages?.length || plan.sends?.length) {
        const undoPages = plan.pages?.length ? await admitPages({ plan, player, now, store: this.d.store, limits: this.d.limits }) : null;
        try {
          const undoSends = plan.sends?.length ? await admitSends({ plan, player, now, store: this.d.store, limits: this.d.limits, chain: this.d.chain, guard: this.d.bridgeSends }) : null;
          held.undoSends = async () => {
            await undoSends?.();
            await undoPages?.();
          };
        } catch (e) {
          await undoPages?.();
          throw e;
        }
      }
      const gameStep = plan.kind === "game" && plan.obligations.length > 0;
      if (gameStep) held.undo = await this.admitGameStep(plan, player, now);
      const cost = fee + plan.spend.sunk + plan.spend.refundable;
      if (!(gameStep && plan.spend.refundable > 0n ? rentExitFits(balance, cost) : exitFits(balance, cost))) throw new DemoHttpError(503, "sponsor-empty", "Free transactions are unavailable. Pay the network fee from your own SOL to finish this.");
    }

    if (joining) {
      const got = await this.assignJoin(joining, randomUUID(), who);
      if (typeof got === "object" && got) held.assignment = got;
    }
    const lookupTables = await this.d.lookupTables();
    const blockhash = await this.d.chain.latestBlockhash();
    const refused: { last?: TxTooLarge } = {};
    const compile = (assignment: Assignment | null) => {
      const instructions = sponsoredInstructions({ cu: plan.cu, grows, ixs, assignment: assignment?.ix ?? null });
      try {
        const message = checkedV0(this.relayer, blockhash, instructions, lookupTables);
        return { message, bytes: message.serialize() };
      } catch (e) {
        if (!(e instanceof TxTooLarge)) throw e;
        refused.last = e;
        return null;
      }
    };
    // A Backed entry (the Backing accounts) plus a seat key and the table assignment does not fit one packet: the join then
    // goes alone and the page asks for the table once it confirms (`buildTable`).
    let compiled = compile(held.assignment);
    if (!compiled && held.assignment) {
      await this.d.assigner?.release(held.assignment).catch(() => undefined);
      held.assignment = null;
      compiled = compile(null);
    }
    if (!compiled) throw new DemoHttpError(400, "too-large", `This transaction is too large (${refused.last?.message ?? "over 1232 B"}). Prepare fewer items at a time.`);
    const { message, bytes } = compiled;
    if (held.undo) await this.checkGameStepSimulation(message, fee + plan.spend.refundable);
    const seeds = await holdSeeds(ixs, async (match) => {
      const a = await this.d.chain.account(new PublicKey(match));
      return a && a.owner.equals(CORE_ID) ? matchSeedOf(a.data) : null;
    });
    const meta: Meta = { completion: completionEffects(ixs), seeds, player: who, exp: now + BUILD_TTL_MS, reserve: reserve.toString(), fronted: fronted.toString(), cycle: plan.names.some((n) => n === "cancel_ticket" || n === "refund_match"), fee: fee.toString(), onboard, invite: plan.invite, cost: (fee + plan.spend.sunk + plan.spend.refundable).toString(), admission: plan.class === "admission", ataGrant: setup.ataGrant, assign: held.assignment ? { leaseKey: held.assignment.leaseKey, holder: held.assignment.holder, lockKey: held.assignment.lockKey, claim: held.assignment.claim } : undefined };
    const metaText = JSON.stringify(meta);
    return { message: Buffer.from(bytes).toString("base64"), meta: metaText, mac: mac(this.d.macKey, bytes, metaText), expiresAt: meta.exp, class: plan.class, ...(joining && !held.assignment ? { table: true } : {}) };
  }

  /**
   * The table for a Match whose join went out without one (`Built.table`): the operator's `assign_match` alone, in a transaction
   * the relayer pays. Asked for by a Player of the joined Match, with the wallet or the seat key the Match names; same lease and
   * pool claim as an assignment inside the join (`submit` confirms it). Never for a Match that already has its Assignment.
   */
  async buildTable(player: PublicKey, matchAddress: PublicKey, auth: BuildAuth = { kind: "wallet" }): Promise<Built> {
    if (auth.kind === "token") throw new DemoHttpError(403, "wallet-only", "This needs your wallet.");
    const assigner = this.d.assigner;
    if (!assigner) throw new DemoHttpError(503, "not-configured", "Table assignment is not configured on this server.");
    const now = this.d.now();
    const account = accountPda(player);
    const match = await this.d.chain.account(matchAddress);
    const sides = match && match.owner.equals(CORE_ID) ? matchSides(match.data) : [];
    const mine = sides.find((x) => x.player.equals(account));
    if (sides.length < 2 || !mine) throw new DemoHttpError(403, "not-your-match", "Free transactions are for the Players of a joined Match.");
    if (auth.kind === "seat" && (!auth.match.equals(matchAddress) || !mine.signer.equals(auth.signer))) throw new DemoHttpError(403, "not-your-seat-key", "That key is not this Player's key for the Match.");
    const game = gameOfProgram(new PublicKey(matchGameOf(match!.data) ?? PublicKey.default));
    const seed = matchSeedOf(match!.data);
    if (!game || !canAssign(game) || !seed) throw new DemoHttpError(400, "bad-request", "That Match has no table to assign.");
    if (game === "trading-duel" && assetOfIndex(matchAssetOf(match!.data) ?? -1) === null) throw new DemoHttpError(400, "bad-request", "That Match has no table to assign.");
    const [assignmentAddress] = PublicKey.findProgramAddressSync([Buffer.from("assign"), matchAddress.toBuffer()], GAME_IDS[game]);
    if (await this.d.chain.account(assignmentAddress)) throw new DemoHttpError(409, "assigned", "That Match already has its table.");
    const who = player.toBase58();
    if (!(await this.d.store.take(`table:${who}`, 1, this.d.limits.buildsPerDay, DAY, now))) throw new DemoHttpError(429, "account-limit", "Too many requests today.");
    let assignment: Assignment | null;
    try {
      assignment = await assigner.assign(game, matchAddress, sides[0].player, sides[1].player, randomUUID(), `${seed.account}-${seed.n}`, who);
    } catch (e) {
      if (e instanceof PlayerBusy) throw new DemoHttpError(429, "join-pending", "You already have a table request waiting. Try again in a minute.");
      throw e;
    }
    if (!assignment) throw new DemoHttpError(409, "no-table", "No table is free to assign right now.");
    try {
      const fee = SIGNATURE_LAMPORTS * 2n + (BigInt(ASSIGN_CU) * BigInt(PRIORITY_MICROLAMPORTS)) / 1_000_000n;
      const balance = await this.balance();
      await this.checkLow(balance.lamports);
      if (!exitFits(balance, fee)) throw new DemoHttpError(503, "sponsor-empty", "Free transactions are unavailable. Pay the network fee from your own SOL to finish this.");
      const message = new TransactionMessage({
        payerKey: this.relayer,
        recentBlockhash: await this.d.chain.latestBlockhash(),
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: ASSIGN_CU }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICROLAMPORTS }), assignment.ix],
      }).compileToV0Message();
      const bytes = message.serialize();
      const meta: Meta = { completion: { creates: [], ensures: [], closes: [] }, player: who, exp: now + BUILD_TTL_MS, reserve: "0", fronted: "0", cycle: false, fee: fee.toString(), onboard: null, invite: false, cost: fee.toString(), admission: false, assign: { leaseKey: assignment.leaseKey, holder: assignment.holder, lockKey: assignment.lockKey, claim: assignment.claim } };
      const metaText = JSON.stringify(meta);
      return { message: Buffer.from(bytes).toString("base64"), meta: metaText, mac: mac(this.d.macKey, bytes, metaText), expiresAt: meta.exp, class: "exit" };
    } catch (e) {
      await assigner.release(assignment).catch(() => undefined);
      throw e;
    }
  }

  /**
   * A join the Player pays for. The server adds the table assignment and signs it as the Table operator; the Player signs the
   * message and sends it. Only a lone `join_match` is accepted, with the Player as the only other signer and as fee payer, and
   * no instruction may name the operator: the operator's signature then can authorize nothing but the `assign_match` we add.
   */
  async buildSelfPaid(player: PublicKey, raw: unknown, sub: string | null = null, auth: BuildAuth = { kind: "wallet" }): Promise<{ tx: string; expiresAt: number; meta: string; mac: string }> {
    if (auth.kind === "seat") throw new DemoHttpError(403, "wallet-only", "This needs your wallet.");
    const assigner = this.d.assigner;
    if (!assigner) throw new DemoHttpError(503, "not-configured", "Table assignment is not configured on this server.");
    const now = this.d.now();
    const ixs = parseIntent(raw);
    refuseHiddenGames(ixs);
    const join = joinOf(ixs);
    const names = ixs.map((i) => (i.programId.equals(CORE_ID) ? (coreCoder.decode(Buffer.from(i.data))?.name ?? "?") : "?"));
    const joinIx = ixs[names.indexOf("join_match")];
    const lone = !!join && ixs.length === 1 && names[0] === "join_match";
    const named = lone && joinIx.keys.some((k) => k.pubkey.equals(assigner.operator));
    const seat = lone ? joinIx.keys[JOIN_SEAT_AT]?.pubkey.toBase58() : undefined;
    const signers = lone ? joinIx.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58()) : [];
    const payerOk = lone && joinIx.keys[0].pubkey.equals(player) && joinIx.keys[1].pubkey.equals(player) && join.joiner.equals(accountPda(player));
    if (!lone || named || !payerOk || signers.some((k) => k !== player.toBase58() && k !== seat)) throw new DemoHttpError(400, "bad-request", "That is not a join we can assign a table to.");
    const who = auth.kind === "token" && sub ? `user:${sub}` : player.toBase58();
    if (!(await this.d.store.take(`assignb:${who}`, 1, this.d.limits.buildsPerDay, DAY, now))) throw new DemoHttpError(429, "account-limit", "Too many requests today.");
    await this.requireAccount(player);
    const grows = await this.growsFor(player, [accountPda(player)], ixs);
    const assignment = await this.assignJoin(join, randomUUID(), who);
    if (assignment === "busy") throw new DemoHttpError(429, "join-pending", "You already have a join waiting for a table. Send it, or try again in a minute.");
    if (assignment === "own") throw new DemoHttpError(409, "cannot-join", "You cannot join your own Match.");
    if (!assignment) throw new DemoHttpError(409, "no-table", "No table is free to assign right now.");
    try {
      const instructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 + ASSIGN_CU + GROW_COUNTERS_CU * grows.length }),
        ...grows,
        ...ixs.map((i) => new TransactionInstruction({ programId: i.programId, keys: i.keys, data: Buffer.from(i.data) })),
        assignment.ix,
      ];
      let message;
      try {
        message = checkedV0(player, await this.d.chain.latestBlockhash(), instructions, await this.d.lookupTables());
      } catch (e) {
        if (e instanceof TxTooLarge) throw new DemoHttpError(400, "too-large", `This transaction is too large (${e.message}).`);
        throw e;
      }
      const tx = new VersionedTransaction(message);
      tx.sign([assigner.keypair]);
      // The Player's page sends this join itself, so only the short build lease holds the table. The pool claim waits for
      // `confirmSelfPaid`, which asks base whether the Assignment exists.
      const meta = JSON.stringify({ match: join.match.toBase58(), game: join.game, assign: { leaseKey: assignment.leaseKey, holder: assignment.holder, lockKey: assignment.lockKey, claim: assignment.claim } });
      return { tx: Buffer.from(tx.serialize()).toString("base64"), expiresAt: now + BUILD_TTL_MS, meta, mac: mac(this.d.macKey, SELF_CONFIRM, meta) };
    } catch (e) {
      await assigner.release(assignment).catch(() => undefined);
      throw e;
    }
  }

  /**
   * The Player sent the join `buildSelfPaid` made: when its Assignment exists on base (only the operator's `assign_match`, in a
   * landed transaction, creates it) the table is claimed in the pool and the build lease runs on through the start window.
   * False while the Assignment is not there yet, or when the meta is not ours.
   */
  async confirmSelfPaid(metaText: string, given: string): Promise<boolean> {
    const assigner = this.d.assigner;
    if (!assigner || !macOk(this.d.macKey, SELF_CONFIRM, metaText, given)) return false;
    const meta = JSON.parse(metaText) as { match: string; game: GameId; assign: LeaseRef };
    const program = GAME_IDS[meta.game];
    const [assignment] = PublicKey.findProgramAddressSync([Buffer.from("assign"), new PublicKey(meta.match).toBuffer()], program);
    const a = await this.d.chain.account(assignment);
    if (!a || !a.owner.equals(program)) return false;
    await assigner.confirm(meta.assign);
    return true;
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
    const operatorKey = meta.assign ? this.d.assigner?.keypair : undefined;
    if (meta.assign && !operatorKey) throw new DemoHttpError(400, "not-ours", "That is not a transaction we built.");
    const inviteKey = meta.invite ? this.d.invite?.key : undefined;
    if (meta.invite && !inviteKey) throw new DemoHttpError(400, "not-ours", "That is not a transaction we built.");
    for (let i = 1; i < required; i++) {
      if (inviteKey && keys[i].equals(inviteKey.publicKey)) continue;
      if (operatorKey && keys[i].equals(operatorKey.publicKey)) continue;
      const sig = tx.signatures[i];
      if (!sig || !nacl.sign.detached.verify(bytes, sig, keys[i].toBytes())) throw new DemoHttpError(400, "unsigned", "The transaction is not signed by the Player.");
    }
    if (meta.admission) await this.releaseClosed();
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
    tx.sign([this.d.relayer, ...(inviteKey ? [inviteKey] : []), ...(operatorKey ? [operatorKey] : [])]);

    const hasCompletion = Object.values(meta.completion).some((keys) => keys.length > 0);
    const input = hasCompletion ? completionInput(tx, meta.completion, BigInt(meta.reserve), meta.seeds ?? {}) : null;
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
      if (meta.assign && e instanceof ChainTransactionFailed && e.beforeBroadcast) await this.d.assigner?.release(meta.assign).catch(() => undefined);
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
    // The table stays held through the Match's start window; the keeper's pool snapshot drops it soon after.
    if (meta.assign) await this.d.assigner?.confirm(meta.assign).catch((e) => console.error("[sponsor] lease extend failed", e));
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
