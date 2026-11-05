/**
 * The relayer's allow-list: which instructions it will pay for, with which accounts, signers and writable flags, and how
 * many lamports one can cost it. Pure: no network, no keys. The service (./service.ts) only builds a transaction that
 * `planTransaction` accepted, and `planTransaction` has no other way to say yes.
 *
 * Adding an instruction to the sponsored set is one row in `ROWS` plus (when it travels alone) one entry in `TX_SHAPES`.
 * A new compound shape, for instance "grow the spill, then open the Match" (ticket 09b), is one entry in `TX_SHAPES`.
 */
import { BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import { BRIDGE_ID, DISC, evmLinkPda } from "@/lib/chain/eth";
import { bookPda, ckptPda } from "@/lib/chain/basket";
import { ASSOCIATED_TOKEN_PROGRAM_ID, SIM_SOL_MINT, TOKEN_PROGRAM_ID, accountPda, protectionsPda } from "@/lib/chain/native";
import { STAKE_TOKENS } from "@/lib/chain/stake";
import { poolWithdrawAuthority, tokenAta } from "@/lib/chain/stake-pool";
import { matchIndexOf, stepSlots } from "./game-steps";
import { planBridgeBundle } from "./rules-bridge";
import { RAILCAR_ID, planRailcar } from "./rules-railcar";
import { assetOfIndex, TRADING_DUEL_PROGRAM_ID } from "@/games/trading-duel/chain";

export const CORE_ID = new PublicKey((coreIdl as { address: string }).address);
const CORE_IDL = coreIdl as unknown as Idl;
const coder = new BorshInstructionCoder(CORE_IDL);

export interface KeyMeta {
  pubkey: PublicKey;
  isSigner: boolean;
  isWritable: boolean;
}
export interface Ix {
  programId: PublicKey;
  keys: KeyMeta[];
  data: Uint8Array;
}

export class RuleError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Admission starts something new, continue moves an admitted obligation along, exit finishes or undoes one. */
export type OpClass = "admission" | "continue" | "exit";

/** What an instruction can cost the relayer, in lamports. */
export interface Spend {
  /** Fronted or deposited and returned to the relayer when the obligation closes. */
  refundable: bigint;
  /** Gone for good (rent of accounts that are never closed). */
  sunk: bigint;
}

type Args = Record<string, unknown>;

interface Row {
  class: OpClass;
  /** Account names where the relayer key may stand (payer, caller). It appears nowhere else. */
  relayer: readonly string[];
  /** How many accounts beyond the IDL's own the instruction may carry (Sources' books and pages of a chunk). */
  extra?: number;
  /** Compute unit limit the server sets. */
  cu: number;
  spend?: (args: Args) => Spend;
  /** The Player who asks must be one of the instruction's signers (an exit is the Player's own, not anyone's). */
  playerSigns?: boolean;
  /** A new Player's first transaction: no Gemas needed, one per user, counted against the daily onboarding cap (ticket 18c). */
  onboarding?: boolean;
}

/** Rent of one 144-byte line (docs: economy-notes/basket-instructions.md). */
export const LINE_RENT = 1_002_240n;
/** Rent of a checkpoint page. */
export const CKPT_PAGE_RENT = 11_971_200n;
/** Estimates of the deposits an open or join fronts besides its lines. Tuned at deploy (ticket 24), they only bound. */
export const MATCH_RECORD_RENT = 6_000_000n;
export const MATCH_SUNK = 3_000_000n;
export const TICKET_HEAD_RENT = 2_000_000n;
export const RECEIPT_RENT = 2_000_000n;
/** Size of a tesoro_core settlement receipt account (1,275,080 lamports of rent on devnet). */
export const SETTLEMENT_RECEIPT_BYTES = 123;
/** Rent of an Instant Redeem order (`InstantOrderState::SPACE` = 8+1+8+32+32+144+40+16+32+8 = 321 bytes). */
export const ORDER_RENT = (128n + 321n) * 6_960n;
/**
 * A sponsored `create_account` (ticket 18c): the basket's four starting lines come back to the sponsor when the basket
 * shrinks; the Account, the two headers and the spill never do. Estimates for the relayer's float, the program's
 * `accounts_cap` is the hard limit: (128 + 61) + (128 + 8 + 128) + (128 + 8 + 128) bytes of rent, minus the lines.
 */
export const ACCOUNT_REFUNDABLE = 4n * LINE_RENT;
export const ACCOUNT_SUNK = (189n + 264n + 264n) * 6_960n;

const lines = (v: unknown) => BigInt(Number(v ?? 0));
/**
 * Many-seat (Railcar) rents the relayer fronts, all given back when the car closes: a seat page (`SeatPage`, 2,000 bytes with
 * the seat-key layout), the seat marks (Player's and seat key's, 216 bytes each) and the car's Match record. Bounds, not exact.
 */
export const SEAT_PAGE_RENT = (2_000n + 128n) * 6_960n;
export const SEAT_MARK_RENT = (216n + 128n) * 6_960n;
export const CAR_MATCH_RENT = (1_200n + 128n) * 6_960n;
/** Lines one `reserve_many_seat_room` may buy (a winner of a 100-seat car needs about 100; rent comes back on the claim). */
export const MAX_ROOM_LINES = 200;
const NONE: Spend = { refundable: 0n, sunk: 0n };

/**
 * One row per sponsored Tesoro Core instruction. Every name is checked against the IDL by the tests, so a renamed
 * instruction cannot leave a stale row.
 */
export const ROWS: Readonly<Record<string, Row>> = {
  open_match: { class: "admission", relayer: ["payer"], cu: 400_000, extra: 60, spend: (a) => ({ refundable: MATCH_RECORD_RENT + lines(a.pot_lines) * LINE_RENT, sunk: MATCH_SUNK }) },
  join_match: { class: "admission", relayer: ["payer"], cu: 400_000, extra: 60, spend: (a) => ({ refundable: MATCH_RECORD_RENT + lines(a.pot_lines) * LINE_RENT, sunk: MATCH_SUNK }) },
  open_ticket: { class: "admission", relayer: ["payer"], cu: 300_000, spend: (a) => ({ refundable: TICKET_HEAD_RENT + lines(a.lines) * LINE_RENT, sunk: 0n }) },
  grow_store_sponsored: { class: "admission", relayer: ["relayer"], cu: 200_000, spend: (a) => ({ refundable: lines(a.extra_lines) * LINE_RENT, sunk: 0n }) },
  init_ckpt_page_sponsored: { class: "admission", relayer: ["relayer"], cu: 200_000, spend: () => ({ refundable: CKPT_PAGE_RENT, sunk: 0n }) },
  stage_entry: { class: "continue", relayer: [], cu: 400_000, extra: 60 },
  claim_spill: { class: "continue", relayer: [], cu: 300_000, extra: 40 },
  // Ticket 09c: moves the lines an overflow record holds into the owner's stores; the rent goes back to whoever paid it.
  claim_overflow: { class: "exit", relayer: [], cu: 400_000, extra: 12 },
  match_chunk: { class: "exit", relayer: ["caller"], cu: 1_000_000, extra: 60 },
  // `extra`: the spills and counters, plus both funders' Protections when a refund gives their Entry Limit counts back.
  close_match: { class: "exit", relayer: ["caller", "match_payer", "pot_a_payer", "pot_b_payer"], cu: 300_000, extra: 6 },
  refund_match: { class: "exit", relayer: ["caller", "payer"], cu: 300_000, spend: () => ({ refundable: RECEIPT_RENT, sunk: 0n }) },
  cancel_ticket: { class: "exit", relayer: ["signer"], cu: 600_000, extra: 8 },
  close_ticket: { class: "exit", relayer: ["caller", "payer"], cu: 200_000 },
  close_receipt: { class: "exit", relayer: ["caller", "payer"], cu: 100_000 },
  shrink_store: { class: "exit", relayer: [], cu: 200_000 },
  redeem_from_source: { class: "exit", relayer: [], cu: 400_000, extra: 4 },
  // Ticket 18b: the Player's own exits. The Player signs as the authority, the relayer only pays the fee, so none has a
  // relayer slot. `extra` is the books (and pages) of the Sources a Redeem or an order touches.
  redeem: { class: "exit", relayer: [], cu: 600_000, extra: 60, playerSigns: true },
  redeem_prize: { class: "exit", relayer: [], cu: 400_000, extra: 12, playerSigns: true },
  // Unlock passes the payout token account, the custody and vault, and the closing Advance's Source with its book and pages as remaining accounts.
  unlock: { class: "exit", relayer: [], cu: 600_000, extra: 60, playerSigns: true },
  claim_free_yield: { class: "exit", relayer: [], cu: 300_000, playerSigns: true },
  cancel_offer: { class: "exit", relayer: [], cu: 300_000, playerSigns: true },
  cancel_request: { class: "exit", relayer: [], cu: 100_000, playerSigns: true },
  // Ticket 27: a Break or Self-Exclusion is the Player's own protection. The Player signs as the authority, the relayer only pays the fee.
  set_break: { class: "exit", relayer: [], cu: 100_000, playerSigns: true },
  set_self_exclusion: { class: "exit", relayer: [], cu: 100_000, playerSigns: true },
  cancel_instant_redeem: { class: "exit", relayer: ["owner_wallet"], cu: 400_000, extra: 12, playerSigns: true },
  expire_instant_redeem: { class: "exit", relayer: ["owner_wallet"], cu: 400_000, extra: 12, playerSigns: true },
  // The beginner pack and "return Gemas": the Player's own rent (Position, Source, book) stays the Player's, so the relayer only
  // pays the fee. They need an existing Account (the Account's own rent is the Player's too, see create_account).
  return_own: { class: "exit", relayer: [], cu: 400_000, extra: 12, playerSigns: true },
  open_native_position: { class: "admission", relayer: [], cu: 300_000, playerSigns: true },
  open_stake_position: { class: "admission", relayer: [], cu: 300_000, playerSigns: true },
  take_native_advance: { class: "admission", relayer: [], cu: 600_000, extra: 12, playerSigns: true },
  take_stake_advance: { class: "admission", relayer: [], cu: 600_000, extra: 12, playerSigns: true },
  // A sponsored order: the relayer fronts the rent as `payer` and the sponsor pays it back in the same instruction;
  // closing the order (cancel, expire or a fill) returns it to the sponsor first. Needs the sponsor account.
  request_instant_redeem: { class: "admission", relayer: ["payer"], cu: 400_000, extra: 60, playerSigns: true, spend: () => ({ refundable: ORDER_RENT, sunk: 0n }) },
  // A new Player's Account: the relayer fronts the rent as `payer` and the sponsor pays it back in the same instruction. The one
  // extra account is the Invite key's signature while the Invite gate is on (only the Invite key, see `inviteKey`).
  // Sign-up steps (ticket 18c): the Profile (and the .eth name) is a one-time permanent account, fronted by the relayer as `payer`
  // and repaid by the sponsor against `accounts_cap`; setting the EVM address needs no rent, only the fee. Not sponsored:
  // `set_name_wallet` (a second wallet must co-sign, and the relayer path has one Player signature) and the bridge's `link_evm`.
  set_profile: { class: "continue", relayer: ["payer"], cu: 200_000, playerSigns: true },
  set_name_evm: { class: "continue", relayer: ["payer"], cu: 200_000, playerSigns: true },
  set_evm_address: { class: "continue", relayer: [], cu: 100_000, playerSigns: true },
  create_account: { class: "admission", relayer: ["payer"], cu: 300_000, extra: 1, playerSigns: true, onboarding: true, spend: () => ({ refundable: ACCOUNT_REFUNDABLE, sunk: ACCOUNT_SUNK }) },
  // Many-seat Matches (Railcar, ADR 0015). A seat: the relayer fronts the Pot, the page it may create and the seat marks; all
  // come back when the seat and the car close. It travels inside Railcar's boarding shapes (rules-railcar.ts).
  join_many_seat_match: { class: "admission", relayer: ["payer"], cu: 400_000, extra: 60, spend: (a) => ({ refundable: SEAT_PAGE_RENT + 2n * SEAT_MARK_RENT + TICKET_HEAD_RENT + lines(a.pot_lines) * LINE_RENT, sunk: 0n }) },
  // The Player steps off before departure (the Player signs as caller); the mark's and Pot's rent go back to whoever paid them.
  step_off_many_seat_match: { class: "exit", relayer: ["mark_payer", "pot_payer"], cu: 400_000, extra: 60, playerSigns: true },
  // The finish of a car, permissionless: anyone's chunks, room for a winner, the closes, a refund past the car's refund time.
  many_seat_chunk: { class: "exit", relayer: ["caller"], cu: 1_000_000, extra: 60 },
  reserve_many_seat_room: { class: "exit", relayer: ["payer"], cu: 200_000, spend: (a) => ({ refundable: TICKET_HEAD_RENT + lines(a.lines) * LINE_RENT, sunk: 0n }) },
  close_many_seat: { class: "exit", relayer: ["caller", "mark_payer", "pot_payer"], cu: 300_000 },
  // Remaining: every page and who paid it (the relayer, when it did), ten pages at most.
  close_many_seat_match: { class: "exit", relayer: ["caller", "match_payer"], cu: 300_000, extra: 20 },
  refund_many_seat_match: { class: "exit", relayer: ["caller", "payer"], cu: 300_000, spend: () => ({ refundable: RECEIPT_RENT, sunk: 0n }) },
};

/**
 * The ordered instruction lists one sponsored transaction may carry. Compute budget instructions are added by the
 * server and are not listed. Ticket 09b: an open needs no room, so it travels alone; a join may be preceded by the
 * grows that buy the holds that make its settle independent of anyone's room (opener, opener funder, joiner, joiner
 * funder, outside Studio: one grow each, see `economy-notes/room-and-holds.md`). The grows are best effort, so a join
 * without them is also a shape. Several grows may travel alone (the client splits them when one transaction is too big).
 */
const MAX_GROWS = 5;
const grows = (n: number) => Array<string>(n).fill("grow_store_sponsored");
/** Rows that never travel alone: a many-seat join goes in Railcar's boarding shapes (rules-railcar.ts), with its departure check. */
const NOT_ALONE = new Set(["join_many_seat_match"]);
export const TX_SHAPES: readonly (readonly string[])[] = [
  ...Object.keys(ROWS)
    .filter((n) => !NOT_ALONE.has(n))
    .map((n) => [n]),
  ...Array.from({ length: MAX_GROWS - 1 }, (_, i) => grows(i + 2)),
  ...Array.from({ length: MAX_GROWS }, (_, i) => [...grows(i + 1), "join_match"]),
  // A Backing Ticket: the Requester opens it and stages the Backer's lines in the same transaction. The accepted Offer is
  // the Backer's consent: stage_entry of a Backing Ticket takes any signer, so the Requester is the only one.
  ["open_ticket", "stage_entry"],
  // The beginner pack (`openAndAdvance`): open the Position and take its Advance in one transaction.
  ["open_native_position", "take_native_advance"],
  ["open_stake_position", "take_stake_advance"],
];

/**
 * Ticket 27, starting a Break or Self-Exclusion: the Player's transaction may also carry the clean-up of what they left open
 * (their unjoined Matches refunded, Requests withdrawn, Offers released), up to `MAX_CLEANUP` steps, with the Break or
 * Self-Exclusion first when it travels too. The chain lets each step through only for the signer's own items.
 */
export const CLEANUP_STEPS = ["refund_match", "cancel_request", "cancel_offer"] as const;
export const MAX_CLEANUP = MAX_GROWS;
const isCleanupShape = (names: string[]) => {
  const rest = names[0] === "set_break" || names[0] === "set_self_exclusion" ? names.slice(1) : names;
  return names.length > 1 && rest.length > 0 && rest.length <= MAX_CLEANUP && rest.every((n) => (CLEANUP_STEPS as readonly string[]).includes(n));
};

/** A Game's instructions: the relayer is never an account of one, and only the Player signs. */
export const MAX_GAME_IXS = 4;
export const MAX_DATA_BYTES = 1_000;
export const MAX_IXS = MAX_GROWS + 1;
/** Priority fee the server attaches, in micro-lamports per compute unit. */
export const PRIORITY_MICROLAMPORTS = 1_000;
export const SIGNATURE_LAMPORTS = 5_000n;

interface IdlAccount {
  name: string;
  writable?: boolean;
  signer?: boolean;
  optional?: boolean;
  pda?: { seeds: { kind: string; value?: number[]; path?: string }[]; program?: { kind: string; value?: number[] } };
}
interface IdlIx {
  name: string;
  accounts: IdlAccount[];
  args: { name: string; type: unknown }[];
}
const idlIx = (name: string) => (CORE_IDL.instructions as unknown as IdlIx[]).find((i) => i.name === name);

/** A checkpoint page the relayer creates for a Source's book (`init_ckpt_page`); the service proves from the chain that the book needs it. */
export interface CkptPage {
  book: PublicKey;
  page: PublicKey;
  classId: number;
  pageNo: number;
}

/** The tesoro_core instruction an instruction is, or null. */
export function coreName(ix: Ix): string | null {
  return ix.programId.equals(CORE_ID) ? (coder.decode(Buffer.from(ix.data))?.name ?? null) : null;
}

/** The arguments of a tesoro_core instruction. */
export function coreArgs(ix: Ix): Args {
  return (coder.decode(Buffer.from(ix.data))?.data ?? {}) as Args;
}

/** One LayerZero message the relayer pays for inside a Player's transaction (keeper diet ticket 15). */
export interface BridgeSend {
  kind: "unlock" | "yield" | "instant" | "prize";
  /** The vault's address, 0x + 40 hex. */
  vault: string;
  /** The message type `quote_send` takes (10 Unlock, 11 PayYield, 12 PayInstant, 13 PayPrize). */
  msgType: number;
  feeLamports: bigint;
  /** The endpoint's send accounts, as the instruction carries them (the relayer in the payer slot). */
  send: KeyMeta[];
  holderAccount?: PublicKey;
  claim?: PublicKey;
  payout?: PublicKey;
  payoutId?: bigint;
}

export interface Plan {
  kind: "core" | "game";
  names: string[];
  class: OpClass;
  spend: Spend;
  cu: number;
  /** Accounts named like an obligation, for the exit check and the reserve. */
  obligations: PublicKey[];
  /** The pair counter of a join, for the per-pair limit. */
  pair: PublicKey | null;
  /** Signers other than the relayer. */
  signers: PublicKey[];
  /** The seat keys an entry names (`seat_signer` of open_match, join_match, open_ticket): throwaway device keys, not Accounts' wallets. */
  seatSigners?: PublicKey[];
  /** An instruction in the plan is the Player's own: the Player who asks must be one of its signers. */
  playerSigns: boolean;
  /** Accounts whose Gemas fund the admission when they are not the Player's own (the Backer of a Backing Ticket). */
  funders: PublicKey[];
  /** The transaction is a lone sponsored `create_account`: the Player has no Account (and so no Gemas) yet. */
  onboarding: boolean;
  /** The rent top-up in this transaction and the Protections account it pays for: the service proves the amount is the rent and the account is not there yet. */
  topUp?: { protections: PublicKey; lamports: bigint };
  /** The Invite key signs it too (the server adds that signature). */
  invite: boolean;
  /** An admission that needs no Gemas: the Account exists but may hold none yet (the bridge `link_evm`). */
  noGemas: boolean;
  /** LayerZero messages in the transaction, each paid in SOL by the relayer. */
  sends?: BridgeSend[];
  /** Checkpoint pages the relayer creates (rent fronted for good), to be proved needed and missing. */
  pages?: CkptPage[];
  /** Only atomic first-payout preparation; live Position and Book semantics are verified by the service. */
  setup?: {
    position: PublicKey;
    /** Null for an Unlock without checkpoint pages: it needs no Source check. */
    source: PublicKey | null;
    pages: { book: PublicKey; page: PublicKey; classId: number; pageNo: number }[];
    ata?: { address: PublicKey; mint: PublicKey };
    /** The stake pool of a staking-token payout and the update the Player put in front of it; the service rechecks both against the chain. */
    poolUpdate?: PublicKey;
    poolUpdateIx?: Ix;
  };
}

/** Compute the relayer sets aside for one `UpdateStakePoolBalance` in front of a payout (a bound, tuned at deploy). */
export const POOL_UPDATE_CU = 200_000;
/** Instruction 7 of the SPL stake pool program. */
const UPDATE_STAKE_POOL_BALANCE = 7;

/** An instruction of a known stake pool program that is `UpdateStakePoolBalance`. */
export const isPoolUpdate = (ix: Ix) => ix.data[0] === UPDATE_STAKE_POOL_BALANCE && STAKE_TOKENS.some((t) => t.poolProgram.equals(ix.programId));

/**
 * The exact shape of `updateStakePoolBalanceIx`: seven accounts, none a signer, the writable ones fixed, one data byte, the
 * pool one of our staking tokens' and the withdraw authority its PDA. The other four accounts are the pool's own and are
 * checked against the pool by the service. Returns the pool.
 */
function checkPoolUpdate(ix: Ix): PublicKey {
  const token = STAKE_TOKENS.find((t) => t.poolProgram.equals(ix.programId) && ix.keys[0]?.pubkey.equals(t.pool));
  if (!token) throw new RuleError("bad-account", "That stake pool is not one of our staking tokens'.");
  if (ix.data.length !== 1) throw new RuleError("bad-shape", "A stake pool update carries no arguments.");
  if (ix.keys.length !== 7) throw new RuleError("bad-accounts", "A stake pool update has seven accounts.");
  const writable = [true, false, true, false, true, true, false];
  if (ix.keys.some((k, i) => k.isSigner || k.isWritable !== writable[i])) throw new RuleError("bad-flags", "Stake pool update: a signer or writable flag is wrong.");
  if (!ix.keys[1].pubkey.equals(poolWithdrawAuthority(token.pool, token.poolProgram)) || !ix.keys[6].pubkey.equals(TOKEN_PROGRAM_ID)) throw new RuleError("bad-account", "Stake pool update: the withdraw authority or token program is wrong.");
  return token.pool;
}

/** A canonical first-payout prefix cannot be sponsored alone or attached to a different obligation. */
function planPreparedExit(ixs: Ix[], relayer: PublicKey, player: PublicKey): Plan {
  const terminal = ixs.at(-1)!;
  const decoded = terminal.programId.equals(CORE_ID) ? coder.decode(Buffer.from(terminal.data)) : null;
  if (!decoded || !["redeem", "request_instant_redeem", "unlock"].includes(decoded.name) || ixs.length > 32) throw new RuleError("bad-shape", "Payout setup must finish with one Redeem, Instant Redeem request or Unlock.");
  const plan = planCore([terminal], relayer);
  const def = idlIx(decoded.name)!;
  const named = new Map(def.accounts.map((a, i) => [a.name, terminal.keys[i].pubkey]));
  if (!(named.get("holder_authority") ?? named.get("owner_authority"))?.equals(player)) throw new RuleError("bad-signer", "The Player must own the payout being prepared.");
  const position = named.get("position")!;
  // An Unlock names no Source: the one it closes travels in its remaining accounts, found by the book its pages point at.
  // The service checks it is the Position's open Advance.
  const unlockSource = (book: PublicKey) => terminal.keys.slice(def.accounts.length).find((k) => k.isWritable && bookPda(k.pubkey).equals(book))?.pubkey;
  let source: PublicKey | null = named.get("source") ?? null;
  const setup: NonNullable<Plan["setup"]> = { source, position, pages: [] };
  const used = new Set<string>();
  const inPayout = (key: PublicKey) => terminal.keys.some((k) => k.pubkey.equals(key) && k.isWritable);
  let cuExtra = 0;
  for (const [at, ix] of ixs.slice(0, -1).entries()) {
    if (isPoolUpdate(ix)) {
      if (at !== 0 || setup.poolUpdate) throw new RuleError("bad-shape", "One stake pool update may open the transaction.");
      const pool = checkPoolUpdate(ix);
      // It only belongs in front of a payout of that pool's token: the payout names the pool as a read-only account.
      if (!terminal.keys.slice(def.accounts.length).some((k) => k.pubkey.equals(pool) && !k.isWritable && !k.isSigner)) throw new RuleError("bad-account", "The stake pool update must be for the pool this payout reads.");
      setup.poolUpdate = pool;
      setup.poolUpdateIx = ix;
      cuExtra = POOL_UPDATE_CU;
    } else if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      if (setup.ata || ix.keys.length !== 6 || ix.data.length !== 1 || ix.data[0] !== 1) throw new RuleError("bad-shape", "Only one idempotent payout token account may be prepared.");
      const [payer, ata, owner, mint, system, token] = ix.keys;
      const flags = [[true, true], [false, true], [false, false], [false, false], [false, false], [false, false]];
      if (ix.keys.some((k, i) => k.isSigner !== flags[i][0] || k.isWritable !== flags[i][1])) throw new RuleError("bad-flags", "Payout token account flags are invalid.");
      if (!payer.pubkey.equals(relayer) || !owner.pubkey.equals(player) || !system.pubkey.equals(SystemProgram.programId) || !token.pubkey.equals(TOKEN_PROGRAM_ID)) throw new RuleError("bad-account", "Payout token account owner or programs are invalid.");
      if (![SIM_SOL_MINT, ...STAKE_TOKENS.map((t) => t.mint)].some((m) => m.equals(mint.pubkey)) || !ata.pubkey.equals(tokenAta(player, mint.pubkey)) || !inPayout(ata.pubkey)) throw new RuleError("bad-account", "The token account must be this Player's payout account.");
      setup.ata = { address: ata.pubkey, mint: mint.pubkey };
    } else {
      const page = ix.programId.equals(CORE_ID) ? coder.decode(Buffer.from(ix.data)) : null;
      if (page?.name !== "init_ckpt_page" || ix.data.length !== 13 || ix.keys.length !== 4) throw new RuleError("bad-shape", "Only payout token and checkpoint accounts may precede a Redeem.");
      const [payer, book, address, system] = ix.keys;
      if (!source) setup.source = source = unlockSource(book.pubkey) ?? null;
      if (!source) throw new RuleError("bad-account", "The checkpoint must belong to the Source this payout closes.");
      const flags = [[true, true], [false, false], [false, true], [false, false]];
      if (ix.keys.some((k, i) => k.isSigner !== flags[i][0] || k.isWritable !== flags[i][1])) throw new RuleError("bad-flags", "Payout checkpoint flags are invalid.");
      const args = page.data as { class: number; pageNo?: number; page_no?: number };
      const pageNo = args.pageNo ?? args.page_no!;
      if (!payer.pubkey.equals(relayer) || !system.pubkey.equals(SystemProgram.programId) || !book.pubkey.equals(bookPda(source)) || !address.pubkey.equals(ckptPda(source, args.class, pageNo)) || !inPayout(book.pubkey) || !inPayout(address.pubkey) || used.has(address.pubkey.toBase58())) throw new RuleError("bad-account", "The checkpoint must belong to this payout's Source and appear only once.");
      used.add(address.pubkey.toBase58());
      setup.pages.push({ book: book.pubkey, page: address.pubkey, classId: args.class, pageNo });
    }
  }
  return { ...plan, setup, names: [...ixs.slice(0, -1).map((i) => isPoolUpdate(i) ? "update_stake_pool" : i.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) ? "payout_ata" : "init_ckpt_page"), ...plan.names], cu: Math.min(1_400_000, plan.cu + setup.pages.length * 100_000 + (setup.ata ? 50_000 : 0) + cuExtra) };
}

