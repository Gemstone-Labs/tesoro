import type { GameId } from "@/lib/mock";

/** What the entry screen already knows about a Match it just opened, so the Match page can show the waiting screen at once instead of a loading stage while it reads the chain. */
export interface EnteredHint {
  game: GameId;
  entry: number;
  challenge: boolean;
}

// In memory only: it lives for the client-side navigation from the entry screen to the Match page, never across a reload.
const hints = new Map<string, EnteredHint>();

export function rememberEntered(id: string, hint: EnteredHint): void {
  hints.set(id, hint);
}

export function enteredHint(id: string | undefined): EnteredHint | null {
  return (id !== undefined && hints.get(id)) || null;
}
