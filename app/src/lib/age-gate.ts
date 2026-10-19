/** What the entry flow does about the 18+ confirmation (asked once per Account; the server is the source of truth). */
export type AgeGate = "checking" | "ask" | "go";

const key = (authority: string) => `tesoro:age18:${authority}`;

/** `server`: null while unknown (not asked yet, or the call failed). `cached`: this browser remembers a confirmation. */
export function ageGate(input: { server: boolean | null; cached: boolean; checked: boolean }): AgeGate {
  if (input.server === true || input.cached) return "go";
  if (input.server === false) return "ask";
  // The server could not say: nothing is confirmed, so the Player is asked.
  return input.checked ? "ask" : "checking";
}

export function readAgeCache(authority: string): boolean {
  try {
    return localStorage.getItem(key(authority)) === "1";
  } catch {
    return false;
  }
}

export function writeAgeCache(authority: string) {
  try {
    localStorage.setItem(key(authority), "1");
  } catch {
    /* a convenience only */
  }
}
