/** Matches whose Pot has already counted up in this tab: the count-up plays once per Match, not at every stage. */
const counted = new Set<string>();

/** Where the Pot count-up starts for this Match: 0 the first time, the full Pot once it has played. */
export function potCountFrom(matchId: string | undefined, pot: number): number {
  return matchId && counted.has(matchId) ? pot : 0;
}

/** Records that the Pot count-up has played for this Match. */
export function markPotCounted(matchId: string | undefined): void {
  if (matchId) counted.add(matchId);
}
