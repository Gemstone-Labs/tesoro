import type { Battle } from "./decode";
import { endWhy } from "./end";

/** Why the Match ended, in one line, for the end panel and the result screen. */
export function EndWhy({ battle, seat }: { battle: Battle; seat: number }) {
  const why = endWhy(battle, seat);
  if (!why) return null;
  return (
    <p className="vg-why" role="status">
      <b>{why.title}</b>
      <span>{why.line}</span>
    </p>
  );
}
