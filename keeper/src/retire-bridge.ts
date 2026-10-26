/**
 * Retiring tesoro_bridge records of layouts the current code cannot read (BridgePosition 172/188 B, Claim 129 B,
 * VaultTreasury 77 B). Pure: classifies a snapshot of the bridge program's accounts and builds `retire_legacy_account`.
 * Devnet state is disposable (founder, 2026-10-25): these are closed, never migrated. The lengths mirror the program's
 * `LEGACY_*_LENGTHS` constants (a test fails when they differ). An old BridgePosition or VaultTreasury whose vault is one
 * of the CURRENT vaults is left alone and reported: it may belong to live EVM-side state. A vault is current when the
 * bridge holds a record of the current layout for it (PeerConfigs are no sign: abandoned vaults stay registered).
 */
import { createHash } from "node:crypto";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { BRIDGE, STORE } from "./lz.ts";

export type BridgeKind = "BridgePosition" | "Claim" | "VaultTreasury";
export const BRIDGE_KINDS: BridgeKind[] = ["BridgePosition", "Claim", "VaultTreasury"];
/** Index of the kind in the program's `LegacyKind` enum. */
const KIND_INDEX: Record<BridgeKind, number> = { BridgePosition: 0, Claim: 1, VaultTreasury: 2 };
export const LEGACY_BRIDGE_LEN: Record<BridgeKind, number[]> = { BridgePosition: [172, 188], Claim: [129], VaultTreasury: [77] };
/** Sizes of the current layouts (8 + INIT_SPACE); the size guard fails when the program's differ. */
const CURRENT_BRIDGE_POSITION_LEN = 212;
const CURRENT_VAULT_TREASURY_LEN = 101;

const accountDisc = (name: string) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
const ixDisc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

export interface Row {
  pubkey: PublicKey;
  data: Buffer;
  lamports: number;
}
export interface BridgeItem {
  kind: BridgeKind;
  key: PublicKey;
  size: number;
  lamports: number;
}
export interface Held {
  kind: BridgeKind;
  key: PublicKey;
  size: number;
  vault: string;
}

const hasDisc = (r: Row, name: string) => r.data.length >= 8 && r.data.subarray(0, 8).equals(accountDisc(name));

/** The 32-byte vault word of a Position id (20-byte address, left padded), as the PeerConfig stores it. */
const vaultWordOfPosition = (data: Buffer) => Buffer.concat([Buffer.alloc(12), data.subarray(12, 32)]).toString("hex");

const vaultWordOfTreasury = (data: Buffer) => data.subarray(12, 44).toString("hex");

/** The vault words that have a record of the current layout: the vaults the bridge still serves. */
export function currentVaults(rows: Row[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (hasDisc(r, "BridgePosition") && r.data.length === CURRENT_BRIDGE_POSITION_LEN) out.add(vaultWordOfPosition(r.data));
    if (hasDisc(r, "VaultTreasury") && r.data.length === CURRENT_VAULT_TREASURY_LEN) out.add(vaultWordOfTreasury(r.data));
  }
  return out;
}

export function planBridge(rows: Row[]): { items: BridgeItem[]; held: Held[]; left: number; unpaidClaims: number } {
  const vaults = currentVaults(rows);
  const items: BridgeItem[] = [];
  const held: Held[] = [];
  let unpaidClaims = 0;
  for (const r of rows) {
    for (const kind of BRIDGE_KINDS) {
      if (!hasDisc(r, kind) || !LEGACY_BRIDGE_LEN[kind].includes(r.data.length)) continue;
      const vault = kind === "BridgePosition" ? vaultWordOfPosition(r.data) : kind === "VaultTreasury" ? vaultWordOfTreasury(r.data) : "";
      if (vault && vaults.has(vault)) {
        held.push({ kind, key: r.pubkey, size: r.data.length, vault });
        continue;
      }
      if (kind === "Claim" && r.data.readBigUInt64LE(112) > r.data.readBigUInt64LE(120)) unpaidClaims++;
      items.push({ kind, key: r.pubkey, size: r.data.length, lamports: r.lamports });
    }
  }
  return { items, held, left: rows.length - items.length - held.length, unpaidClaims };
}

/** Instructions per transaction. */
export const BRIDGE_BATCH = 10;

export function buildBridgeIx(admin: PublicKey, item: BridgeItem): TransactionInstruction {
  return new TransactionInstruction({
    programId: BRIDGE,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: STORE, isSigner: false, isWritable: false },
      { pubkey: item.key, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([ixDisc("retire_legacy_account"), Buffer.from([KIND_INDEX[item.kind]])]),
  });
}

