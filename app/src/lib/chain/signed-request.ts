/**
 * The message a wallet signs for a server route call (/api/demo-advance, /api/eth-bridge). It covers
 * the step, the wallet, the time, a single-use nonce and every other request field, so a captured
 * request can be neither replayed nor sent with different fields. The server rebuilds it from the body.
 */
export const SIGNED_FIELDS = ["evm", "vault", "id", "months", "position", "sourceIndex", "email", "enabled"] as const;
export type SignedFields = Partial<Record<(typeof SIGNED_FIELDS)[number], string | number>>;
export type SignedScope = "tesoro-demo" | "tesoro-eth" | "tesoro-notify";

export const signedMessage = (scope: SignedScope, step: string, address: string, ts: number, nonce: string, fields: SignedFields) =>
  `${scope}|${step}|${address}|${ts}|${nonce}|${JSON.stringify(SIGNED_FIELDS.map((k) => fields[k] ?? null))}`;

/** 16 random bytes, hex. */
export function newNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
