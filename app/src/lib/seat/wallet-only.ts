import { SeatScopeError } from "./seat-scope-error";

/** A seat key must never reach the wallet-only requests (age, deposit, notifications, invite, friends, admin, bridge, demo): they refuse it here and on the server. */
export function assertWalletSigner(signer: { seatMatch?: unknown }): void {
  if (signer.seatMatch) throw new SeatScopeError();
}

/** Signs `text` with the wallet. The signer of every wallet-only request goes through this. */
export async function signAsWallet(signer: { seatMatch?: unknown; signMessage(m: Uint8Array): Promise<Uint8Array> }, text: string): Promise<Uint8Array> {
  assertWalletSigner(signer);
  return signer.signMessage(new TextEncoder().encode(text));
}
