/** How many messages the side column keeps: the newest big, older ones fading. */
export const FEED_MAX = 4;

/** The message list after `say`: newest first, no blank lines, no immediate repeat. */
export function pushFeed(feed: readonly string[], say: string): string[] {
  if (!say || feed[0] === say) return [...feed];
  return [say, ...feed].slice(0, FEED_MAX);
}
