import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { GAME_NAMES } from "@/lib/mock";
import type { GameId } from "@/lib/mock";
import "./history.css";

const FILTERS: [GameId | null, string][] = [
  [null, "All"],
  ["block-puzzle", GAME_NAMES["block-puzzle"]],
  ["holdem", "Hold'em"],
  ["trading-duel", "Trading Duel"],
];

/** The game a `?game=` value names, null for all games. */
export const gameFilter = (v: string | null): GameId | null => (v === "block-puzzle" || v === "holdem" || v === "trading-duel" ? v : null);

/** A Match history address: the game filter and the page live in the URL. */
export function historyHref(base: string, game: GameId | null, page: number): string {
  const q = new URLSearchParams();
  if (game) q.set("game", game);
  if (page > 1) q.set("page", String(page));
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}

/** All / Block Puzzle / Hold'em over a Match history. */
export function GameTabs({ base, game }: { base: string; game: GameId | null }) {
  return (
    <nav className="mh-tabs" aria-label="Game">
      {FILTERS.map(([id, label]) => (
        <Link key={label} href={historyHref(base, id, 1)} scroll={false} aria-current={game === id ? "page" : undefined} className={game === id ? "on" : undefined}>
          {label}
        </Link>
      ))}
    </nav>
  );
}

/** Newer / Older under a Match history, with the page and the count. */
export function HistoryPages({ base, game, page, pages, total }: { base: string; game: GameId | null; page: number; pages: number; total: number }) {
  return (
    <nav className="mh-pages" aria-label="Pages">
      <PageLink to={page > 1 ? historyHref(base, game, page - 1) : null} rel="prev">
        <ChevronLeft aria-hidden="true" /> Newer
      </PageLink>
      <span className="meta tnum" aria-current="page">
        Page {page} of {pages} · {total} {total === 1 ? "Match" : "Matches"}
      </span>
      <PageLink to={page < pages ? historyHref(base, game, page + 1) : null} rel="next">
        Older <ChevronRight aria-hidden="true" />
      </PageLink>
    </nav>
  );
}

function PageLink({ to, rel, children }: { to: string | null; rel: "prev" | "next"; children: ReactNode }) {
  if (!to) {
    return (
      <span className="cut cut-btn btn sm mh-page-link" aria-disabled="true">
        {children}
      </span>
    );
  }
  return (
    <Link href={to} rel={rel} className="cut cut-btn btn sm mh-page-link">
      {children}
    </Link>
  );
}
