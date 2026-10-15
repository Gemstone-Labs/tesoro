import type { GameId } from "./mock/types";
import { gameQuery } from "./game-params";

type Param = string | string[] | undefined;

const BASE58_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface Rematch {
  opponent: string;
}

/** A Rematch is a Challenge: the Match result offers it only to a Player, after a settled Match, against a known opponent. */
export function canRematch(r: { role: "player" | "backer"; outcome: "won" | "lost" | "draw" | "refunded"; opponent?: string | null }): boolean {
  return r.role === "player" && r.outcome !== "refunded" && !!r.opponent && BASE58_KEY.test(r.opponent);
}

/** The Challenge link that replays a Match: same Game (and Trading Duel asset), same entry, same opponent. */
export function rematchHref(m: { game: GameId; asset?: number | null; entry: number; opponent: string }): string {
  return `/play/challenge?${gameQuery(m.game, m.asset)}entry=${m.entry}&opponent=${m.opponent}`;
}

/** The `?opponent=` of a Challenge link; undefined when absent or not a wallet address. */
export function opponentFromParam(v: Param): string | undefined {
  const o = Array.isArray(v) ? v[0] : v;
  return typeof o === "string" && BASE58_KEY.test(o) ? o : undefined;
}
