/**
 * The one place the product's name and the strings around it are set. Copy, metadata, share cards and emails read
 * from here, so a rename is a change to this file plus new art (logo, mark, share-card images).
 *
 * Not renamed from here: on-chain program names and IDs, package names (@tesoro/*), env var names, CSS classes,
 * routes, and the signed EVM link message (it is part of the bridge protocol).
 */
export const BRAND = {
  name: "Tesoro",
  /** The company behind the product. Terms and Privacy read the full legal entity from lib/legal/entity.ts. */
  companyName: "Gemstone Labs",
  legalName: "Gemstone Labs, Inc.",
  /** Bare domain; the origins (www, test) are resolved in lib/site.ts. */
  domain: "playtesoro.com",
  handle: "@PlayTesoro",
  tagline: "Play now, pay later.",
  /** Longer line used in share cards and posts. */
  /** Display name on outgoing email. */
  emailFromName: "Tesoro",
} as const;
