import { GAME_NAMES, type GameId } from "@/lib/mock";
import type { DepositIntent } from "./bus";

/**
 * `/vault?deposit=1` (Simple links) and `/vault?open=1` (Advanced links, old `/wallet` links) both mean "open Get Gemas":
 * whichever view the Player is in opens its own. A game that sent them adds `game` and the entry as `need`.
 */
export function readGemasQuery(params: URLSearchParams): { wanted: boolean; intent: DepositIntent | null } {
  const wanted = params.get("deposit") === "1" || params.get("open") === "1";
  const game = params.get("game");
  const need = Math.floor(Number(params.get("need")));
  const intent: DepositIntent | null = game && game in GAME_NAMES ? { game: game as GameId, need: need > 0 ? need : null } : null;
  return { wanted, intent };
}
