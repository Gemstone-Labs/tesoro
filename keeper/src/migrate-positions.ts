// Ticket 55 sweep: after tesoro_core gains `stake_rate_high`, every 235-byte Position is rewritten in the 243-byte layout by the
// admin (`migrate_position`). Planning and checks only; keeper/scripts/migrate-positions-55.ts runs the steps.
import type { Program } from "@coral-xyz/anchor";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { LEGACY_POSITION_SPACE, POSITION_SPACE } from "../../app/src/lib/chain/position-size.ts";

/** Each Position's share of a transaction fee (5,000 lamports a signature, 10 Positions a transaction). */
export const MIGRATE_FEE_LAMPORTS = 500n;
/** Positions migrated per transaction (4 accounts and 8 bytes of data each, well inside a transaction). */
export const MIGRATIONS_PER_TX = 10;

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

/**
 * Lamports the deployer needs: the upgrade buffer's rent plus every migration, each the rent of its 8 new bytes (`rent(243) - rent(235)`,
 * read from the cluster: 40,640 on 2026-10-28) and a fee share.
 */
export const requiredLamports = (positions: number, bufferLamports: bigint, migrationRent: bigint) =>
  bufferLamports + BigInt(positions) * (migrationRent + MIGRATE_FEE_LAMPORTS);

/** Why the run must not start; empty when it may. */
export function gates(s: { otherUpgrades: string[]; deployerLamports: bigint; required: bigint; mainnetStake: number }): string[] {
  const out: string[] = [];
  if (s.otherUpgrades.length) out.push(`another program upgrade is running with the shared deployer key: ${s.otherUpgrades.join(" | ")}`);
  if (s.deployerLamports < s.required) out.push(`the deployer holds ${s.deployerLamports} lamports, the run needs ${s.required}`);
  if (s.mainnetStake !== 0) out.push(`mainnet has ${s.mainnetStake} stake Positions: the release needs 0 (founder decides otherwise)`);
  return out;
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
