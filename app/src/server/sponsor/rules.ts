/**
 * The relayer's allow-list: which instructions it will pay for, with which accounts, signers and writable flags, and how
 * many lamports one can cost it. Pure: no network, no keys. The service (./service.ts) only builds a transaction that
 * `planTransaction` accepted, and `planTransaction` has no other way to say yes.
 *
 * Adding an instruction to the sponsored set is one row in `ROWS` plus (when it travels alone) one entry in `TX_SHAPES`.
 * A new compound shape, for instance "grow the spill, then open the Match" (ticket 09b), is one entry in `TX_SHAPES`.
 */
import { BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";

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
/** Rent of an Instant Redeem order (`InstantOrderState::SPACE` = 8+1+8+32+32+144+40+16+32+8 = 321 bytes). */
export const ORDER_RENT = (128n + 321n) * 6_960n;

const lines = (v: unknown) => BigInt(Number(v ?? 0));
const NONE: Spend = { refundable: 0n, sunk: 0n };

/**
 * One row per sponsored Tesoro Core instruction. Every name is checked against the IDL by the tests, so a renamed
 * instruction cannot leave a stale row.
 */
export const ROWS: Readonly<Record<string, Row>> = {
  open_match: { class: "admission", relayer: ["payer"], cu: 400_000, spend: (a) => ({ refundable: MATCH_RECORD_RENT + lines(a.pot_lines) * LINE_RENT, sunk: MATCH_SUNK }) },
  join_match: { class: "admission", relayer: ["payer"], cu: 400_000, spend: (a) => ({ refundable: MATCH_RECORD_RENT + lines(a.pot_lines) * LINE_RENT, sunk: MATCH_SUNK }) },
  open_ticket: { class: "admission", relayer: ["payer"], cu: 300_000, spend: (a) => ({ refundable: TICKET_HEAD_RENT + lines(a.lines) * LINE_RENT, sunk: 0n }) },
  grow_store_sponsored: { class: "admission", relayer: ["relayer"], cu: 200_000 },
  init_ckpt_page_sponsored: { class: "admission", relayer: ["relayer"], cu: 200_000, spend: () => ({ refundable: CKPT_PAGE_RENT, sunk: 0n }) },
  stage_entry: { class: "continue", relayer: [], cu: 400_000 },
  claim_spill: { class: "continue", relayer: [], cu: 300_000, extra: 40 },
  match_chunk: { class: "exit", relayer: ["caller"], cu: 1_000_000, extra: 60 },
  close_match: { class: "exit", relayer: ["caller", "match_payer", "pot_a_payer", "pot_b_payer"], cu: 300_000, extra: 4 },
  refund_match: { class: "exit", relayer: ["caller", "payer"], cu: 300_000, spend: () => ({ refundable: RECEIPT_RENT, sunk: 0n }) },
  cancel_ticket: { class: "exit", relayer: ["signer"], cu: 600_000, extra: 8 },
  close_ticket: { class: "exit", relayer: ["caller", "payer"], cu: 200_000 },
  close_receipt: { class: "exit", relayer: ["caller", "payer"], cu: 100_000 },
  shrink_store: { class: "exit", relayer: [], cu: 200_000 },
  redeem_from_source: { class: "exit", relayer: [], cu: 400_000, extra: 4 },
  // Ticket 18b: the Player's own exits. The Player signs as the authority, the relayer only pays the fee, so none has a
  // relayer slot. `extra` is the books (and pages) of the Sources a Redeem or an order touches.
  redeem: { class: "exit", relayer: [], cu: 600_000, extra: 12, playerSigns: true },
  redeem_prize: { class: "exit", relayer: [], cu: 400_000, extra: 12, playerSigns: true },
  unlock: { class: "exit", relayer: [], cu: 300_000, playerSigns: true },
  claim_free_yield: { class: "exit", relayer: [], cu: 300_000, playerSigns: true },
  cancel_offer: { class: "exit", relayer: [], cu: 300_000, playerSigns: true },
  cancel_request: { class: "exit", relayer: [], cu: 100_000, playerSigns: true },
  cancel_instant_redeem: { class: "exit", relayer: ["owner_wallet"], cu: 400_000, extra: 12, playerSigns: true },
  expire_instant_redeem: { class: "exit", relayer: ["owner_wallet"], cu: 400_000, extra: 12, playerSigns: true },
  // A sponsored order: the relayer fronts the rent as `payer` and the sponsor pays it back in the same instruction;
  // closing the order (cancel, expire or a fill) returns it to the sponsor first. Needs the sponsor account.
  request_instant_redeem: { class: "admission", relayer: ["payer"], cu: 400_000, extra: 12, playerSigns: true, spend: () => ({ refundable: ORDER_RENT, sunk: 0n }) },
};

/**
 * The ordered instruction lists one sponsored transaction may carry. Compute budget instructions are added by the
 * server and are not listed. Ticket 09b: when a full spill needs "grow, then open", add
 * `["grow_store_sponsored", "open_match"]` and `["grow_store_sponsored", "join_match"]` here.
 */
export const TX_SHAPES: readonly (readonly string[])[] = [
  ...Object.keys(ROWS).map((n) => [n]),
  // A Backing Ticket: the Requester opens it and stages the Backer's lines in the same transaction. The accepted Offer is
  // the Backer's consent: stage_entry of a Backing Ticket takes any signer, so the Requester is the only one.
  ["open_ticket", "stage_entry"],
];

/** A Game's instructions: the relayer is never an account of one, and only the Player signs. */
export const MAX_GAME_IXS = 4;
export const MAX_DATA_BYTES = 1_000;
export const MAX_IXS = 4;
/** Priority fee the server attaches, in micro-lamports per compute unit. */
export const PRIORITY_MICROLAMPORTS = 1_000;
export const SIGNATURE_LAMPORTS = 5_000n;

interface IdlAccount {
  name: string;
  writable?: boolean;
  signer?: boolean;
  optional?: boolean;
  pda?: { seeds: { kind: string; value?: number[]; path?: string }[] };
}
interface IdlIx {
  name: string;
  accounts: IdlAccount[];
  args: { name: string; type: unknown }[];
}
const idlIx = (name: string) => (CORE_IDL.instructions as unknown as IdlIx[]).find((i) => i.name === name);

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
  /** An instruction in the plan is the Player's own: the Player who asks must be one of its signers. */
  playerSigns: boolean;
  /** Accounts whose Gemas fund the admission when they are not the Player's own (the Backer of a Backing Ticket). */
  funders: PublicKey[];
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
  return PublicKey.findProgramAddressSync(seeds, CORE_ID)[0];
}

