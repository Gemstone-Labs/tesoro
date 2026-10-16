import { DEFAULT_INSTANT_FEE_BPS, DEFAULT_YIELD_FEE_BPS, earnedFee, instantPayout, type PoolTotals } from "./yield";
import type { SourceMath } from "./ledger";
import { BRAND } from "../brand";

/**
 * Tesoro's Treasury as the app reads it, as pure decoders and math: the Yield Fee and Instant Redeem Fee rates
 * (tesoro_core `["treasury"]`), the simSOL it holds to pay Instant Redeems on Solana, and the bridge's mirror of
 * each EVM vault's treasury. Any of these may not exist yet (before `init_treasury`, or on an old vault): the
 * decoders answer null on a wrong size, never throw. Fetching lives in treasury.ts.
 */

const RATE_SCALE = 1_000_000_000n;
const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const rdU64 = (d: Uint8Array, o: number) => view(d).getBigUint64(o, true);
const rdU128 = (d: Uint8Array, o: number) => rdU64(d, o) + (rdU64(d, o + 8) << 64n);

export interface TreasuryRates {
  yieldFeeBps: number;
  instantFeeBps: number;
}

export const DEFAULT_RATES: TreasuryRates = { yieldFeeBps: DEFAULT_YIELD_FEE_BPS, instantFeeBps: DEFAULT_INSTANT_FEE_BPS };

/** The rates in force: the Treasury's, or the launch rates while it cannot be read. */
export const ratesOf = (t: TreasuryRates | null | undefined): TreasuryRates => t ?? DEFAULT_RATES;

/** `Treasury`: disc 8, bump, vault_bump, account_bump, yield_fee_bps u16, instant_fee_bps u16, account, vault, fee_minted, instant_units, funded_shares, withdrawn_units, company. */
export const TREASURY_LEN = 8 + 3 + 2 + 2 + 32 + 32 + 3 * 8 + 8 + 32;
const FEE_MINTED_AT = 8 + 3 + 2 + 2 + 32 + 32;

/** SOL units of earned Yield Fee already minted out as simSOL; null on a wrong size. */
export const parseFeeMinted = (d: Uint8Array): bigint | null => (d.length === TREASURY_LEN ? rdU64(d, FEE_MINTED_AT) : null);

/** `NativeCustody`: disc 8, bump, vault_bump, pool, mint, vault, then principal, fee_weight, fee_weight_time, realised_fee (u128) and open_positions (u64). */
export const NATIVE_CUSTODY_LEN = 8 + 2 + 3 * 32 + 4 * 16 + 8;

export function parsePoolTotals(d: Uint8Array): PoolTotals | null {
  if (d.length !== NATIVE_CUSTODY_LEN) return null;
  const o = 8 + 2 + 3 * 32 + 16;
  return { feeWeight: rdU128(d, o), feeWeightTime: rdU128(d, o + 16), realisedFee: rdU128(d, o + 32), openPositions: rdU64(d, o + 48) };
}

/** What the Treasury has to pay SOL Instant Redeems with, in SOL units (exactly the program's balance): the unminted Yield Fee earned plus the vault's simSOL at the rate. */
export function treasuryBalanceUnits(a: { totals: PoolTotals; feeMinted: bigint; vaultShares: bigint; rate: bigint; speedup: number; nowSec: number }): bigint {
  const earned = earnedFee(a.totals, a.nowSec, a.speedup);
  const unminted = earned > a.feeMinted ? earned - a.feeMinted : 0n;
  return unminted + (a.vaultShares * a.rate) / RATE_SCALE;
}

export function parseTreasury(d: Uint8Array): TreasuryRates | null {
  if (d.length !== TREASURY_LEN) return null;
  return { yieldFeeBps: view(d).getUint16(11, true), instantFeeBps: view(d).getUint16(13, true) };
}

/** The Treasury's original vault (the token it was created with), as recorded in `Treasury.vault`. Null on a wrong size. */
export function parseTreasuryVaultKey(d: Uint8Array): Uint8Array | null {
  return d.length === TREASURY_LEN ? d.subarray(8 + 3 + 2 + 2 + 32, 8 + 3 + 2 + 2 + 64) : null;
}

/** The treasury simSOL vault is an SPL token account: its balance sits at byte 64. */
export const parseVaultShares = (d: Uint8Array): bigint | null => (d.length >= 72 ? rdU64(d, 64) : null);

/** `VaultTreasury`: disc 8, eid u32, peer_address [32], reported_in u128, instant_recorded u128, bump. */
export const VAULT_TREASURY_LEN = 8 + 4 + 32 + 16 + 16 + 1;

export interface VaultTreasuryView {
  reportedIn: bigint;
  instantRecorded: bigint;
  /** Source-asset units an Instant Redeem on this vault may still be paid. */
  available: bigint;
}

export function parseVaultTreasury(d: Uint8Array): VaultTreasuryView | null {
  if (d.length !== VAULT_TREASURY_LEN) return null;
  const reportedIn = rdU128(d, 44);
  const instantRecorded = rdU128(d, 60);
  return { reportedIn, instantRecorded, available: reportedIn > instantRecorded ? reportedIn - instantRecorded : 0n };
}