const seedBytes = (type: unknown, v: unknown): Buffer | null => {
  const bn = (x: unknown, n: number) => {
    const b = Buffer.alloc(n);
    b.writeBigUInt64LE(BigInt(String(x)), 0);
    return b;
  };
  if (type === "u64") return bn(v, 8);
  if (type === "pubkey") return new PublicKey(v as PublicKey).toBuffer();
  if (type === "u32") {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(Number(v));
    return b;
  }
  if (type === "u8") return Buffer.from([Number(v)]);
  return null;
};

/**
 * Seeds the IDL gets wrong: Anchor names a zero-copy account's field read (`match_state.load()?.inner.game`, the seat mark's
 * `account`) by the account alone, so these look like keys of the account itself. The program checks them; the rules do not
 * derive them.
 */
const ELIDED_SEEDS: Readonly<Record<string, readonly string[]>> = {
  join_many_seat_match: ["game_record"],
  step_off_many_seat_match: ["seat_mark", "player_counters", "player_protections", "game_record"],
  refund_many_seat_match: ["game_record"],
};

/** The PDA an IDL account is declared to be, or null when a seed reads account data we do not have. */
function expectedPda(acc: IdlAccount, ix: IdlIx, byName: Map<string, PublicKey>, args: Args): PublicKey | null {
  if (!acc.pda) return null;
  const seeds: Buffer[] = [];
  for (const s of acc.pda.seeds) {
    if (s.kind === "const") seeds.push(Buffer.from(s.value ?? []));
    else if (s.kind === "account" && s.path && !s.path.includes(".")) {
      const k = byName.get(s.path);
      if (!k) return null;
      seeds.push(k.toBuffer());
    } else if (s.kind === "arg" && s.path) {
      const b = seedBytes(ix.args.find((a) => a.name === s.path)?.type, args[s.path]);
      if (!b) return null;
      seeds.push(b);
    } else return null;
  }
  // A PDA of another program (the sim_lst Pool) names it as a constant.
  const other = acc.pda.program;
  if (other && other.kind !== "const") return null;
  return PublicKey.findProgramAddressSync(seeds, other ? new PublicKey(Uint8Array.from(other.value ?? [])) : CORE_ID)[0];
}

