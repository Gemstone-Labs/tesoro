/**
 * Dev-only: how many times the Player's wallet signed during each Match (ticket 11 measures this: the target is 1 per entry).
 * Counted where the wallet's signer is built (AccountProvider). Off in production builds unless `NEXT_PUBLIC_SIGNATURE_COUNTER=1`,
 * and never shown to Players: read it from the console with `__tesoroWalletSignatures()`.
 */
export type WalletSignatureKind = "message" | "transaction";

export interface SignatureCount {
  message: number;
  transaction: number;
}

const enabled = (): boolean => process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_SIGNATURE_COUNTER === "1";

const STORAGE = "tesoro-wallet-signatures";
const counts = new Map<string, SignatureCount>();
let current = "outside-a-match";

/** Kept for the tab's life, so a reload in the middle of a Match does not lose the count. */
const store = (): Storage | null => {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
};
const save = () => {
  try {
    store()?.setItem(STORAGE, JSON.stringify([...counts]));
  } catch {
    /* the count is a dev aid: losing it is fine */
  }
};
if (enabled()) {
  try {
    for (const [k, v] of JSON.parse(store()?.getItem(STORAGE) ?? "[]") as [string, SignatureCount][]) counts.set(k, v);
  } catch {
    /* start empty */
  }
}

/** Everything the wallet signs from now on counts for this Match (a Match key), until another is set. */
export function countingFor(matchKey: string | null): void {
  current = matchKey ?? "outside-a-match";
}

export function recordWalletSignature(kind: WalletSignatureKind, matchKey: string = current): void {
  if (!enabled()) return;
  const c = counts.get(matchKey) ?? { message: 0, transaction: 0 };
  c[kind]++;
  counts.set(matchKey, c);
  save();
}

export function walletSignatures(): Record<string, SignatureCount & { total: number }> {
  return Object.fromEntries([...counts].map(([k, c]) => [k, { ...c, total: c.message + c.transaction }]));
}

export function resetWalletSignatures(): void {
  counts.clear();
  current = "outside-a-match";
  save();
}

/** Wraps a wallet signer so every signature it makes is counted. Returns it unchanged when counting is off. */
export function counted<T extends { signMessage(m: Uint8Array): Promise<Uint8Array>; signTransaction(tx: never): Promise<unknown>; signSerialized?(tx: Uint8Array): Promise<Uint8Array> }>(signer: T): T {
  if (!enabled()) return signer;
  if (typeof window !== "undefined") (window as unknown as Record<string, unknown>).__tesoroWalletSignatures = walletSignatures;
  const out = {
    ...signer,
    signMessage: (m: Uint8Array) => (recordWalletSignature("message"), signer.signMessage(m)),
    signTransaction: (tx: never) => (recordWalletSignature("transaction"), signer.signTransaction(tx)),
  };
  if (signer.signSerialized) (out as T).signSerialized = (tx: Uint8Array) => (recordWalletSignature("transaction"), signer.signSerialized!(tx));
  return out as T;
}
