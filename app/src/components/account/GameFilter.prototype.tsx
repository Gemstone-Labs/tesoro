"use client";

/**
 * PROTOTYPE: four takes on the Gemas panel's game filter (?variant=now|A|B|C|D).
 * now = the current labels (bare radio dots), A Rail, B Tabs, C Game tiles, D Menu.
 * Throwaway: the winner gets rewritten into GemasPanel / account.css on main.
 */
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import { art } from "@/lib/art";
import { GAME_NAMES } from "@/lib/mock";
import type { GameId } from "@/lib/mock";
import { signed } from "@/lib/chain/player-account";
import { PrototypeSwitcher, usePrototypeVariant } from "@/components/prototype/PrototypeSwitcher";
import "./game-filter.prototype.css";

export const FILTER_VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Rail" },
  { key: "B", name: "Tabs" },
  { key: "C", name: "Game tiles" },
  { key: "D", name: "Menu" },
] as const;
export type FilterVariant = (typeof FILTER_VARIANTS)[number]["key"];
export const useFilterVariant = () => usePrototypeVariant(FILTER_VARIANTS.map((v) => v.key));

type Stat = { net: number; n: number };
type Props = {
  games: GameId[];
  value: GameId | null;
  onChange: (g: GameId | null) => void;
  stats: Map<GameId | "all", Stat>;
  group: string;
};

const SHORT: Record<GameId, string> = { "block-puzzle": "Block Puzzle", holdem: "Hold'em", "trading-duel": "Trading Duel" };
const name = (g: GameId | null) => (g ? GAME_NAMES[g] : "All games");
const tone = (n: number) => (n > 0 ? "up" : n < 0 ? "down" : undefined);

export function FilterSwitcher() {
  return <PrototypeSwitcher variants={FILTER_VARIANTS} />;
}

/* now: what main renders today */
export function FilterNow({ games, value, onChange, group }: Props) {
  return (
    <fieldset className="pa-filter">
      <legend className="sr-only">Game</legend>
      {[null, ...games].map((g) => (
        <label key={g ?? "all"} className="asset">
          <input type="radio" name={group} checked={value === g} onChange={() => onChange(g)} />
          <span className="cut cut-chip">{name(g)}</span>
        </label>
      ))}
    </fieldset>
  );
}

/* A: the rail the entry and asset pickers use, small, steel piece */
export function FilterRail({ games, value, onChange, group }: Props) {
  const opts = [null, ...games];
  const i = Math.max(0, opts.indexOf(value));
  return (
    <fieldset className="cut rail gf-rail" style={{ ["--n" as string]: opts.length, ["--i" as string]: i }}>
      <legend className="sr-only">Game</legend>
      <span className="rail-thumb" aria-hidden="true" />
      {opts.map((g) => (
        <label key={g ?? "all"}>
          <input type="radio" name={group} checked={value === g} onChange={() => onChange(g)} />
          <span className="cut">{g ? SHORT[g] : "All"}</span>
        </label>
      ))}
    </fieldset>
  );
}

/* B: text tabs across the panel, like the Match history tabs below, with the Match count */
export function FilterTabs({ games, value, onChange, stats }: Props) {
  const opts = [null, ...games];
  return (
    <div className="gf-tabs" role="tablist" aria-label="Game">
      {opts.map((g) => {
        const s = stats.get(g ?? "all")!;
        return (
          <button key={g ?? "all"} type="button" role="tab" aria-selected={value === g} className={value === g ? "on" : undefined} onClick={() => onChange(g)}>
            {name(g)}
            <small>{s.n}</small>
          </button>
        );
      })}
    </div>
  );
}

/* C: one tile per game with its own net; the filter doubles as the per-game breakdown */
export function FilterTiles({ games, value, onChange, stats, group }: Props) {
  const opts = [null, ...games];
  return (
    <fieldset className="gf-tiles" style={{ ["--n" as string]: opts.length }}>
      <legend className="sr-only">Game</legend>
      {opts.map((g) => {
        const s = stats.get(g ?? "all")!;
        return (
          <label key={g ?? "all"} className="gf-tile">
            <input type="radio" name={group} checked={value === g} onChange={() => onChange(g)} />
            <span className="cut cut-chip">
              {g ? (
                <img src={art.thumb[g]} alt="" />
              ) : (
                <span className="gf-stack" aria-hidden="true">
                  {games.slice(0, 3).map((x) => (
                    <img key={x} src={art.thumb[x]} alt="" />
                  ))}
                </span>
              )}
              <span className="gf-tile-txt">
                <b>{g ? SHORT[g] : "All games"}</b>
                <small>
                  <em className={tone(s.net)}>{signed(s.net)}</em>
                </small>
              </span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

/* D: one compact button; the list opens under it with each game's net */
export function FilterMenu({ games, value, onChange, stats }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", off);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", off);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const opts = [null, ...games];
  return (
    <div className="gf-menu" ref={ref}>
      <button type="button" className="cut cut-chip gf-menu-btn" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {value && <img src={art.thumb[value]} alt="" />}
        {name(value)}
        <ChevronDown size={16} />
      </button>
      {open && (
        <ul className="cut cut-card gf-menu-list" role="listbox" aria-label="Game">
          {opts.map((g) => {
            const s = stats.get(g ?? "all")!;
            return (
              <li key={g ?? "all"} role="option" aria-selected={value === g}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(g);
                    setOpen(false);
                  }}
                >
                  {g ? <img src={art.thumb[g]} alt="" /> : <span className="gf-all-ico" aria-hidden="true" />}
                  <span>{name(g)}</span>
                  <em className={tone(s.net)}>{signed(s.net)}</em>
                  <Check size={15} className="gf-check" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
