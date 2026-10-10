/**
 * The one line a Player sees for a failed action. Program messages ("Error Message: …") and our own
 * sentences pass through; transport and infrastructure failures (signatures, logs, rollup steps,
 * custom error codes) become a plain retry line.
 */
export const BUSY = "The network is busy right now. Wait a few seconds and try again.";
export const RETRY = "That didn’t go through. Try again in a moment.";

export function plainError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const err = e as { code?: number; name?: string };
  if (err?.name === "UserRejectedRequestError" || err?.code === 4001 || /user rejected|rejected the request|user denied/i.test(text)) {
    return "You cancelled the request in your wallet.";
  }
  const program = /Error Message: ([^\n]+)/.exec(text);
  if (program) return program[1].replace(/\.$/, "");
  if (/\b429\b|rate.?limit|too many requests|exceeds defined limit|took too long|timed? ?out|not confirmed|blockhash|failed to fetch|fetch failed|network ?error|unknown RPC error/i.test(text)) return BUSY;
  if (/insufficient (funds|lamports)|attempt to debit an account but found no record/i.test(text)) return "Not enough SOL to cover the network fee. Try again in a moment.";
  const first = text.split("\n")[0];
  if (/tx failed|\bfailed [1-9A-HJ-NP-Za-km-z]{32,}|InstructionError|Custom\b|"Custom"|base layer|rollup|delegat|\bTEE\b|\bcommit/i.test(first)) return RETRY;
  return first.length > 200 ? `${first.slice(0, 200)}…` : first;
}