/** `partOf`: the instructions are part of a larger shape another planner checks (Railcar's boarding); their own shape is not checked here. */
export function planCore(ixs: Ix[], relayer: PublicKey, inviteKey?: PublicKey, partOf?: "railcar"): Plan {
  let invite = false;
  const names: string[] = [];
  let spend: Spend = { ...NONE };
  let cu = 0;
  let cls: OpClass = "exit";
  const order: OpClass[] = ["exit", "continue", "admission"];
  const obligations: PublicKey[] = [];
  let pair: PublicKey | null = null;
  const signers = new Map<string, PublicKey>();
  const funders = new Map<string, PublicKey>();
  const named: Map<string, PublicKey>[] = [];
  let playerSigns = false;
  const seatSigners = new Map<string, PublicKey>();

  for (const ix of ixs) {
    const decoded = coder.decode(Buffer.from(ix.data));
    if (!decoded) throw new RuleError("unknown-instruction", "That instruction is not one we pay for.");
    const name = decoded.name;
    const row = ROWS[name];
    const def = idlIx(name);
    if (!row || !def) throw new RuleError("unknown-instruction", `${name} is not one we pay for.`);
    if (ix.data.length > MAX_DATA_BYTES) throw new RuleError("too-large", "Instruction data is too large.");
    const args = decoded.data as Args;
    if (name === "open_match" && (args.game as PublicKey).equals(TRADING_DUEL_PROGRAM_ID) && !assetOfIndex(Number(args.asset))) throw new RuleError("bad-asset", "That Trading Duel asset is not supported.");
    if (name === "reserve_many_seat_room" && (Number(args.lines) < 1 || Number(args.lines) > MAX_ROOM_LINES)) throw new RuleError("bad-args", `Room for 1 to ${MAX_ROOM_LINES} lines at a time.`);
    const own = def.accounts.length;
    if (ix.keys.length < own || ix.keys.length > own + (row.extra ?? 0)) throw new RuleError("bad-accounts", `${name} has the wrong number of accounts.`);

    const byName = new Map<string, PublicKey>();
    def.accounts.forEach((a, i) => byName.set(a.name, ix.keys[i].pubkey));
    named.push(byName);
    // The relayer may pay or collect an order's rent only when the sponsor account is there to repay or take it back.
    for (const slot of ["payer", "owner_wallet"]) {
      if ((name.endsWith("_instant_redeem") || name === "create_account" || name === "set_profile" || name === "set_name_evm") && byName.get(slot)?.equals(relayer) && byName.get("sponsor")?.equals(CORE_ID)) {
        throw new RuleError("bad-accounts", `${name}: the relayer needs the sponsor account.`);
      }
    }
    if (row.playerSigns) playerSigns = true;

    ix.keys.forEach((k, i) => {
      const acc = def.accounts[i];
      const isRelayer = k.pubkey.equals(relayer);
      if (!acc) {
        // The Invite key's co-signature on a new Account: the one signer that is not the Player or the relayer.
        if (name === "create_account") {
          if (!inviteKey || !k.pubkey.equals(inviteKey) || !k.isSigner || k.isWritable || i !== own) throw new RuleError("bad-accounts", "create_account: the only extra account is the Invite key's signature.");
          invite = true;
          return;
        }
        // Chunk accounts beyond the IDL's: read or write, never a signer, never the relayer (except as the payer a page's
        // rent goes back to when a car closes: `close_many_seat_match` takes page, payer pairs).
        const pagePayer = name === "close_many_seat_match" && (i - own) % 2 === 1 && k.isWritable;
        if (k.isSigner || (isRelayer && !pagePayer)) throw new RuleError("bad-accounts", `${name}: extra accounts may not sign or be the relayer.`);
        return;
      }
      const placeholder = acc.optional && k.pubkey.equals(CORE_ID);
      const wantSigner = !!acc.signer;
      const wantWritable = !!acc.writable && !placeholder;
      if (k.isSigner !== wantSigner || k.isWritable !== wantWritable) {
        throw new RuleError("bad-flags", `${name}: ${acc.name} has the wrong signer or writable flag.`);
      }
      if (isRelayer && !row.relayer.includes(acc.name)) throw new RuleError("relayer-in-accounts", `${name}: the relayer may not be ${acc.name}.`);
      if (k.isSigner && !isRelayer) signers.set(k.pubkey.toBase58(), k.pubkey);
    });

    // Fixed PDAs must be the real ones.
    def.accounts.forEach((acc, i) => {
      if (acc.optional && ix.keys[i].pubkey.equals(CORE_ID)) return;
      if (ELIDED_SEEDS[name]?.includes(acc.name)) return;
      const want = expectedPda(acc, def, byName, args);
      if (want && !want.equals(ix.keys[i].pubkey)) throw new RuleError("bad-account", `${name}: ${acc.name} is not the expected address.`);
    });

    for (const n of ["match_state", "ticket"]) {
      const k = byName.get(n);
      if (k) obligations.push(k);
    }
    const funder = name === "open_ticket" ? byName.get("owner") : name === "open_match" || name === "join_match" || name === "join_many_seat_match" ? byName.get("backer_account") : undefined;
    if (funder && !funder.equals(CORE_ID)) funders.set(funder.toBase58(), funder);
    if (name === "join_match") pair = byName.get("pair") ?? null;
    const seat = byName.get("seat_signer");
    if (seat) seatSigners.set(seat.toBase58(), seat);

    names.push(name);
    const s = row.spend?.(args) ?? NONE;
    spend = { refundable: spend.refundable + s.refundable, sunk: spend.sunk + s.sunk };
    cu += row.cu;
    if (order.indexOf(row.class) > order.indexOf(cls)) cls = row.class;
  }

  if (!partOf && !TX_SHAPES.some((s) => s.length === names.length && s.every((n, i) => n === names[i])) && !isCleanupShape(names)) {
    throw new RuleError("bad-shape", `${names.join(" + ")} is not a transaction we pay for.`);
  }
  if (names.length === 2 && names[0] === "open_ticket" && names[1] === "stage_entry") {
    const [open, stage] = named;
    if (!open.get("ticket")?.equals(stage.get("ticket") as PublicKey) || !open.get("owner")?.equals(stage.get("owner") as PublicKey)) {
      throw new RuleError("bad-shape", "open_ticket and stage_entry must be for the same Ticket and Account.");
    }
    if (!open.get("authority")?.equals(stage.get("signer") as PublicKey)) throw new RuleError("bad-shape", "The Requester who opens the Ticket stages it.");
  }
  return {
    kind: "core",
    names,
    class: cls,
    spend,
    cu: Math.min(cu, 1_400_000),
    obligations: [...new Map(obligations.map((o) => [o.toBase58(), o])).values()],
    pair,
    signers: [...signers.values()],
    seatSigners: [...seatSigners.values()],
    playerSigns,
    funders: [...funders.values()],
    onboarding: names.length === 1 && names[0] === "create_account",
    invite,
    noGemas: false,
  };
}

