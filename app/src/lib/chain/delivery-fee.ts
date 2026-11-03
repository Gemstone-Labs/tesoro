/**
 * The Delivery Fee on Solana-to-EVM sends (Unlock and Redeem to ETH or HYPE). Tesoro's sponsor pays the LayerZero fee in SOL;
 * the vault keeps a flat fee in the Player's own asset and releases the rest. `DeliveryTerms` is the bridge account that holds
 * the settings; the quote here mirrors `DeliveryTerms::fee_for` in bridge/programs/tesoro_bridge/src/state/delivery_terms.rs.
 */

/** The most of a payout any fee may take (basis points). A program constant: no admin setting raises it. */
export const DELIVERY_CEILING_BPS = 1000;
const BPS = 10_000n;

export interface DeliveryTerms {
  eid: number;
  /** Flat fee per message, in the vault's base units. */
  deliveryFee: bigint;
  maxAbs: bigint;
  /** Smallest Redeem (Player share, vault base units) the bridge accepts. */
  minRedeem: bigint;
  /** Percentage cap for Unlock and Instant Redeem. */
  maxBpsUnlock: number;
  /** Percentage cap for a Redeem of yield. */
  maxBpsYield: number;
  minPrizeGemas: bigint;
}

export type DeliveryKind = "unlock" | "yield" | "instant";

export interface DeliveryQuote {
  /** Vault base units the vault keeps for Tesoro. */
  fee: bigint;
  /** What the Player receives: the payout less the fee. */
  youGet: bigint;
  /** A Redeem below the bridge's minimum is refused; an Unlock never is. */
  belowMinimum: boolean;
}

const min = (...v: bigint[]) => v.reduce((a, b) => (a < b ? a : b));

/**
 * `payoutUnits` is the Player's share in the vault's base units: the principal for an Unlock, the yield less the Yield Fee
 * for a Redeem, the Instant Redeem payout for an Instant Redeem.
 */
export function deliveryQuote(o: { terms: DeliveryTerms; payoutUnits: bigint; kind: DeliveryKind }): DeliveryQuote {
  const { terms, payoutUnits, kind } = o;
  const bps = BigInt(Math.min(kind === "yield" ? terms.maxBpsYield : terms.maxBpsUnlock, DELIVERY_CEILING_BPS));
  const fee = min(terms.deliveryFee, terms.maxAbs, (payoutUnits * bps) / BPS);
  return { fee, youGet: payoutUnits - fee, belowMinimum: kind !== "unlock" && payoutUnits < terms.minRedeem };
}

const rdU64 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
const rdU128 = (d: Uint8Array, o: number) => rdU64(d, o) + (rdU64(d, o + 8) << 64n);

/** `DeliveryTerms` is 105 bytes: disc 8, eid 4, peer 32, bump 1, fee/cap/min u128 x3, two u16 caps, prize minimum u64. Null when absent. */
export const DELIVERY_TERMS_LEN = 8 + 4 + 32 + 1 + 16 * 3 + 2 + 2 + 8;

export function parseDeliveryTerms(d: Uint8Array): DeliveryTerms | null {
  if (d.length !== DELIVERY_TERMS_LEN) return null;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return {
    eid: v.getUint32(8, true),
    deliveryFee: rdU128(d, 45),
    maxAbs: rdU128(d, 61),
    minRedeem: rdU128(d, 77),
    maxBpsUnlock: v.getUint16(93, true),
    maxBpsYield: v.getUint16(95, true),
    minPrizeGemas: rdU64(d, 97),
  };
}
