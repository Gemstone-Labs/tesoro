import type { GameId } from "@/lib/mock";
import type { ChainRequest } from "./backing";

/** One Request per Player: their live Request that expires soonest. Expired and closed Requests are dropped. */
export function onePerPlayer(requests: ChainRequest[]): ChainRequest[] {
  const byPlayer = new Map<string, ChainRequest>();
  for (const r of requests) {
    if (!r.live) continue;
    const seen = byPlayer.get(r.player);
    if (!seen || r.expiresAt < seen.expiresAt) byPlayer.set(r.player, r);
  }
  return [...byPlayer.values()];
}

/**
 * The Player's live Request for this Game and entry, if they already posted one. `applied`: Request addresses
 * that already applied to the Offer at hand, which cannot apply twice.
 */
export function liveRequestFor(requests: ChainRequest[], player: string, game: GameId, entry: number, applied: readonly string[] = []) {
  return requests.find((r) => r.live && r.player === player && r.game === game && r.entry === entry && !applied.includes(r.address.toBase58()));
}
