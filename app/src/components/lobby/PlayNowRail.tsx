"use client";

import Image from "next/image";
import Link from "next/link";
import { Clock, X } from "lucide-react";
import { CATALOGUE, CATEGORIES, type Category } from "@/lib/catalogue";
import { matchesQuery, useSearch } from "@/components/shell/SearchContext";
import { Rail } from "./Rail";

/** PLAY NOW: two live Games bright, the announced ones dimmed and not clickable. Search and the category chips filter it. */
export function PlayNowRail({ category, onClear }: { category: Category | null; onClear: () => void }) {
  const { query, setQuery } = useSearch();
  const filtered = CATALOGUE.filter((g) => (!category || g.tags.includes(category)) && (!query.trim() || matchesQuery(g.name, query)));
  const label = category ? CATEGORIES.find((c) => c.id === category)?.label : null;

  return (
    <Rail
      id="play-now"
      title="Play now"
      viewAll="/play"
      cols={6}
      aside={
        (label || query.trim()) && (
          <span className="filter-note">
            {[label, query.trim() && `“${query.trim()}”`].filter(Boolean).join(" · ")}
            <button
              type="button"
              aria-label="Clear filters"
              onClick={() => {
                onClear();
                setQuery("");
              }}
            >
              <X aria-hidden="true" />
            </button>
          </span>
        )
      }
    >
      {filtered.length === 0 && <p className="rail-empty">No games match. Clear the filter to see every game.</p>}
      {filtered.map((g) => {
        const inner = (
          <>
            <Image src={g.tile} alt="" fill sizes="(min-width: 1440px) 16vw, 30vw" />
            <span className="tile-shade" aria-hidden="true" />
            <span className="tile-label">
              {!g.live && (
                <span className="cut cut-chip soon-chip">
                  <Clock aria-hidden="true" /> Coming soon
                </span>
              )}
              <strong>{g.name}</strong>
            </span>
          </>
        );
        return g.live ? (
          <Link key={g.key} href={`/play/${g.game}`} className="cut cut-card tile">
            {inner}
          </Link>
        ) : (
          <div key={g.key} className="cut cut-card tile soon" aria-disabled="true" aria-label={`${g.name}, coming soon`}>
            {inner}
          </div>
        );
      })}
    </Rail>
  );
}
