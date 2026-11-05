/** Railcar's words and times as every screen says them (pure: the history and the server use them too). */

/** m:ss of a ride or a countdown. */
export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** A place by finishing order: 1 = last off. */
export const PLACE_WORDS = ["Last off", "Second-last off", "Third-last off"] as const;

/** One Player's ride in a line: "Last off at 1:39", "Jumped at 0:25", "Aboard at Impact"; null for a refunded ride. */
export function rideLine(r: { kind: "place" | "early" | "aboard" | "refund"; place?: number; jumpMs?: number }): string | null {
  if (r.kind === "place") return `${PLACE_WORDS[(r.place ?? 1) - 1]} at ${clock(r.jumpMs ?? 0)}`;
  if (r.kind === "early") return `Jumped at ${clock(r.jumpMs ?? 0)}`;
  if (r.kind === "aboard") return "Aboard at Impact";
  return null;
}