// ---- Instant Redeem math (exactly tesoro_core `instant_redeem`) -------------------------------------

/** What `gemas` of a Source pay now, in Source-asset units: the full value less the Instant Redeem Fee, floored twice as on chain. */
export function instantPayoutFor(source: Pick<SourceMath, "unitNum" | "unitDen">, gemas: bigint, instantFeeBps: number): bigint {
  if (source.unitDen === 0n) return 0n;
  return instantPayout((gemas * source.unitNum) / source.unitDen, instantFeeBps);
}

/** The most Gemas of a Source whose Instant Redeem pays at most `maxPayout` units: exact inverse of `instantPayoutFor`. */
export function maxInstantGemas(source: Pick<SourceMath, "unitNum" | "unitDen">, maxPayout: bigint, instantFeeBps: number): bigint {
  if (source.unitNum === 0n || maxPayout <= 0n) return 0n;
  const keep = BigInt(10_000 - instantFeeBps);
  // payout(g) <= M  <=>  floor(g * num / den) <= ceil((M + 1) * 10000 / keep) - 1  <=>  g <= ceil((U + 1) * den / num) - 1
  const units = ((maxPayout + 1n) * 10_000n + keep - 1n) / keep - 1n;
  return ((units + 1n) * source.unitDen + source.unitNum - 1n) / source.unitNum - 1n;
}

/** Source-asset units the treasury vault can pay now at `rate`: the largest payout whose simSOL (floored) the vault covers. */
export function solPayoutCapacity(vaultShares: bigint, rate: bigint): bigint {
  if (rate <= 0n) return 0n;
  return ((vaultShares + 1n) * rate + RATE_SCALE - 1n) / RATE_SCALE - 1n;
}

/** A won holding that could be sold now, with the treasury it would be paid from (`capKey` names it: the asset for Solana, the vault for an EVM chain). */
export interface InstantCandidate {
  key: string;
  capKey: string;
  /** Gemas of the holding Redeem now may sell: free, won and still waiting on yield. */
  free: bigint;
  unitNum: bigint;
  unitDen: bigint;
}

export interface InstantLine {
  key: string;
  gemas: bigint;
  /** Source-asset units paid now. */
  payout: bigint;
}

/**
 * What to sell for a "Redeem now": every holding's pending Gemas, in order, until the treasury it is paid from can pay no more.
 * `caps` is the payout (Source-asset units) each treasury can still make; a treasury missing from it pays nothing.
 */
export function planInstant(rows: InstantCandidate[], caps: Map<string, bigint>, instantFeeBps: number): InstantLine[] {
  const left = new Map(caps);
  const out: InstantLine[] = [];
  for (const r of rows) {
    const cap = left.get(r.capKey) ?? 0n;
    const fits = maxInstantGemas(r, cap, instantFeeBps);
    const gemas = r.free < fits ? r.free : fits;
    const payout = instantPayoutFor(r, gemas, instantFeeBps);
    if (gemas <= 0n || payout <= 0n) continue;
    left.set(r.capKey, cap - payout);
    out.push({ key: r.key, gemas, payout });
  }
  return out;
}

export type InstantReplan = { kind: "send"; lines: InstantLine[] } | { kind: "smaller"; lines: InstantLine[]; gemas: bigint } | { kind: "none" };

/**
 * Checks a fresh plan against the one the Player confirmed (a yield crank may have landed in between). Never more than confirmed:
 * the same or larger plan sends the confirmed lines; any smaller line returns the capped plan to confirm again.
 */
export function replanInstant(confirmed: InstantLine[], fresh: InstantLine[]): InstantReplan {
  const now = new Map(fresh.map((l) => [l.key, l]));
  const lines: InstantLine[] = [];
  let shrank = false;
  for (const c of confirmed) {
    const f = now.get(c.key);
    if (!f || f.gemas <= 0n) {
      shrank = true;
      continue;
    }
    if (f.gemas >= c.gemas) lines.push(c);
    else {
      shrank = true;
      lines.push(f);
    }
  }
  if (lines.length === 0) return { kind: "none" };
  if (!shrank) return { kind: "send", lines };
  return { kind: "smaller", lines, gemas: lines.reduce((s, l) => s + l.gemas, 0n) };
}

export const INSTANT_NOT_OPEN = `${BRAND.name} has not opened Instant Redeem yet.`;
export const INSTANT_UNAVAILABLE_TITLE = "Instant Redeem unavailable right now";
export const INSTANT_UNAVAILABLE_BODY =
  `${BRAND.name}'s Treasury cannot pay for these Gemas right now. Redeem at full value as their yield lands, or try again later.`;

/** Why Instant Redeem cannot be used, or null: no Treasury yet, or a Treasury too short to pay for any won Gemas. */
export function instantUnavailable({ setUp, payableRows }: { setUp: boolean; payableRows: number }): string | null {
  if (!setUp) return INSTANT_NOT_OPEN;
  return payableRows === 0 ? INSTANT_UNAVAILABLE_BODY : null;
}
