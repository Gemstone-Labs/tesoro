"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Check, ChevronDown } from "lucide-react";
import { art } from "@/lib/art";
import { signed } from "@/lib/chain/player-account";
import { GAME_NAMES } from "@/lib/mock";
import type { GameId } from "@/lib/mock";

const name = (g: GameId | null) => (g ? GAME_NAMES[g] : "All games");
const items = (root: HTMLElement | null) => [...(root?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]") ?? [])];
const tone = (n: number) => (n > 0 ? "pa-won" : n < 0 ? "pa-lost" : undefined);

/**
 * One button naming the game shown; it opens a menu of all games and each game played, with its
 * net. Arrow keys, Home and End move through the menu, Escape closes it back onto the button.
 */
export function GameMenu({
  games,
  value,
  onChange,
  nets,
}: {
  games: GameId[];
  value: GameId | null;
  onChange: (g: GameId | null) => void;
  /** Net Gemas by game, and for all games under "all". */
  nets: Map<GameId | "all", number>;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const opts = [null, ...games];

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const list = items(root.current);
    (list.find((el) => el.getAttribute("aria-checked") === "true") ?? list[0])?.focus();
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const onKey = (e: React.KeyboardEvent) => {
    const list = items(root.current);
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: list.length - 1 }[e.key];
    if (to !== undefined) {
      e.preventDefault();
      list[(to + list.length) % list.length]?.focus();
    } else if (e.key === "Escape" || e.key === "Tab") {
      if (e.key === "Escape") e.preventDefault();
      close(e.key === "Escape");
    }
  };

  return (
    <div className="pa-gm" ref={root}>
      <button
        ref={button}
        type="button"
        className="cut cut-chip pa-gm-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Game: ${name(value)}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {value && <Image src={art.thumb[value]} alt="" width={22} height={22} />}
        {name(value)}
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div className="cut cut-card pa-gm-list" role="menu" aria-label="Game" onKeyDown={onKey}>
          {opts.map((g) => (
            <button
              key={g ?? "all"}
              type="button"
              role="menuitemradio"
              aria-checked={value === g}
              tabIndex={-1}
              onClick={() => {
                onChange(g);
                close(true);
              }}
            >
              {g ? <Image src={art.thumb[g]} alt="" width={28} height={28} /> : <span className="pa-gm-all" aria-hidden="true" />}
              <span>{name(g)}</span>
              <b className={tone(nets.get(g ?? "all") ?? 0)}>{signed(nets.get(g ?? "all") ?? 0)}</b>
              <Check size={15} className="pa-gm-check" aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
