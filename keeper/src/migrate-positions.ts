// Ticket 55 sweep: after tesoro_core gains `stake_rate_high`, every 235-byte Position is rewritten in the 243-byte layout by the
// admin (`migrate_position`). Planning and checks only; keeper/scripts/migrate-positions-55.ts runs the steps.
import { createHash } from "node:crypto";
import type { Program } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { LEGACY_POSITION_SPACE, POSITION_SPACE } from "../../app/src/lib/chain/position-size.ts";

/**
 * Compute of one `migrate_position` on a 235-byte Position, measured in LiteSVM (programs/tesoro_core/tests/stake_audit/cu.rs
 * `cu_report_migrate_position`, 2026-10-28): 7,492 alone, 74,550 for ten in one transaction.
 */
export const MIGRATE_POSITION_CU = 7_500;
/** The compute limit asked for each migration: the measurement with a third on top. */
export const MIGRATE_CU_LIMIT = 10_000;
/**
 * Positions migrated per transaction: the most that fit the 1,232-byte transaction limit (each adds its 32-byte key and a 15-byte
 * instruction; migrate-positions.test.ts serialises the batch and one more). Compute is far from binding: 20 x 10,000 = 200,000.
 */
export const MIGRATIONS_PER_TX = 20;
/** Each Position's share of a transaction fee (5,000 lamports a signature). */
export const MIGRATE_FEE_LAMPORTS = 5_000n / BigInt(MIGRATIONS_PER_TX) + 1n;
/** Bytes `solana program write-buffer` sends per transaction (under a 1,232-byte packet), for its fee estimate. */
const WRITE_CHUNK_BYTES = 900;

/** Genesis hashes: every RPC the run uses is checked against the cluster it is meant for. */
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

/** Program upgrades with the shared deployer key, matched in `pgrep -f` (the Dungeons & Moles session deploys with it too). */
export const UPGRADE_PATTERN = "solana program (deploy|write-buffer|extend|upgrade)|anchor (deploy|upgrade)";

export type PositionRow = { pubkey: PublicKey; data: Buffer };

/** Byte of `open_advance`'s tag; every later field sits 4 bytes further when it is Some. */
const TAG_AT = 122;
/** Offset of the first field after `last_seq` and `cumulative_yield` (free_yield). */
const tail = (d: Buffer) => TAG_AT + (d[TAG_AT] === 1 ? 5 : 1) + 16;
const stakeRateOpen = (d: Buffer) => d.readBigUInt64LE(tail(d) + 42);

/** The Positions still in the 235-byte layout (all, and the stake ones), and how many are current. */
export function classify(rows: PositionRow[]) {
  const legacy = rows.filter((r) => r.data.length === LEGACY_POSITION_SPACE);
  return {
    legacy,
    legacyStake: legacy.filter((r) => stakeRateOpen(r.data) !== 0n),
    current: rows.filter((r) => r.data.length === POSITION_SPACE).length,
  };
}

/**
 * Legacy stake Locks (no lifetime cap on their old Sources) whose holders are owed more whole shares than their custody still holds:
 * their Unlock needs the Treasury's spendable shares to cover `excess`, else it is refused (GrowthClaimsUnfunded, design-v4 5).
 */
export function excessClaims(rows: PositionRow[]): { position: PublicKey; excess: bigint }[] {
  return rows.flatMap((r) => {
    const d = r.data;
    if (stakeRateOpen(d) === 0n) return [];
    const o = tail(d);
    const custody = d.readBigUInt64LE(o + 32);
    const held = d.readBigUInt64LE(o + 50) + (d.readBigUInt64LE(o + 58) << 64n);
    const paid = d.readBigUInt64LE(o + 82);
    const left = custody > paid ? custody - paid : 0n;
    const owed = held >> 32n;
    return owed > left ? [{ position: r.pubkey, excess: owed - left }] : [];
  });
}

/** A Position's stake marker: non-zero `stake_rate_open`. */
export const isStake = (r: PositionRow) => stakeRateOpen(r.data) !== 0n;

/**
 * `pgrep -a -A -f UPGRADE_PATTERN` on `host` as the refusal reasons it gives: none when it found nothing (exit 1), each process
 * line when it found some (exit 0), and the error itself for anything else (pgrep could not tell, so the run must not start).
 */
export function upgradesFrom(host: string, exit: number | null, stdout: string, stderr = ""): string[] {
  if (exit === 1) return [];
  if (exit === 0) return stdout.trim().split("\n").filter(Boolean).map((l) => `${host}: ${l}`);
  return [`${host}: could not check for other upgrades (pgrep exit ${exit ?? "none"}${stderr.trim() ? `: ${stderr.trim()}` : ""})`];
}

/** ProgramData: 4-byte tag, 8-byte slot, then the upgrade authority as Option<Pubkey>, then the program bytes from 45. */
export const PROGRAM_DATA_HEADER = 45;

