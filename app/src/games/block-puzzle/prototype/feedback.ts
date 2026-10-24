export type BoardUrgency = "none" | "low" | "critical";

/** Visual presentation only; the Match duration and deadline remain unchanged. */
export function urgencyFor(remainingSeconds: number, running: boolean, expired: boolean): BoardUrgency {
  if (!running || expired || !Number.isFinite(remainingSeconds) || remainingSeconds <= 0) return "none";
  if (remainingSeconds <= 5) return "critical";
  return remainingSeconds <= 10 ? "low" : "none";
}
