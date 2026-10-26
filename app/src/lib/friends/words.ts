/** Plain words for a Friends action's status (server/friends/rules.ts). Null when the button change says it all. */
export function friendStatusText(status: string): string | null {
  switch (status) {
    case "friend-cap":
      return "You have 500 Friends, the most you can have. Remove one to add another.";
    case "their-cap":
      return "This Player can't add more Friends right now.";
    case "request-cap":
      return "You have 50 Friend requests waiting. Wait for some answers first.";
    case "gone":
      return "That Friend request is no longer open.";
    case "self":
      return "That's you.";
    default:
      return null;
  }
}

/** Game names short enough for a chip. */
export const GAME_SHORT: Record<string, string> = {
  holdem: "Hold'em",
  "block-puzzle": "Block Burst",
  "trading-duel": "Trading Duel",
  vanguard: "Vanguard",
};
