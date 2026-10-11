import { useEffect, useState } from "react";
import { prefersReducedMotion } from "../fx";
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
  /** The street just dealt, to announce ("Flop"). */
  banner: { id: number; text: string } | null;
  /** The hand has just been dealt: the Player's cards are still on their way, face down. */
  dealing: boolean;
}

const chips = (n: bigint | number) => Number(n).toLocaleString("en-US");
const SAY_MS = 1700;
const TOAST_MS = 2600;
const BANNER_MS = 1200;
const DEAL_MS = 1000;

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
  const [st, setSt] = useState<State>({ t: null, n: 0, batch: null, say: [null, null], toast: null, banner: null, dealing: false });
  if (st.t !== t) {
    const events = diffTable(st.t, t, seat);
    if (events.length === 0) {
      setSt({ ...st, t });
    } else {
      const n = st.n + 1;
      const say: [Say | null, Say | null] = [...st.say];
      let toast = st.toast;
      let banner = st.banner;
      const reduced = prefersReducedMotion();
      // A new read that is not the deal itself ends the dealing pause: the table follows the latest read.
      let dealing = st.dealing && events.some((e) => e.type === "deal");
      for (const e of events) {
        if (e.type === "action") say[e.seat] = { id: n, ...sayFor(e) };
        if (e.type === "newHand" && e.blindsUp) toast = { id: n, text: `Blinds up: ${chips(e.smallBlind)} / ${chips(e.bigBlind)}` };
      }
      for (const e of events) {
        if (e.type === "street") banner = { id: n, text: e.street[0].toUpperCase() + e.street.slice(1) };
        if (e.type === "deal" && !reduced) dealing = true;
      }
      setSt({ t, n, batch: { id: n, events }, say, toast, banner, dealing });
    }
  }
  const n = st.n;
  useEffect(() => {
    if (n === 0) return;
    const a = setTimeout(() => setSt((s) => ({ ...s, say: s.say.map((x) => (x && x.id <= n ? null : x)) as State["say"] })), SAY_MS);
    const b = setTimeout(() => setSt((s) => (s.toast && s.toast.id <= n ? { ...s, toast: null } : s)), TOAST_MS);
    const c = setTimeout(() => setSt((s) => (s.banner && s.banner.id <= n ? { ...s, banner: null } : s)), BANNER_MS);
    const d = setTimeout(() => setSt((s) => (s.dealing ? { ...s, dealing: false } : s)), DEAL_MS);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
      clearTimeout(c);
      clearTimeout(d);
    };
  }, [n]);
  return st;
}
