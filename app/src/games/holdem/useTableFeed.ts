import { useEffect, useState } from "react";
import { diffTable, type TableEvent } from "./events";
import type { Table } from "./chain";

export interface Say {
  id: number;
  text: string;
  kind: "check" | "call" | "bet" | "raise" | "fold" | "allin";
}

export interface Feed {
  /** The events of the latest read that changed anything, with a counter that grows per batch. */
  batch: { id: number; events: TableEvent[] } | null;
  /** What each seat just did, shown on the seat for a moment. */
  say: [Say | null, Say | null];
  /** A one-line notice (blinds going up). */
  toast: { id: number; text: string } | null;
}

const chips = (n: bigint | number) => Number(n).toLocaleString("en-US");
const SAY_MS = 1700;
const TOAST_MS = 2600;

function sayFor(e: Extract<TableEvent, { type: "action" }>): Omit<Say, "id"> {
  if (e.allIn && e.kind !== "fold") return { kind: "allin", text: `All-in ${chips(e.amount)}` };
  switch (e.kind) {
    case "check":
      return { kind: "check", text: "Checks" };
    case "call":
      return { kind: "call", text: `Calls ${chips(e.amount)}` };
    case "bet":
      return { kind: "bet", text: `Bets ${chips(e.amount)}` };
    case "raise":
      return { kind: "raise", text: `Raises to ${chips(e.amount)}` };
    default:
      return { kind: "fold", text: "Folds" };
  }
}

interface State extends Feed {
  t: Table | null;
  n: number;
}

/**
 * What a Player should notice between table reads: the action on each seat and the blinds going up.
 * Derived while rendering from `diffTable`, so a repeated read changes nothing; callouts clear on a timer.
 */
export function useTableFeed(t: Table, seat: 0 | 1): Feed {
  const [st, setSt] = useState<State>({ t: null, n: 0, batch: null, say: [null, null], toast: null });
  if (st.t !== t) {
    const events = diffTable(st.t, t, seat);
    if (events.length === 0) {
      setSt({ ...st, t });
    } else {
      const n = st.n + 1;
      const say: [Say | null, Say | null] = [...st.say];
      let toast = st.toast;
      for (const e of events) {
        if (e.type === "action") say[e.seat] = { id: n, ...sayFor(e) };
        if (e.type === "newHand" && e.blindsUp) toast = { id: n, text: `Blinds up: ${chips(e.smallBlind)} / ${chips(e.bigBlind)}` };
      }
      setSt({ t, n, batch: { id: n, events }, say, toast });
    }
  }
  const n = st.n;
  useEffect(() => {
    if (n === 0) return;
    const a = setTimeout(() => setSt((s) => ({ ...s, say: s.say.map((x) => (x && x.id <= n ? null : x)) as State["say"] })), SAY_MS);
    const b = setTimeout(() => setSt((s) => (s.toast && s.toast.id <= n ? { ...s, toast: null } : s)), TOAST_MS);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [n]);
  return st;
}