/**
 * Size of a Protections account: `ProtectionsState::SPACE` = 8 + 1 + 32 + (40 + 8 + 8 + 48) = 145 bytes. Its rent is the
 * cluster's (`rent(PROTECTIONS_BYTES)`): the service compares the top-up with it, the rules only bound it.
 */
export const PROTECTIONS_BYTES = 145;
/** No top-up may exceed this, whatever the cluster's rent (a Protections account costs about 0.0014 SOL on devnet, 0.0019 at the old default). */
export const MAX_TOPUP_LAMPORTS = 3_000_000n;

/**
 * A first Break or Self-Exclusion for a Player with no SOL (keeper diet ticket 27). The program makes the Player the rent payer
 * of the Protections account, so the relayer first sends the Player exactly that rent. Only this shape is accepted: a System
 * transfer of the Protections rent from the relayer to the Player, directly followed by the Player's `set_break` or
 * `set_self_exclusion` (and then any clean-up steps). The service also proves the amount is the cluster's rent for the account
 * and that the Protections account is not there yet.
 */
function planProtectionTopUp(ixs: Ix[], relayer: PublicKey, player: PublicKey, inviteKey?: PublicKey): Plan {
  const bad = (why: string) => new RuleError("bad-topup", `A rent top-up is paid only as the relayer's exact Protections rent to the Player, right before their Break or Self-Exclusion: ${why}.`);
  const [transfer, ...rest] = ixs;
  const data = Buffer.from(transfer.data);
  if (!transfer.programId.equals(SystemProgram.programId) || transfer.keys.length !== 2 || data.length !== 12 || data.readUInt32LE(0) !== 2) throw bad("it is not a plain transfer");
  const [from, to] = transfer.keys;
  if (!from.pubkey.equals(relayer) || !from.isSigner || !from.isWritable || !to.pubkey.equals(player) || to.isSigner || !to.isWritable) throw bad("wrong sender or receiver");
  const lamports = data.readBigUInt64LE(4);
  if (lamports === 0n || lamports > MAX_TOPUP_LAMPORTS) throw bad("wrong amount");
  const brk = rest[0];
  const name = brk ? coreName(brk) : null;
  if ((name !== "set_break" && name !== "set_self_exclusion") || !brk.keys[0]?.pubkey.equals(player)) throw bad("no Break or Self-Exclusion follows");
  const inner = planCore(rest, relayer, inviteKey);
  return { ...inner, names: ["protections_top_up", ...inner.names], spend: { refundable: inner.spend.refundable, sunk: inner.spend.sunk + lamports }, cu: inner.cu + 1_000, topUp: { protections: protectionsPda(accountPda(player)), lamports } };
}

