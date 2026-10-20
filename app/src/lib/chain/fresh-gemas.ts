/**
 * Whether a "not enough Gemas" answer may be shown. A Gema count read before a Position opened (or from a cached
 * list) can be short while the header already shows more, so a shortfall is only believed after a fresh Account
 * read (`refresh()`, the `?fresh=1` snapshot path) made since the page opened.
 */
export type GemasCheck = "enough" | "recheck" | "short";

export function checkGemas(available: bigint | number, entry: number, confirmedFresh: boolean): GemasCheck {
  if (BigInt(available) >= BigInt(entry)) return "enough";
  return confirmedFresh ? "short" : "recheck";
}

/**
 * The entry was refused for lack of Gemas. When the balance on screen already covers the entry, the Gemas just
 * opened have not reached the read the entry used yet ("landing": try again); otherwise the Player is short.
 */
export function chainShortfall(available: bigint | number, entry: number): "short" | "landing" {
  return BigInt(available) >= BigInt(entry) ? "landing" : "short";
}
