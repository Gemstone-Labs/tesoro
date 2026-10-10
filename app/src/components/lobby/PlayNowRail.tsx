"use client";

import Image from "next/image";
import Link from "next/link";
import { useState, type PointerEvent } from "react";
import { ChartColumn, Clock, LayoutGrid, Spade, Users, X, type LucideIcon } from "lucide-react";
import { CATALOGUE, CATEGORIES, type Category } from "@/lib/catalogue";
import { matchesQuery, useSearch } from "@/components/shell/SearchContext";
import { Rail } from "./Rail";
import { useQueueDepth } from "./useQueueDepth";

const CHIP_ICON: Record<Category, LucideIcon> = {
  puzzle: LayoutGrid,
  cards: Spade,
  "head-to-head": Users,
  async: Clock,
  backing: ChartColumn,
};

const GAME_LINE: Record<string, string> = {
  "block-puzzle": "Play anytime · same pieces · higher score wins",
  holdem: "Real-time · 2 players",
  "trading-duel": "Real-time · 5 minutes · live prices",
};

/** Tilt a tile toward the pointer and move its glare with it (mouse only; still under reduced motion). */
function tilt(e: PointerEvent<HTMLElement>) {
  if (e.pointerType !== "mouse" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  el.style.setProperty("--ry", `${(x - 0.5) * 7}deg`);
  el.style.setProperty("--rx", `${(0.5 - y) * 6}deg`);
  el.style.setProperty("--gx", `${x * 100}%`);
  el.style.setProperty("--gy", `${y * 100}%`);
}
function untilt(e: PointerEvent<HTMLElement>) {
  const el = e.currentTarget;
  ["--rx", "--ry", "--gx", "--gy"].forEach((p) => el.style.removeProperty(p));
}

/** PLAY NOW: the live Games as large tiles, the announced ones as one quiet strip. The category chips and search filter it. */
export function PlayNowRail() {
  const { query, setQuery } = useSearch();
  const [category, setCategory] = useState<Category | null>(null);
  const depth = useQueueDepth();
  const matches = CATALOGUE.filter((g) => (!category || g.tags.includes(category)) && (!query.trim() || matchesQuery(g.name, query)));
  const live = matches.filter((g) => g.live);
  const soon = matches.filter((g) => !g.live);
  const filtering = Boolean(category) || Boolean(query.trim());

  const pick = (id: Category) => {
    if (id === "backing") {
      document.getElementById("back-a-player")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      return;
    }
    setCategory((cur) => (cur === id ? null : id));
  };

  return (
    <Rail
      id="play-now"
      title="Play now"
      cols={2}
      aside={
        filtering && (
          <span className="filter-note">
            {[category && CATEGORIES.find((c) => c.id === category)?.label, query.trim() && `“${query.trim()}”`].filter(Boolean).join(" · ")}
            <button
              type="button"
              aria-label="Clear filters"
              onClick={() => {
                setCategory(null);
                setQuery("");
              }}
            >
              <X aria-hidden="true" />
            </button>
          </span>
        )
      }
      lead={
        <nav className="cats" aria-label="Game categories">
          {CATEGORIES.map(({ id, label }) => {
            const Icon = CHIP_ICON[id];
            return (
              <button key={id} type="button" className={`cut cut-card cat${category === id ? " on" : ""}`} aria-pressed={id === "backing" ? undefined : category === id} onClick={() => pick(id)}>
                <Icon aria-hidden="true" />
                {label}
              </button>
            );
          })}
        </nav>
      }
    >
      {matches.length === 0 && <p className="rail-empty">No games match. Clear the filter to see every game.</p>}
      {live.map((g) => (
        <Link key={g.key} href={`/play/${g.game}`} className="cut cut-frame tile" onPointerMove={tilt} onPointerLeave={untilt}>
          <Image src={g.wide ?? g.tile} alt="" fill sizes="(min-width: 1024px) 40vw, 100vw" style={g.wide ? { objectPosition: "right center" } : undefined} />
          <span className="tile-shade" aria-hidden="true" />
          <span className="tile-glare" aria-hidden="true" />
          <span className="cut cut-chip tile-live">
            <i className="live-dot" aria-hidden="true" />
            {g.game && depth[g.game] > 0 ? `${depth[g.game]} waiting in Queue` : "Live now"}
          </span>
          <span className="tile-label">
            <strong>{g.name}</strong>
            <span>{GAME_LINE[g.key]}</span>
          </span>
        </Link>
      ))}
      {soon.length > 0 && (
        <div className="soon-strip" style={{ gridColumn: "1 / -1" }}>
          <b>
            <Clock aria-hidden="true" /> Coming soon
          </b>
          {soon.map((g) => (
            <span key={g.key} className="soon-item" aria-disabled="true">
              <span className="cut soon-thumb" aria-hidden="true">
                <Image src={g.tile} alt="" fill sizes="36px" />
              </span>
              {g.name}
            </span>
          ))}
        </div>
      )}
    </Rail>
  );
}
