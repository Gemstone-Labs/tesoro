/**
 * What a Player confirms before their first deposit (founders, 2026-10-21). Stored server-side with its version;
 * a new version asks again. Every "I understand" records it; the Player may tick "Don't show this again" to skip the step next time. Founders review this wording before mainnet.
 */
export const DEPOSIT_ACK_VERSION = "2026-10-21";

export const DEPOSIT_ACK_TITLE = "Before you deposit";

export const DEPOSIT_ACK_POINTS: readonly string[] = [
  "My deposit stays locked for about 12 months. It can take longer.",
  "Tesoro stakes my deposit. My Gemas are the staking rewards it will earn over that time, given to me now.",
  "I get my deposit back in SOL. What it's worth in dollars depends on the SOL price when I withdraw, so it can be more or less than I put in.",
  "If I lose Matches, I lose Gemas, not my deposit.",
];

export const DEPOSIT_ACK_CONFIRM = "I understand";
export const DEPOSIT_ACK_SKIP = "Don't show this again";
