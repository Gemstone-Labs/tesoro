import { useEffect, useState } from "react";
import { prefersReducedMotion } from "../fx";
import { diffTable, type TableEvent } from "./events";
import type { Table } from "./chain";
import { paced } from "./pace";

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
  /** A hand just ended: the pot is on its way to the winner, so their stack shows what it was until the chips land. */
  settle: { id: number; award: [bigint, bigint]; ms: number } | null;
  /** Board cards were just dealt and are still face down or on their way, ms until the last one has turned. */
  boardBusy: { id: number; ms: number } | null;
}

const chips = (n: bigint | number) => Number(n).toLocaleString("en-US");
const SAY_MS = paced(1700);
const TOAST_MS = paced(2600);
const BANNER_MS = paced(1200);
export const DEAL_MS = paced(1000);
/** Time each street takes to deal in a run-out, ms, and the wait before the first one (the bets reach the pot first). */
export const STREET_MS = paced(800);
export const STREET_LEAD = paced(550);
export const runoutOffset = (events: TableEvent[]): number => {
  const streets = events.filter((e) => e.type === "street").length;
  return streets ? STREET_LEAD + streets * STREET_MS : 0;
};
/** After the cards are shown, when the chips leave the pot, ms. */
export const SHOWDOWN_CHIPS_AT = paced(1500);
export const FOLD_CHIPS_AT = paced(450);
/** How long a board card travels and turns once it leaves the deck, ms. */
export const CARD_LANDS = paced(440 + 520);

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
export function useTableFeed(t: Table): Feed {
  const [st, setSt] = useState<State>({ t: null, n: 0, batch: null, say: [null, null], toast: null, banner: null, dealing: false, settle: null, boardBusy: null });
  if (st.t !== t) {
    const events = diffTable(st.t, t);
    if (events.length === 0) {
      setSt({ ...st, t });
    } else {
      const n = st.n + 1;
      const say: [Say | null, Say | null] = [...st.say];
      let toast = st.toast;
      let banner = st.banner;
      const reduced = prefersReducedMotion();
      // A new read that is not the deal itself ends the dealing pause: the table follows the latest read.
      let settle = st.settle;
      let dealing = st.dealing && events.some((e) => e.type === "deal");
      const streets = events.filter((e) => e.type === "street").length;
      const boardBusy = streets && !reduced ? { id: n, ms: runoutOffset(events) + CARD_LANDS } : null;
      for (const e of events) {
        if (e.type === "action") say[e.seat] = { id: n, ...sayFor(e) };
        if (e.type === "newHand" && e.blindsUp) toast = { id: n, text: `Blinds up: ${chips(e.smallBlind)} / ${chips(e.bigBlind)}` };
      }
      for (const e of events) {
        if (e.type === "street" && streets === 1) banner = { id: n, text: e.street[0].toUpperCase() + e.street.slice(1) };
        if (e.type === "deal" && !reduced) dealing = true;
        if (e.type === "result" && !reduced) {
          const award: [bigint, bigint] = e.winner === "split" ? [e.pot / 2n, e.pot / 2n] : e.winner === 0 ? [e.pot, 0n] : [0n, e.pot];
          settle = { id: n, award, ms: runoutOffset(events) + (e.how === "showdown" ? SHOWDOWN_CHIPS_AT : FOLD_CHIPS_AT) + paced(700) };
        }
      }
      setSt({ t, n, batch: { id: n, events }, say, toast, banner, dealing, settle, boardBusy });
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
  // The pot is on its way to the winner until the chips land (or a newer read arrives).
  const settleMs = st.settle ? (st.settle.id === n ? st.settle.ms : 0) : -1;
  useEffect(() => {
    if (settleMs < 0) return;
    const id = setTimeout(() => setSt((s) => (s.settle ? { ...s, settle: null } : s)), settleMs);
    return () => clearTimeout(id);
  }, [settleMs, n]);
  const boardMs = st.boardBusy && st.boardBusy.id === n ? st.boardBusy.ms : -1;
  useEffect(() => {
    if (boardMs < 0) return;
    const id = setTimeout(() => setSt((s) => (s.boardBusy ? { ...s, boardBusy: null } : s)), boardMs);
    return () => clearTimeout(id);
  }, [boardMs, n]);
  return st;
}