/** Rent of the bridge's `EvmLink` ((8 + 20 + 32 + 32 + 1) bytes + 128), which nobody gets back. */
export const EVM_LINK_RENT = (128n + 93n) * 6_960n;

/**
 * The bridge's `link_evm` with the relayer as rent payer (ticket 18c): an ETH or HYPE Player with no SOL links its EVM address.
 * The bridge cannot be repaid by the sponsor (a different program), so the rent is the relayer's own, counted as sunk against
 * the Account's lifetime limit. The shape is exact: one instruction, five accounts, the flags and PDAs the bridge expects.
 */
function planBridge(ixs: Ix[], relayer: PublicKey): Plan {
  const [ix] = ixs;
  const link = Buffer.from(DISC.link_evm, "hex");
  if (ixs.length !== 1 || ix.keys.length !== 5 || ix.data.length !== 8 + 20 + 65 || !Buffer.from(ix.data.subarray(0, 8)).equals(link)) {
    throw new RuleError("bad-shape", "Only link_evm is paid for on the bridge.");
  }
  const evm = `0x${Buffer.from(ix.data.subarray(8, 28)).toString("hex")}`;
  const [authority, owner, evmLink, system, payer] = ix.keys;
  const want: [KeyMeta, boolean, boolean][] = [[authority, true, false], [owner, false, false], [evmLink, false, true], [system, false, false], [payer, true, true]];
  want.forEach(([k, signer, writable], i) => {
    if (k.isSigner !== signer || k.isWritable !== writable) throw new RuleError("bad-flags", `link_evm: account ${i} has the wrong signer or writable flag.`);
  });
  const account = PublicKey.findProgramAddressSync([Buffer.from("account"), authority.pubkey.toBuffer()], CORE_ID)[0];
  if (!owner.pubkey.equals(account) || !evmLink.pubkey.equals(evmLinkPda(evm))) throw new RuleError("bad-account", "link_evm: an account is not the expected address.");
  if (!system.pubkey.equals(PublicKey.default)) throw new RuleError("bad-account", "link_evm: the system program is wrong.");
  if (!payer.pubkey.equals(relayer) || authority.pubkey.equals(relayer)) throw new RuleError("relayer-in-accounts", "link_evm: the relayer pays the rent and nothing else.");
  return { kind: "core", names: ["link_evm"], class: "admission", spend: { refundable: 0n, sunk: EVM_LINK_RENT }, cu: 200_000, obligations: [], pair: null, signers: [authority.pubkey], playerSigns: true, funders: [], onboarding: false, invite: false, noGemas: true };
}

