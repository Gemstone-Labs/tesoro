"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Check, Heart, Minus, X } from "lucide-react";
import { matchesQuery, useSearch } from "@/components/shell/SearchContext";
import { useAccount } from "@/lib/account";
import { art } from "@/lib/art";
import { backingText, historyRow, type HistoryRow } from "@/lib/chain/history";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import { Rail } from "./Rail";

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

  const all = useMemo(
    () =>
      (onChain ? (snapshot?.matches ?? []) : [])
        .map(historyRow)
        .filter((p): p is HistoryRow => p !== null),
    [onChain, snapshot],
  );
  const played = [...all].sort((a, b) => Number(pins.has(b.id)) - Number(pins.has(a.id)) || b.at - a.at).slice(0, 3);
  const shown = played.filter((p) => !query.trim() || matchesQuery(GAME_NAMES[p.game], query));
  if (played.length === 0) return null;

  return (
    <Rail id="play-again" title="Play again" cols={3} viewAll="/matches">
      {shown.length === 0 && <p className="rail-empty">No earlier Matches match your search.</p>}
      {shown.map((p) => {
        const Icon = RESULT_ICON[p.result];
        const headline =
          p.result === "won" ? `You won ${fmtGemas(p.delta)}` : p.result === "lost" ? (p.backing ? "You lost · 0 Gemas" : `You lost ${fmtGemas(-p.delta)}`) : p.result === "draw" ? "Draw · entry refunded" : "Refunded";
        const backing = backingText(p);
        const href = `/play/queue?${p.game === "holdem" ? "game=holdem&" : ""}entry=${p.entry}`;
        return (
          <div key={p.id} className="cut cut-card again">
            <button type="button" className="again-main" onClick={() => auth.gate("Enter a Match", () => router.push(href))} aria-label={`Play ${GAME_NAMES[p.game]} again for ${fmtGemas(p.entry)} Gemas. Last Match: ${headline}${backing ? `. ${backing}` : ""}`}>
              <span className="again-art">
                <Image src={art.thumb[p.game]} alt="" fill sizes="140px" />
              </span>
              <span className="again-text">
                <strong>{GAME_NAMES[p.game]}</strong>
                <span className="again-result">
                  <Icon aria-hidden="true" /> {headline}
                </span>
                {backing && <span className="again-backing">{backing}</span>}
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
