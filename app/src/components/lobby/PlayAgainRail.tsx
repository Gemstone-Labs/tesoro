"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Check, Heart, Minus, X } from "lucide-react";
import { matchesQuery, useSearch } from "@/components/shell/SearchContext";
import { useAccount } from "@/lib/account";
import { art } from "@/lib/art";
import { matchDelta } from "@/lib/chain/ledger";
import type { ChainMatch } from "@/lib/chain/read";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import type { GameId, MatchResult } from "@/lib/mock";
import { Rail } from "./Rail";

export interface Played {
  id: string;
  game: GameId;
  entry: number;
  result: MatchResult;
  delta: number;
  /** Block Puzzle only: your score, theirs. */
  scores: [number, number] | null;
  /** The opponent's key, when there was one. */
  opp: string | null;
  at: number;
}

export function toPlayed(m: ChainMatch): Played | null {
  if ((m.status !== "settled" && m.status !== "refunded") || m.seat === null) return null;
  const delta = matchDelta(m);
  const draw = m.session?.result === "draw";
  const refunded = m.status === "refunded" || (m.game === "block-puzzle" && !m.session);
  const scores = m.session && m.session.settled ? (m.seat === 0 ? m.session.scores : ([m.session.scores[1], m.session.scores[0]] as [number, number])) : null;
  return {
    id: m.id.toString(),
    game: m.game,
    entry: m.entry,
    result: draw ? "draw" : refunded ? "refunded" : delta > 0 ? "won" : "lost",
    delta,
    scores,
    opp: m.sides[1 - m.seat]?.player ?? null,
    at: Number(m.id >> 1n),
  };
}

const PINS = "tesoro-pinned-matches";

function usePins(): [Set<string>, (id: string) => void] {
  const [pins, setPins] = useState<Set<string>>(new Set());
  useEffect(() => {
    // Deferred: storage is not readable during the server render.
    const t = setTimeout(() => {
      try {
        const raw = localStorage.getItem(PINS);
        if (raw) setPins(new Set(JSON.parse(raw) as string[]));
      } catch {
        // no storage: pins last for this page view
      }
    }, 0);
    return () => clearTimeout(t);
  }, []);
  const toggle = (id: string) =>
    setPins((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      try {
        localStorage.setItem(PINS, JSON.stringify([...next]));
      } catch {
        // ignore
      }
      return next;
    });
  return [pins, toggle];
}

const RESULT_ICON = { won: Check, lost: X, draw: Minus, refunded: Minus } as const;

/** PLAY AGAIN: landscape tiles from the signed-in Account's real settled Matches. Hidden when there are none. */
export function PlayAgainRail() {
  const { snapshot, onChain, auth } = useAccount();
  const { query } = useSearch();
  const router = useRouter();
  const [pins, togglePin] = usePins();

  const played = useMemo(
    () =>
      (onChain ? (snapshot?.matches ?? []) : [])
        .map(toPlayed)
        .filter((p): p is Played => p !== null)
        .sort((a, b) => Number(pins.has(b.id)) - Number(pins.has(a.id)) || b.at - a.at)
        .slice(0, 3),
    [onChain, snapshot, pins],
  );
  const shown = played.filter((p) => !query.trim() || matchesQuery(GAME_NAMES[p.game], query));
  if (played.length === 0) return null;

  return (
    <Rail id="play-again" title="Play again" cols={3}>
      {shown.length === 0 && <p className="rail-empty">No earlier Matches match your search.</p>}
      {shown.map((p) => {
        const Icon = RESULT_ICON[p.result];
        const headline =
          p.result === "won" ? `You won ${fmtGemas(p.delta)}` : p.result === "lost" ? `You lost ${fmtGemas(p.entry)}` : p.result === "draw" ? "Draw · entry refunded" : "Refunded";
        const href = `/play/queue?${p.game === "holdem" ? "game=holdem&" : ""}entry=${p.entry}`;
        return (
          <div key={p.id} className="cut cut-card again">
            <button type="button" className="again-main" onClick={() => auth.gate("Enter a Match", () => router.push(href))} aria-label={`Play ${GAME_NAMES[p.game]} again for ${fmtGemas(p.entry)} Gemas. Last Match: ${headline}`}>
              <span className="again-art">
                <Image src={art.thumb[p.game]} alt="" fill sizes="140px" />
              </span>
              <span className="again-text">
                <strong>{GAME_NAMES[p.game]}</strong>
                <span className="again-result">
                  <Icon aria-hidden="true" /> {headline}
                </span>
              </span>
            </button>
            <button type="button" className="again-pin" aria-pressed={pins.has(p.id)} aria-label={pins.has(p.id) ? "Unpin this Match" : "Pin this Match first"} onClick={() => togglePin(p.id)}>
              <Heart aria-hidden="true" fill={pins.has(p.id) ? "currentColor" : "none"} />
            </button>
          </div>
        );
      })}
    </Rail>
  );
}