/**
 * The base-layer Game instructions a Player's page may have the relayer send as `caller` (ticket 04). Every one is
 * permissionless (anyone may call it), so nobody signs but the relayer; every other Game step runs on the rollup, which
 * charges no fee. `assign_match` is the operator's, so it is not here. A new row is `name: { disc, rent }` plus its layout in
 * ./game-steps.ts (the IDL gives every account's flags; the sponsor derives every key) and its abuse tests. `rent` is what the
 * relayer fronts for good only until the keeper closes the receipt; the service replaces it with the live receipt rent.
 * Discriminators are the same in every Game.
 */
export const GAME_STEPS = {
  finalize: { disc: Buffer.from([171, 61, 218, 56, 127, 115, 12, 217]), rent: RECEIPT_RENT },
  refund_untabled: { disc: Buffer.from([86, 179, 79, 68, 70, 100, 97, 237]), rent: RECEIPT_RENT },
  /** The caller is read-only and pays nothing but the fee: the Assignment's rent goes back to its `payer` (the operator), never to the caller. */
  close_assignment: { disc: Buffer.from([180, 122, 187, 197, 166, 152, 1, 222]), rent: 0n },
} as const;
export type GameStep = keyof typeof GAME_STEPS;
export const GAME_STEP_NAMES = Object.keys(GAME_STEPS) as GameStep[];

