/**
 * Retiring the old world's money accounts after the yield-by-math upgrade (ticket 11). Pure: classifies a snapshot of every
 * tesoro_core account into retire phases that mirror the on-chain gating (programs/tesoro_core/src/instructions/retire.rs) and
 * builds the instructions from the IDL. `keeper/scripts/retire-old-accounts.ts` reads the chain and sends.
 *
 * Phases (each is sent and confirmed before the next is planned, because a later gate looks at what is gone):
 *   1. custodies (simSOL back to the owner), Positions, the Treasury, old-sized Offers, dead Requests
 *      and legacy Matches (435/915 B) and Seasons (504 B), which carry no links
 *   2. Sources of the historical 142 B layout whose Position is gone
 *   3. Holdings of the historical 90 B layout whose Source is gone (read from raw bytes: the program no longer has the type)
 *
 * Devnet state is disposable (founder, 2026-10-25): what a legacy account counted is retired with it, never migrated.
 *   4. Offers of the current layout whose reserved Sources are all gone
 */
import anchor, { type Idl, type Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import coreIdl from "../../app/src/lib/chain/idl/tesoro_core.json" with { type: "json" };
import { POSITION_SPACE } from "../../app/src/lib/chain/position-size.ts";

export const CORE = new PublicKey((coreIdl as { address: string }).address);
export const SIM_SOL_MINT = new PublicKey("3Q2VRPmdAZHutWNhE2Rof9Pdg6MnTMotXucmoD5cgAZJ");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** `State::SPACE` of the current layouts (programs/tesoro_core/src/state.rs). */
export const SPACE = { position: POSITION_SPACE, custody: 178, treasury: 143, offer: 799 } as const;
const BACKING_TTL_SECS = 24 * 60 * 60;

export type Kind = "custody" | "position" | "source" | "holding" | "offer" | "request" | "treasury" | "match" | "season";
/** Matches `RETIRE_REQUESTS_BEFORE` in tesoro_core (2026-10-20 00:00 UTC). */
export const RETIRE_REQUESTS_BEFORE = 1_792_454_400;
export const KINDS: Kind[] = ["custody", "position", "source", "holding", "offer", "request", "treasury", "match", "season"];
/** Historical lengths `retire_legacy_account` and the Source/Holding retirements accept (programs/tesoro_core/src/instructions/retire.rs). */
export const LEGACY_LEN = { source: 142, holding: 90, match: [435, 915], season: 504 } as const;

export interface Row {
  pubkey: PublicKey;
  data: Buffer;
  lamports: number;
}
export interface Snapshot {
  /** Every tesoro_core account by base58 address. */
  rows: Map<string, Row>;
  /** simSOL amount of each old vault, by vault address; absent = no such token account. */
  vaults: Map<string, bigint>;
  /** Owner simSOL associated token accounts that exist. */
  atas: Set<string>;
  now: number;
}
export interface Item {
  kind: Kind;
  key: PublicKey;
  /** Other accounts the instruction needs, by IDL account name. */
  refs: Record<string, PublicKey>;
  /** Offers: the Source of each reserved line, in order. */
  remaining?: PublicKey[];
  /** Custodies: simSOL the vault holds; Holdings: Gemas. */
  amount?: bigint;
  /** Custodies: the owner has no simSOL account yet, the instruction creates it (admin pays rent). */
  createsAta?: boolean;
}
export interface Skipped {
  kind: Kind;
  key: string;
  reason: string;
}

/** Account types the program no longer has, so the IDL does not list them: `sha256("account:HoldingState")[..8]`. */
const RETIRED_DISCRIMINATORS: [string, string][] = [["HoldingState", "593253109b4c98fe"]];
const discHex = new Map<string, string>([
  ...(coreIdl as { accounts: { name: string; discriminator: number[] }[] }).accounts.map((a): [string, string] => [a.name, Buffer.from(a.discriminator).toString("hex")]),
  ...RETIRED_DISCRIMINATORS,
]);
export const typeOf = (data: Buffer): string | undefined => {
  const hex = data.subarray(0, 8).toString("hex");
  for (const [name, d] of discHex) if (d === hex) return name;
  return undefined;
};

const pk = (b: Buffer, at: number) => new PublicKey(b.subarray(at, at + 32));
export const ataOf = (owner: PublicKey) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), SIM_SOL_MINT.toBuffer()], ATA_PROGRAM)[0];