function planCore(ixs: Ix[], relayer: PublicKey): Plan {
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

  for (const ix of ixs) {
    const decoded = coder.decode(Buffer.from(ix.data));
    if (!decoded) throw new RuleError("unknown-instruction", "That instruction is not one we pay for.");
    const name = decoded.name;
    const row = ROWS[name];
    const def = idlIx(name);
    if (!row || !def) throw new RuleError("unknown-instruction", `${name} is not one we pay for.`);
    if (ix.data.length > MAX_DATA_BYTES) throw new RuleError("too-large", "Instruction data is too large.");
    const args = decoded.data as Args;
    const own = def.accounts.length;
    if (ix.keys.length < own || ix.keys.length > own + (row.extra ?? 0)) throw new RuleError("bad-accounts", `${name} has the wrong number of accounts.`);

    const byName = new Map<string, PublicKey>();
    def.accounts.forEach((a, i) => byName.set(a.name, ix.keys[i].pubkey));
    named.push(byName);
    // The relayer may pay or collect an order's rent only when the sponsor account is there to repay or take it back.
    for (const slot of ["payer", "owner_wallet"]) {
      if (name.endsWith("_instant_redeem") && byName.get(slot)?.equals(relayer) && byName.get("sponsor")?.equals(CORE_ID)) {
        throw new RuleError("bad-accounts", `${name}: the relayer needs the sponsor account.`);
      }
    }
    if (row.playerSigns) playerSigns = true;

    ix.keys.forEach((k, i) => {
      const acc = def.accounts[i];
      const isRelayer = k.pubkey.equals(relayer);
      if (!acc) {
        // Chunk accounts beyond the IDL's: read or write, never a signer, never the relayer.
        if (k.isSigner || isRelayer) throw new RuleError("bad-accounts", `${name}: extra accounts may not sign or be the relayer.`);
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
      const want = expectedPda(acc, def, byName, args);
      if (want && !want.equals(ix.keys[i].pubkey)) throw new RuleError("bad-account", `${name}: ${acc.name} is not the expected address.`);
    });

    for (const n of ["match_state", "ticket"]) {
      const k = byName.get(n);
      if (k) obligations.push(k);
    }
    const funder = name === "open_ticket" ? byName.get("owner") : name === "open_match" || name === "join_match" ? byName.get("backer_account") : undefined;
    if (funder && !funder.equals(CORE_ID)) funders.set(funder.toBase58(), funder);
    if (name === "join_match") pair = byName.get("pair") ?? null;

    names.push(name);
    const s = row.spend?.(args) ?? NONE;
    spend = { refundable: spend.refundable + s.refundable, sunk: spend.sunk + s.sunk };
    cu += row.cu;
    if (order.indexOf(row.class) > order.indexOf(cls)) cls = row.class;
  }

  if (!TX_SHAPES.some((s) => s.length === names.length && s.every((n, i) => n === names[i]))) {
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
    playerSigns,
    funders: [...funders.values()],
  };
}

function planGame(ixs: Ix[], relayer: PublicKey, player: PublicKey): Plan {
  const program = ixs[0].programId;
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
  return { kind: "game", names: ixs.map(() => "game"), class: "continue", spend: NONE, cu: 400_000, obligations: [], pair: null, signers: [...signers.values()], playerSigns: false, funders: [] };
}

/**
 * Accepts the instructions of one sponsored transaction or throws a RuleError. `isGame` says whether a program is a
 * listed Game (the service answers from the registry).
 */
export function planTransaction(ixs: Ix[], ctx: { relayer: PublicKey; player: PublicKey; isGame: (program: PublicKey) => boolean }): Plan {
  if (ixs.length === 0 || ixs.length > MAX_IXS) throw new RuleError("bad-shape", "A sponsored transaction has between one and four instructions.");
  const core = ixs.filter((i) => i.programId.equals(CORE_ID)).length;
  if (core === ixs.length) return planCore(ixs, ctx.relayer);
  if (core === 0 && ctx.isGame(ixs[0].programId)) return planGame(ixs, ctx.relayer, ctx.player);
  throw new RuleError("unknown-program", "That program is not one we pay for.");
}