function gameStepOf(ix: Ix): GameStep | null {
  const data = Buffer.from(ix.data);
  return GAME_STEP_NAMES.find((n) => data.equals(GAME_STEPS[n].disc)) ?? null;
}

/**
 * A listed Game's permissionless step with the relayer as `caller` (ticket 04): a Player with no SOL still settles or is
 * refunded. Every account must be the one the Game's IDL names there, derived from the Game and the Match, with exactly the
 * IDL's signer and writable flags; only the table and the operator's `payer` are left to the program. The relayer is the
 * caller and appears nowhere else.
 */
function planGameStep(ix: Ix, name: GameStep, relayer: PublicKey): Plan {
  const matchAt = matchIndexOf(ix.programId, name);
  const slots = matchAt < 0 ? null : stepSlots(ix.programId, name, matchAt, ix.keys.map((k) => k.pubkey), relayer);
  if (!slots) throw new RuleError("bad-shape", `That is not a Game ${name}.`);
  slots.forEach(({ slot, expect }, i) => {
    const k = ix.keys[i];
    if (i > 0 && k.pubkey.equals(relayer)) throw new RuleError("relayer-in-accounts", `${name}: the relayer may only be the caller.`);
    if (expect && !k.pubkey.equals(expect)) throw new RuleError("bad-accounts", `${name}: ${slot.name} is not the one for this Match.`);
    if (k.isSigner !== slot.signer || k.isWritable !== slot.writable) throw new RuleError("bad-flags", `${name}: ${slot.name} has the wrong signer or writable flag.`);
  });
  return { kind: "game", names: [name], class: "exit", spend: { refundable: GAME_STEPS[name].rent, sunk: 0n }, cu: 400_000, obligations: [ix.keys[matchAt].pubkey], pair: null, signers: [], playerSigns: false, funders: [], onboarding: false, invite: false, noGemas: false };
}

