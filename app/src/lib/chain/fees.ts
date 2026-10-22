import { BPS, DEFAULT_INSTANT_FEE_BPS, DEFAULT_YIELD_FEE_BPS, instantPayout } from "./yield";
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

/** `Treasury`: disc 8, bump, vault_bump, account_bump, yield_fee_bps u16, instant_fee_bps u16, account, vault, instant_units, funded_shares, withdrawn_units, company. */
export const TREASURY_LEN = 8 + 3 + 2 + 2 + 32 + 32 + 2 * 8 + 8 + 32;

/** The Treasury's shares on one route (`RouteLedger`, Borsh, 149 bytes at the end of a custody account). */
export const ROUTE_LEN = 4 * 16 + 1 + 3 * 16 + 4 + 2 * 16;

export interface RouteView {
  treasuryShares: bigint;
  owedShares: bigint;
  poolOwed: bigint;
  reserved: bigint;
  /** Shares a fill or a withdrawal may pay out: `treasury_shares` less everything owed or reserved (`RouteLedger::spendable`). */
  spendable: bigint;
}

export function parseRoute(d: Uint8Array, at: number): RouteView {
  const treasuryShares = rdU128(d, at);
  const owedShares = rdU128(d, at + 16);
  const poolOwed = rdU128(d, at + 32);
  const reserved = rdU128(d, at + 48);
  const claims = owedShares + poolOwed + reserved;
  return { treasuryShares, owedShares, poolOwed, reserved, spendable: treasuryShares > claims ? treasuryShares - claims : 0n };
}

/** `NativeCustody`: disc 8, bump, vault_bump, pool, mint, vault, then principal (u128), open_positions (u64) and the route. */
export const NATIVE_CUSTODY_LEN = 8 + 2 + 3 * 32 + 16 + 8 + ROUTE_LEN;
export const NATIVE_ROUTE_AT = 8 + 2 + 3 * 32 + 16 + 8;

export const parseNativeRoute = (d: Uint8Array): RouteView | null => (d.length === NATIVE_CUSTODY_LEN ? parseRoute(d, NATIVE_ROUTE_AT) : null);

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

/** `VaultTreasury`: disc 8, eid u32, peer_address [32], balance u128, paid_at_report u128, instant_recorded u128, report_time u64, bump. */
export const VAULT_TREASURY_LEN = 8 + 4 + 32 + 16 + 16 + 16 + 8 + 1;

export interface VaultTreasuryView {
  /** What the vault Treasury held at the latest Yield Report. */
  balance: bigint;
  /** Instant Redeem payouts the vault had made at that report. */
  paidAtReport: bigint;
  /** Instant Redeem payouts Solana has recorded. */
  instantRecorded: bigint;
  /** Vault block time (unix seconds) of the latest report. */
  reportTime: bigint;
  /** Source-asset units an Instant Redeem on this vault may still be paid: balance less what is recorded but not yet paid. */
  available: bigint;
}

/** Instant Redeem availability: the reported balance less the payouts recorded since that report (saturating). */
export function vaultTreasuryAvailable(balance: bigint, paidAtReport: bigint, instantRecorded: bigint): bigint {
  const outstanding = instantRecorded > paidAtReport ? instantRecorded - paidAtReport : 0n;
  return balance > outstanding ? balance - outstanding : 0n;
}

/**
 * What an Instant Redeem on a vault may try: the mirror's availability, or more when the vault itself holds more than its last
 * report said (`live` = `treasuryBalance()` read now). Trying is safe: the action fetches the latest report first, which refreshes
 * the mirror, and re-checks against it.
 */
export function instantTryCap(view: Pick<VaultTreasuryView, "available" | "paidAtReport" | "instantRecorded">, live: bigint | null): bigint {
  if (live === null) return view.available;
  const liveAvail = vaultTreasuryAvailable(live, view.paidAtReport, view.instantRecorded);
  return liveAvail > view.available ? liveAvail : view.available;
}

export function parseVaultTreasury(d: Uint8Array): VaultTreasuryView | null {
  if (d.length !== VAULT_TREASURY_LEN) return null;
  const balance = rdU128(d, 44);
  const paidAtReport = rdU128(d, 60);
  const instantRecorded = rdU128(d, 76);
  return { balance, paidAtReport, instantRecorded, reportTime: rdU64(d, 92), available: vaultTreasuryAvailable(balance, paidAtReport, instantRecorded) };
}

// ---- Instant Redeem math (exactly tesoro_core `instant_payout`) -------------------------------------

/** What `gemas` of a Source pay now, in Source-asset units: the value after the Yield Fee and the Instant Redeem Fee (one floor), after the unit conversion's floor. */
export function instantPayoutFor(source: Pick<SourceMath, "unitNum" | "unitDen">, gemas: bigint, instantFeeBps: number, yieldFeeBps: number): bigint {
  if (source.unitDen === 0n) return 0n;
  return instantPayout((gemas * source.unitNum) / source.unitDen, instantFeeBps, yieldFeeBps);
}

/** The most Gemas of a Source whose Instant Redeem pays at most `maxPayout` units: exact inverse of `instantPayoutFor`. */
export function maxInstantGemas(source: Pick<SourceMath, "unitNum" | "unitDen">, maxPayout: bigint, instantFeeBps: number, yieldFeeBps: number): bigint {
  if (source.unitNum === 0n || maxPayout <= 0n) return 0n;
  const keep = (BPS - BigInt(yieldFeeBps)) * (BPS - BigInt(instantFeeBps));
  const whole = BPS * BPS;
  // payout(g) <= M  <=>  floor(g * num / den) <= ceil((M + 1) * BPS^2 / keep) - 1  <=>  g <= ceil((U + 1) * den / num) - 1
  const units = ((maxPayout + 1n) * whole + keep - 1n) / keep - 1n;
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
export function planInstant(rows: InstantCandidate[], caps: Map<string, bigint>, instantFeeBps: number, yieldFeeBps: number): InstantLine[] {
  const left = new Map(caps);
  const out: InstantLine[] = [];
  for (const r of rows) {
    const cap = left.get(r.capKey) ?? 0n;
    const fits = maxInstantGemas(r, cap, instantFeeBps, yieldFeeBps);
    const gemas = r.free < fits ? r.free : fits;
    const payout = instantPayoutFor(r, gemas, instantFeeBps, yieldFeeBps);
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
