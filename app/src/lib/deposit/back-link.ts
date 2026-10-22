import { gameQuery } from "@/lib/game-params";
import { GAME_NAMES } from "@/lib/mock";
import type { DepositIntent } from "./bus";

/** Where a Player who came from a game goes once their Gemas landed: straight into the Queue at the entry they were short for. */
export function backLink(intent: DepositIntent | null | undefined): { href: string; label: string; need: number } | null {
  if (!intent) return null;
  const need = intent.need && intent.need > 0 ? intent.need : 0;
  return {
    href: need ? `/play/queue?${gameQuery(intent.game)}entry=${need}` : `/play/${intent.game}`,
    label: `Play ${GAME_NAMES[intent.game]}`,
    need,
  };
}