function planGame(ixs: Ix[], relayer: PublicKey, player: PublicKey): Plan {
  const program = ixs[0].programId;
  const first = ixs[0];
  const step = ixs.length === 1 && first.keys[0]?.pubkey.equals(relayer) ? gameStepOf(first) : null;
  if (step) return planGameStep(first, step, relayer);
  if (ixs.length > MAX_GAME_IXS) throw new RuleError("bad-shape", "Too many instructions.");
  const signers = new Map<string, PublicKey>();
  for (const ix of ixs) {
    if (!ix.programId.equals(program)) throw new RuleError("bad-shape", "A Game transaction calls one Game.");
    if (ix.data.length > MAX_DATA_BYTES) throw new RuleError("too-large", "Instruction data is too large.");
    for (const k of ix.keys) {
      if (k.pubkey.equals(relayer)) throw new RuleError("relayer-in-accounts", "The relayer is never an account of a Game instruction.");
      if (k.isSigner) {
        if (!k.pubkey.equals(player)) throw new RuleError("bad-signer", "Only the Player signs a Game instruction.");
        signers.set(k.pubkey.toBase58(), k.pubkey);
      }
    }
  }
  return { kind: "game", names: ixs.map(() => "game"), class: "continue", spend: NONE, cu: 400_000, obligations: [], pair: null, signers: [...signers.values()], playerSigns: false, funders: [], onboarding: false, invite: false, noGemas: false };
}

/**
 * Accepts the instructions of one sponsored transaction or throws a RuleError. `isGame` says whether a program is a
 * listed Game (the service answers from the registry).
 */
export function planTransaction(ixs: Ix[], ctx: { relayer: PublicKey; player: PublicKey; isGame: (program: PublicKey) => boolean; inviteKey?: PublicKey }): Plan {
  if (ixs.length === 0) throw new RuleError("bad-shape", "A sponsored transaction has at least one instruction.");
  if (ixs.length > 1 && ixs.some(isPoolUpdate)) return planPreparedExit(ixs, ctx.relayer, ctx.player);
  if (ixs.some((i) => i.programId.equals(BRIDGE_ID)) || ixs.every((i) => coreName(i) === "init_ckpt_page")) {
    const linkOnly = ixs.length === 1 && Buffer.from(ixs[0].data.subarray(0, 8)).equals(Buffer.from(DISC.link_evm, "hex"));
    return linkOnly ? planBridge(ixs, ctx.relayer) : planBridgeBundle(ixs, ctx.relayer, ctx.player);
  }
  if (ixs.length > 1 && ixs.slice(0, -1).some((i) => i.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) || (i.programId.equals(CORE_ID) && coder.decode(Buffer.from(i.data))?.name === "init_ckpt_page"))) return planPreparedExit(ixs, ctx.relayer, ctx.player);
  if (ixs.length > 1 && ixs.some((i) => i.programId.equals(SystemProgram.programId))) return planProtectionTopUp(ixs, ctx.relayer, ctx.player, ctx.inviteKey);
  if (ixs.some((i) => i.programId.equals(RAILCAR_ID))) return planRailcar(ixs, ctx.relayer, ctx.player, ctx.isGame);
  if (ixs.length === 0 || ixs.length > MAX_IXS) throw new RuleError("bad-shape", `A sponsored transaction has between one and ${MAX_IXS} instructions.`);
  const core = ixs.filter((i) => i.programId.equals(CORE_ID)).length;
  if (core === ixs.length) return planCore(ixs, ctx.relayer, ctx.inviteKey);
  if (core === 0 && ctx.isGame(ixs[0].programId)) return planGame(ixs, ctx.relayer, ctx.player);
  throw new RuleError("unknown-program", "That program is not one we pay for.");
}
