import type { GameId } from "@/lib/mock/types";

/** What sent the Player to the deposit modal: a game they can't enter yet, and the entry they're short for. */
export interface DepositIntent {
  game: GameId;
  need?: number | null;
}

/** Asks the app shell's deposit modal to open (the top bar's Gemas pill, a game that needs Gemas, the Vault). */
const bus = new EventTarget();
const EVENT = "deposit";

export function requestDeposit(intent?: DepositIntent | null) {
  bus.dispatchEvent(new CustomEvent<DepositIntent | null>(EVENT, { detail: intent ?? null }));
}

export function onDeposit(cb: (intent: DepositIntent | null) => void) {
  const handler = (e: Event) => cb((e as CustomEvent<DepositIntent | null>).detail ?? null);
  bus.addEventListener(EVENT, handler);
  return () => bus.removeEventListener(EVENT, handler);
}