/** Reserved Sources of an Offer in the devnet layout this script retires (with kind, applicants and lines; the program's Offer no longer has them), or null when the bytes do not decode. */
export function offerSources(d: Buffer): PublicKey[] | null {
  try {
    let off = 8 + 1 + 8 + 32 + 32 + 8 + 2;
    off += d[off] === 0 ? 33 : 1; // OfferKind::Directed(Key) | Public
    off += 1 + 8 + 8; // status, expires_at, use_by
    off += d[off] ? 33 : 1; // player
    off += d[off] ? 33 : 1; // request
    off += 4 + 32 * d.readUInt32LE(off); // applicants
    const n = d.readUInt32LE(off);
    off += 4;
    if (off + n * 41 > d.length) return null;
    return Array.from({ length: n }, (_, i) => pk(d, off + i * 41));
  } catch {
    return null;
  }
}

export interface Plan {
  phases: Item[][];
  skipped: Skipped[];
}

/** One phase against the snapshot as it is now. */
export function planPhase(s: Snapshot, phase: 1 | 2 | 3 | 4): { items: Item[]; skipped: Skipped[] } {
  const items: Item[] = [];
  const skipped: Skipped[] = [];
  const skip = (kind: Kind, key: PublicKey, reason: string) => skipped.push({ kind, key: key.toBase58(), reason });
  const gone = (k: PublicKey) => !s.rows.has(k.toBase58());
  for (const r of s.rows.values()) {
    const t = typeOf(r.data);
    const len = r.data.length;
    if (phase === 1) {
      if (t === "NativeCustody") {
        if (len === SPACE.custody) continue;
        if (len < 8 + 2 + 5 * 32 + 32) {
          skip("custody", r.pubkey, `unexpected size ${len}`);
          continue;
        }
        const owner = pk(r.data, 42);
        const vault = pk(r.data, 138);
        const amount = s.vaults.get(vault.toBase58());
        if (amount === undefined) {
          skip("custody", r.pubkey, "vault token account not found");
          continue;
        }
        const ownerToken = ataOf(owner);
        items.push({ kind: "custody", key: r.pubkey, refs: { custody: r.pubkey, vault, owner, ownerToken }, amount, createsAta: !s.atas.has(ownerToken.toBase58()) });
      } else if (t === "PositionState" && len < SPACE.position) {
        items.push({ kind: "position", key: r.pubkey, refs: { position: r.pubkey } });
      } else if (t === "Treasury" && len < SPACE.treasury) {
        items.push({ kind: "treasury", key: r.pubkey, refs: { treasury: r.pubkey } });
      } else if (t === "OfferState" && len < SPACE.offer) {
        items.push({ kind: "offer", key: r.pubkey, refs: { offer: r.pubkey }, remaining: [] });
      } else if (t === "MatchState" && (LEGACY_LEN.match as readonly number[]).includes(len)) {
        items.push({ kind: "match", key: r.pubkey, refs: { account: r.pubkey } });
      } else if (t === "SeasonState" && len === LEGACY_LEN.season) {
        items.push({ kind: "season", key: r.pubkey, refs: { account: r.pubkey } });
      } else if (t === "RequestState") {
        const expires = Number(r.data.readBigInt64LE(8 + 1 + 8 + 32 + 32 + 8));
        if (expires >= RETIRE_REQUESTS_BEFORE) skip("request", r.pubkey, "opened after the reset: never retired");
        else if (s.now > expires + BACKING_TTL_SECS) items.push({ kind: "request", key: r.pubkey, refs: { request: r.pubkey } });
        else skip("request", r.pubkey, "still inside its lifetime (retire again after it ends)");
      }
    } else if (phase === 2 && t === "SourceState") {
      const position = pk(r.data, 9);
      if (len !== LEGACY_LEN.source) skip("source", r.pubkey, "current layout: never retired");
      else if (gone(position)) items.push({ kind: "source", key: r.pubkey, refs: { source: r.pubkey, position } });
      else skip("source", r.pubkey, "its Position still exists");
    } else if (phase === 3 && t === "HoldingState") {
      const source = pk(r.data, 41);
      if (len !== LEGACY_LEN.holding) skip("holding", r.pubkey, "not the historical layout");
      else if (gone(source)) items.push({ kind: "holding", key: r.pubkey, refs: { holding: r.pubkey, source }, amount: r.data.readBigUInt64LE(74) });
      else skip("holding", r.pubkey, "its Source is current");
    } else if (phase === 4 && t === "OfferState" && len >= SPACE.offer) {
      const sources = offerSources(r.data);
      if (!sources || !sources.length) skip("offer", r.pubkey, "no reserved Source proves it old");
      else if (!sources.every(gone)) skip("offer", r.pubkey, "a reserved Source is current");
      else items.push({ kind: "offer", key: r.pubkey, refs: { offer: r.pubkey }, remaining: sources });
    }
  }
  return { items, skipped };
}

