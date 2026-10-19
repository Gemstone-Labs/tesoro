import type { Battle } from "./decode";
import { endWhy } from "./end";

/** Why the Match ended: a title and one sentence, for the result screen. `titleOnly` leaves the sentence out where the board already says it. */
export function EndWhy({ battle, seat, titleOnly = false }: { battle: Battle; seat: number; titleOnly?: boolean }) {
  const why = endWhy(battle, seat);
  if (!why) return null;
  return (
    <p className="vg-why" role="status">
      <b>{why.title}</b>
      {!titleOnly && <span>{why.line}</span>}
    </p>
  );
}
