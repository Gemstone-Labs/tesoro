import { delayedOf } from "../../lib/chain/match-status";
import type { OpenMatchStore } from "./open-match";
import { handleEvent, type NotifyDeps } from "./service";

export interface DelayedDeps {
  matches: OpenMatchStore;
  /** Null when this server cannot send email. */
  notify: NotifyDeps | null;
  /** Milliseconds, like NotifyDeps.now. */
  now?: () => number;
}

/**
 * "Delayed, refunds by <deadline>": emails the Players of every joined Match that should have settled by now. It reads
 * only the open-Match table the webhook fills, so it makes no chain request. The event id holds the once-only record (one
 * email per Match and Player); the table's flag just stops asking again.
 */
export async function delayedPass(deps: DelayedDeps): Promise<{ told: number }> {
  if (!deps.notify) return { told: 0 };
  const nowSecs = Math.floor((deps.now ?? Date.now)() / 1000);
  let told = 0;
  for (const m of await deps.matches.toCheck()) {
    const late = m.deadline === null ? null : delayedOf({ status: "active", game: m.game, deadline: m.deadline }, nowSecs);
    if (!late) continue;
    for (const p of m.players) {
      await handleEvent(deps.notify, { kind: "match-delayed", id: `match-delayed:${m.matchKey}:${p.authority}`, authority: p.authority, matchId: m.matchKey, game: m.game, refundBy: late.refundBy, refundOpen: late.refundOpen });
    }
    await deps.matches.delayedTold(m.matchState);
    told++;
  }
  await deps.matches.prune(nowSecs);
  return { told };
}
