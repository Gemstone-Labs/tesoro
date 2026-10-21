import type { Battle } from "./decode";
import { changedPieces, endWhy } from "./end";

/** Why the Match ended: a title and one sentence, for the result screen. `titleOnly` leaves the sentence out where the board already says it. */
export function EndWhy({ battle, seat, titleOnly = false }: { battle: Battle; seat: number; titleOnly?: boolean }) {
  const why = endWhy(battle, seat);
  if (!why) return null;
  return (
    <>
      <p className="vg-why" role="status">
        <b>{why.title}</b>
        {!titleOnly && <span>{why.line}</span>}
      </p>
      {!titleOnly && <ChangedList battle={battle} seat={seat} />}
    </>
  );
}

/** The pieces whose rank changed, from the end mask (dead ones included): "Yours: Major, dug in". Nothing while the Match is on. */
export function ChangedList({ battle, seat }: { battle: Battle; seat: number }) {
  const changed = changedPieces(battle, seat);
  if (!changed.length) return null;
  return (
    <ul className="vg-end-changes" aria-label="Changed pieces">
      {changed.map((c) => (
        <li key={c.id}>
          {c.mine ? "Yours" : "Opponent's"}: {c.text}
        </li>
      ))}
    </ul>
  );
}
