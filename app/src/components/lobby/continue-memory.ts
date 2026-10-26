/** Whether the Account's last finished read found open Matches or Challenges: a hint that the Continue row is likely to come back. */
const keyOf = (account: string) => `tesoro.continue.${account}`;

export function readHadContinue(account: string | null): boolean {
  if (!account) return false;
  try {
    return window.localStorage.getItem(keyOf(account)) === "1";
  } catch {
    return false;
  }
}

export function writeHadContinue(account: string, had: boolean): void {
  try {
    window.localStorage.setItem(keyOf(account), had ? "1" : "0");
  } catch {
    // Private windows and blocked storage: the row simply shows no placeholder next time.
  }
}

export interface ContinueShape {
  /** Open Matches or Challenges are shown. */
  items: boolean;
  /** The same-height placeholder is shown. */
  placeholder: boolean;
}

/** How the Continue row moves when its shape changes: it reveals when items arrive from nothing, folds away when a placeholder finds nothing, and swaps in place otherwise. */
export function continueMotion(prev: ContinueShape, next: ContinueShape): "none" | "reveal" | "collapse" {
  if (next.items && !prev.items && !prev.placeholder) return "reveal";
  if (!next.items && !next.placeholder && prev.placeholder) return "collapse";
  return "none";
}

/** Whether the placeholder shows: only while loading, signed in, with nothing found yet, and when the last read found something. */
export function continuePlaceholder(o: { items: boolean; pending: boolean; signedIn: boolean; likely: boolean }): boolean {
  return !o.items && o.pending && o.signedIn && o.likely;
}
