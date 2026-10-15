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
export const INSTANT_UNAVAILABLE = `Instant Redeem unavailable right now. ${BRAND.name}'s Treasury cannot pay it at the moment. Redeem at full value as the yield lands, or try again later.`;

export function plainError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  if (/TreasuryShort|treasury cannot pay|custom program error: 0x1781|"Custom":\s*6017\b/i.test(text)) return INSTANT_UNAVAILABLE;
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

export const ADVANCE_REPAID = "Your Advance was repaid before this went through. Close this and use Take another Advance instead.";

/** An Extend that lost the race with the yield crank: the Advance is repaid or closed by now. Anything else passes through. */
export function extendFailure(e: unknown): unknown {
  const text = e instanceof Error ? e.message : String(e);
  return /advance is already repaid|position has no open advance/i.test(text) ? new Error(ADVANCE_REPAID) : e;
}
