import type { PublicKey } from "@solana/web3.js";
import { claimDue } from "./clock";
import { STATUS, type Battle } from "./decode";
import type { VanguardChain } from "./chain";
import type { PlayerSigner } from "./chain";

/** A Battle may be delegated until its start deadline (whole seconds); after that `finalize` refunds it as a no-show. */
export const canDelegate = (b: Pick<Battle, "startDeadline">, nowSec: number): boolean => nowSec <= b.startDeadline;

const ALREADY = /AlreadyContributed/;

/**
 * Folds this Player's secret in. It first tries to bundle the randomness request with it: that succeeds for the
 * second contributor, so the request lands the moment both secrets are in. For the first one the request is refused
 * (the other secret is missing), and the plain contribution follows.
 */
export async function contributeBundled(
  vg: Pick<VanguardChain, "contributeEntropy">,
  player: PlayerSigner,
  match: PublicKey,
  oracleQueue?: PublicKey,
): Promise<void> {
  try {
    await vg.contributeEntropy(player, match, true, oracleQueue);
    return;
  } catch (e) {
    if (ALREADY.test(String(e))) return;
  }
  try {
    await vg.contributeEntropy(player, match, false, oracleQueue);
  } catch (e) {
    if (!ALREADY.test(String(e))) throw e;
  }
}

/** While the Battle subscription delivers, the Battle is read from the chain only this often. */
export const FALLBACK_READ_MS = 5_000;

/** True when neither the subscription nor a read has produced the Battle for the fallback period. */
export const readDue = (nowMs: number, lastUpdateMs: number, lastReadMs: number, every = FALLBACK_READ_MS): boolean =>
  nowMs - Math.max(lastUpdateMs, lastReadMs) >= every;

/** How long the driver waits between passes: slow while the Match is live (the subscription carries it). */
export const tickDelayMs = (stage: string): number => (stage === "live" ? 5_000 : 1_500);

/** What to send from the Battle already held, without reading anything. */
export function actionsDue(b: Battle, seenAt: number, nowMs: number, lastResolveMs: number, lastClaimMs: number): { resolve: boolean; claim: boolean } {
  return {
    resolve: b.status === STATUS.live && b.pendingKind !== 0 && nowMs - lastResolveMs > 600,
    claim: (b.status === STATUS.live || b.status === STATUS.setup) && claimDue(b, seenAt, nowMs) && nowMs - lastClaimMs > 2_500,
  };
}