/** All phases, applying each phase's closures to a copy of the snapshot before planning the next (dry run). */
export function planAll(s: Snapshot): Plan {
  const rows = new Map(s.rows);
  const phases: Item[][] = [];
  const skipped: Skipped[] = [];
  for (const phase of [1, 2, 3, 4] as const) {
    const { items, skipped: sk } = planPhase({ ...s, rows }, phase);
    phases.push(items);
    skipped.push(...sk);
    for (const i of items) rows.delete(i.key.toBase58());
  }
  // A skip in an early phase may have been resolved by a later closure; keep only what is still skipped at the end.
  const still = skipped.filter((x) => rows.has(x.key));
  return { phases, skipped: still };
}

/** Instructions per transaction (account-count and compute limits; see the script). */
export const BATCH: Record<Kind, number> = { custody: 3, position: 10, source: 6, holding: 5, offer: 2, request: 10, treasury: 1, match: 10, season: 10 };

export function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const METHOD: Record<Kind, string> = { custody: "retireNativeCustody", position: "retirePosition", source: "retireSource", holding: "retireHolding", offer: "retireOffer", request: "retireRequest", treasury: "retireTreasury", match: "retireLegacyAccount", season: "retireLegacyAccount" };

export function coreProgram(): Program {
  return new anchor.Program(coreIdl as unknown as Idl, {} as never);
}

export async function buildIx(program: Program, admin: PublicKey, item: Item): Promise<TransactionInstruction> {
  const config = PublicKey.findProgramAddressSync([Buffer.from("config")], CORE)[0];
  const base: Record<string, PublicKey> = { admin, config };
  const accounts: Record<string, PublicKey> = { ...base };
  if (item.kind === "custody") {
    Object.assign(accounts, item.refs, { mint: SIM_SOL_MINT, tokenProgram: TOKEN_PROGRAM, associatedTokenProgram: ATA_PROGRAM, systemProgram: SystemProgram.programId });
  } else {
    Object.assign(accounts, item.refs);
  }
  const args = item.kind === "match" ? [{ match: {} }] : item.kind === "season" ? [{ season: {} }] : [];
  const builder = (program.methods as Record<string, (...a: unknown[]) => { accountsStrict(a: unknown): { remainingAccounts(a: unknown): { instruction(): Promise<TransactionInstruction> } } }>)[METHOD[item.kind]](...args);
  const remaining = item.kind === "offer" ? (item.remaining ?? []).map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })) : [];
  return builder.accountsStrict(accounts).remainingAccounts(remaining).instruction();
}