/** The program's upgrade authority, or null when it has none (immutable). */
export function upgradeAuthorityOf(programData: Buffer): PublicKey | null {
  return programData[12] === 1 ? new PublicKey(programData.subarray(13, 45)) : null;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Whether ProgramData already holds `so`: its bytes, then only the zeros of unused room. A re-run then skips the upgrade. */
export function soDeployed(programData: Buffer, so: Buffer): boolean {
  const body = programData.subarray(PROGRAM_DATA_HEADER);
  if (body.length < so.length) return false;
  return sha256(body.subarray(0, so.length)) === sha256(so) && body.subarray(so.length).every((b) => b === 0);
}

/**
 * Lamports the deployer needs, all at once at the peak of the run:
 * - the buffer's rent for the new .so (returned after the upgrade, but held while it runs);
 * - the rent the ProgramData extend adds (`extendLamports`, 0 when it does not grow);
 * - write-buffer's transaction fees, one 5,000-lamport signature per chunk;
 * - every migration: the rent of its 8 new bytes (`rent(243) - rent(235)`, read from the cluster: 40,640 on 2026-10-28) and a fee share.
 */
export function requiredLamports(n: { positions: number; bufferLamports: bigint; extendLamports: bigint; soBytes: number; migrationRent: bigint }): bigint {
  const writeFees = BigInt(Math.ceil(n.soBytes / WRITE_CHUNK_BYTES)) * 5_000n;
  return n.bufferLamports + n.extendLamports + writeFees + BigInt(n.positions) * (n.migrationRent + MIGRATE_FEE_LAMPORTS);
}

export interface Preflight {
  /** Refusals from `upgradesFrom` on every host. */
  upgrades: string[];
  genesis: { read: string; send: string; mainnet: string };
  deployer: PublicKey;
  /** The tesoro_core program's upgrade authority (null = immutable). */
  upgradeAuthority: PublicKey | null;
  /** The Config admin, who signs migrate_position. */
  admin: PublicKey;
  deployerLamports: bigint;
  required: bigint;
  mainnetStake: number;
}

/** Why the run must not start; empty when it may. Checked before the keeper stops. */
export function gates(p: Preflight): string[] {
  const out: string[] = [];
  if (p.genesis.read !== DEVNET_GENESIS) out.push(`--read-rpc is not devnet (genesis ${p.genesis.read})`);
  if (p.genesis.send !== DEVNET_GENESIS) out.push(`--rpc is not devnet (genesis ${p.genesis.send})`);
  if (p.genesis.mainnet !== MAINNET_GENESIS) out.push(`--mainnet-rpc is not mainnet (genesis ${p.genesis.mainnet})`);
  if (p.upgrades.length) out.push(`another program upgrade may be running with the shared deployer key: ${p.upgrades.join(" | ")}`);
  if (!p.upgradeAuthority?.equals(p.deployer)) out.push(`tesoro_core's upgrade authority is ${p.upgradeAuthority?.toBase58() ?? "none"}, not the deployer ${p.deployer.toBase58()}`);
  if (!p.admin.equals(p.deployer)) out.push(`the Config admin is ${p.admin.toBase58()}, not the deployer ${p.deployer.toBase58()} (migrate_position is admin-signed)`);
  if (p.deployerLamports < p.required) out.push(`the deployer holds ${p.deployerLamports} lamports, the run needs ${p.required}`);
  if (p.mainnetStake !== 0) out.push(`mainnet has ${p.mainnetStake} stake Positions: the release needs 0 (founder decides otherwise)`);
  return out;
}

/** systemctl's answer for the keeper unit, as the run requires it: `inactive` before the upgrade, `active` after. */
export function keeperStateError(want: "inactive" | "active", got: string): string | null {
  const state = got.trim();
  return state === want ? null : `the keeper is "${state || "(no answer)"}", not "${want}"`;
}

/** The keeper's /healthz body once it is back: alive, and at least one pass finished on the new program. */
export function healthError(body: string): string | null {
  let s: { alive?: boolean; passes?: number };
  try {
    s = JSON.parse(body);
  } catch {
    return `/healthz answered ${JSON.stringify(body.slice(0, 120))}, not JSON`;
  }
  if (s.alive !== true) return "/healthz says the keeper loop is not alive";
  if (!s.passes) return "/healthz shows no finished pass yet";
  return null;
}

/** One migrate transaction: the compute limit for its Positions, then one migrate_position each. */
export function migrateTx(ixs: TransactionInstruction[]): Transaction {
  return new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: MIGRATE_CU_LIMIT * ixs.length }), ...ixs);
}

export async function migrateIx(program: Program, admin: PublicKey, position: PublicKey): Promise<TransactionInstruction> {
  const config = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId)[0];
  return program.methods.migratePosition().accountsStrict({ admin, config, position, systemProgram: new PublicKey("11111111111111111111111111111111") }).instruction();
}

/** The Positions in transaction-sized groups. */
export function migrateTxs(keys: PublicKey[]): PublicKey[][] {
  const out: PublicKey[][] = [];
  for (let i = 0; i < keys.length; i += MIGRATIONS_PER_TX) out.push(keys.slice(i, i + MIGRATIONS_PER_TX));
  return out;
}
