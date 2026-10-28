import { BRAND } from "./brand";
/**
 * The one line a Player sees for a failed action. Program messages ("Error Message: …") and our own
 * sentences pass through; transport and infrastructure failures (signatures, logs, rollup steps,
 * custom error codes) become a plain retry line.
 */
export const BUSY = "The network is busy right now. Wait a few seconds and try again.";
export const RETRY = "That didn’t go through. Try again in a moment.";
/** Sent but not confirmed: it may still land, so a retry could do it twice. */
export const UNCONFIRMED = "Sent, but not confirmed yet. Wait a moment and check before trying again.";

/** The program refused an Instant Redeem because the Treasury holds less than the payout (tesoro_core TreasuryShort, 6017 = 0x1781). */
export const INSTANT_UNAVAILABLE = `Instant Redeem unavailable right now. ${BRAND.name}'s Treasury cannot pay it at the moment. Redeem as the yield lands, or try again later.`;

export const PRICE_MOVED = "The price moved while you were confirming, so the Advance would have issued fewer Gemas than shown. Nothing was taken. Try again.";

/**
 * A Position the program cannot read yet: the upgrade that grew it (ticket 55) is being rolled out. Only Anchor's
 * AccountDidNotDeserialize (3003) on an account named `position` (every PositionState in tesoro_core's instructions; the log line
 * is pinned by tests/stake_audit/fixtures.rs): the same error on a Match, Source or Offer keeps its own message, and a bare 3003
 * with no logs says nothing about which account failed.
 */
export const UPDATING = `${BRAND.name} is updating. Try again in a minute.`;
const UPDATING_PATTERN = /AnchorError caused by account: position\. Error Code: AccountDidNotDeserialize\b/;

/** tesoro_core RateBelowPeak (6185 = 0x1829): the token is worth less SOL than the highest value the Lock's yield was priced at. */
export const RATE_BELOW_PEAK = "Your Lock's token is worth less SOL now than the highest value its yield was priced at. A new Advance or Extend is available once it is worth at least that much again. Redeem and Unlock still work.";
const RATE_BELOW_PEAK_PATTERN = /RateBelowPeak|custom program error: 0x1829\b|"Custom":\s*6185\b/i;

/** tesoro_core YieldCapReached (6186 = 0x182a): this issuance would take the Lock's Advances over its life past its Principal. */
export const YIELD_CAP_REACHED = "This Length would advance more yield than your Locked amount over this Lock's life. A shorter Length may still fit. Redeem and Unlock still work.";
const YIELD_CAP_PATTERN = /YieldCapReached|custom program error: 0x182a\b|"Custom":\s*6186\b/i;

/** tesoro_core GrowthClaimsUnfunded (6187 = 0x182b): an old test Lock whose holders are owed more than it holds. */
export const UNLOCK_WAITS_FOR_TREASURY = `This Lock can't unlock yet: ${BRAND.name}'s Treasury has to fund what its Gemas' holders are owed first. Try again later.`;
const UNLOCK_WAITS_PATTERN = /GrowthClaimsUnfunded|custom program error: 0x182b\b|"Custom":\s*6187\b/i;

const PRICE_MOVED_PATTERN = /AdvanceBelowMinimum|fewer Gemas than the minimum|"Custom":\s*6045\b|custom program error: 0x179d/i;

/** The program refused an Advance because the price moved and it would have issued fewer Gemas than the floor. */
export const isPriceMoved = (e: unknown): boolean => PRICE_MOVED_PATTERN.test(e instanceof Error ? e.message : String(e));

export function plainError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  if (/TreasuryShort|treasury cannot pay|custom program error: 0x1781|"Custom":\s*6017\b/i.test(text)) return INSTANT_UNAVAILABLE;
  if (PRICE_MOVED_PATTERN.test(text)) return PRICE_MOVED;
  if (UPDATING_PATTERN.test(text)) return UPDATING;
  if (RATE_BELOW_PEAK_PATTERN.test(text)) return RATE_BELOW_PEAK;
  if (YIELD_CAP_PATTERN.test(text)) return YIELD_CAP_REACHED;
  if (UNLOCK_WAITS_PATTERN.test(text)) return UNLOCK_WAITS_FOR_TREASURY;
  const err = e as { code?: number; name?: string };
  if (err?.name === "UserRejectedRequestError" || err?.code === 4001 || /user rejected|rejected the request|user denied/i.test(text)) {
    return "You cancelled the request in your wallet.";
  }
  const program = /Error Message: ([^\n]+)/.exec(text);
  if (program) return program[1].replace(/\.$/, "");
  if (/not confirmed|was not confirmed|confirmation timed? ?out|block height exceeded/i.test(text)) return UNCONFIRMED;
  if (/\b429\b|rate.?limit|too many requests|exceeds defined limit|took too long|timed? ?out|blockhash|failed to fetch|fetch failed|network ?error|unknown RPC error/i.test(text)) return BUSY;
  if (/insufficient (funds|lamports)|attempt to debit an account but found no record/i.test(text)) return "Not enough SOL to cover the network fee. Try again in a moment.";
  const first = text.split("\n")[0];
  if (/tx failed|\bfailed [1-9A-HJ-NP-Za-km-z]{32,}|InstructionError|Custom\b|"Custom"|simulation failed|transaction failed|custom program error|base layer|rollup|delegat|\bTEE\b|\bcommit/i.test(first)) return RETRY;
  return first.length > 200 ? `${first.slice(0, 200)}…` : first;
}

export const ADVANCE_REPAID = "Your Advance was repaid before this went through. Close this and use Extend deposit instead.";

/** An Extend that lost the race with the clock: the Advance is repaid or closed by now. Anything else passes through. */
export function extendFailure(e: unknown): unknown {
  const text = e instanceof Error ? e.message : String(e);
  return /advance is already repaid|position has no open advance/i.test(text) ? new Error(ADVANCE_REPAID) : e;
}
