"use client";

import Image from "next/image";
import Link from "next/link";
import type { PointerEvent } from "react";
import { Clock, X } from "lucide-react";
import { practiceHref } from "@/lib/game-params";
import { CATALOGUE } from "@/lib/catalogue";
import { matchesQuery, useSearch } from "@/components/shell/SearchContext";
import { Rail } from "./Rail";
import { useQueueDepth } from "./useQueueDepth";

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

/** PLAY NOW: the live Games as large tiles, the announced ones as one quiet strip. Search filters it. */
export function PlayNowRail() {
  const { query, setQuery } = useSearch();
  const depth = useQueueDepth();
  const matches = CATALOGUE.filter((g) => !query.trim() || matchesQuery(g.name, query));
  const live = matches.filter((g) => g.live);
  const soon = matches.filter((g) => !g.live);
  const filtering = Boolean(query.trim());

  return (
    <Rail
      id="play-now"
      title={filtering ? "Search results" : "Play now"}
      cols={2}
      aside={
        filtering && (
          <span className="filter-note">
            “{query.trim()}”
            <button type="button" aria-label="Clear search" onClick={() => setQuery("")}>
              <X aria-hidden="true" />
            </button>
          </span>
        )
      }
    >
      {matches.length === 0 && <p className="rail-empty">No games match. Clear the search to see every game.</p>}
      {live.map((g, i) => (
        <div key={g.key} className={`tile-cell${i === live.length - 1 && live.length % 2 === 1 ? " last-odd" : ""}`}>
          <Link href={`/play/${g.game}`} className="cut cut-frame tile" onPointerMove={tilt} onPointerLeave={untilt}>
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
          {g.game && (
            <Link href={practiceHref(g.game)} className="cut cut-chip tile-practice">
              Practice free
            </Link>
          )}
        </div>
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
