/**
 * What a Player is told when a table Match was never started because a Player did not check in (Hold'em, Trading Duel, Vanguard).
 * The rule (founder, 2026-10-23): the Player who showed up wins a normal Match; if neither did, it is a no-show and each side pays
 * the Platform Fee. Same wording as Block Burst's check-in loss.
 */
export function absenceLine(checkedIn: readonly [boolean, boolean], seat: 0 | 1): string {
  const mine = checkedIn[seat];
  const theirs = checkedIn[seat === 0 ? 1 : 0];
  if (mine && !theirs) return "Your opponent didn’t show up. The Match is yours.";
  if (!mine && theirs) return "You didn’t check in in time.";
  return "Nobody checked in in time. Each side pays the Platform Fee.";
}
