import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight, LayoutGrid } from "lucide-react";
import { PLAYED, RESULTS, historyGameName, resultParam, toggleResult, type HistoryGame } from "@/lib/chain/history";
import type { MatchResult } from "@/lib/mock";
import { historyGameShown } from "@/lib/games";
import { CATALOGUE } from "@/lib/catalogue";
import "./history.css";

const SHORT: Partial<Record<HistoryGame, string>> = { holdem: "Hold'em" };
const catalogueGame = (c: (typeof CATALOGUE)[number]) => (c.game ?? c.key) as HistoryGame;
/** All, then every live Game of the catalogue in Play's order: a Game added there gets its chip. */
const FILTERS: [HistoryGame | null, string][] = [[null, "All"], ...CATALOGUE.filter((c) => c.live).map((c): [HistoryGame, string] => [catalogueGame(c), SHORT[catalogueGame(c)] ?? historyGameName(catalogueGame(c))])];
const tileOf = (g: HistoryGame) => CATALOGUE.find((c) => catalogueGame(c) === g)?.tile;

/** The game a `?game=` value names, null for all games. */
export const gameFilter = (v: string | null): HistoryGame | null => (v !== null && historyGameShown(v) ? (v as HistoryGame) : null);

/** A Match history address: the game, the results shown and the page live in the URL. */
export function historyHref(base: string, game: HistoryGame | null, page: number, results: readonly MatchResult[] = PLAYED): string {
  const q = new URLSearchParams();
  if (game) q.set("game", game);
  const r = resultParam(results);
  if (r) q.set("result", r);
  if (page > 1) q.set("page", String(page));
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}

/** All and one chip per game (its art and short name) over a Match history; scrolls sideways when it does not fit. */
export function GameTabs({ base, game, results = PLAYED }: { base: string; game: HistoryGame | null; results?: readonly MatchResult[] }) {
  return (
    <nav className="mh-tabs" aria-label="Game">
      {FILTERS.map(([id, label]) => (
        <Link key={label} href={historyHref(base, id, 1, results)} scroll={false} aria-current={game === id ? "page" : undefined} className={`cut cut-chip${game === id ? " on" : ""}`}>
          <span className="cut mh-tab-art" aria-hidden="true">
            {id ? <Image src={tileOf(id) ?? ""} alt="" width={28} height={28} /> : <LayoutGrid />}
          </span>
          {label}
        </Link>
      ))}
    </nav>
  );
}

const RESULT_LABEL: Record<MatchResult, string> = { won: "Won", lost: "Lost", draw: "Draw", "no-show": "No-show", refunded: "Refunded" };

/** Which results a Match history shows, one toggle each with its count; results with no Matches are left out. Refunded starts off. */
export function ResultFilter({ base, game, results, counts }: { base: string; game: HistoryGame | null; results: readonly MatchResult[]; counts: Record<MatchResult, number> }) {
  const present = RESULTS.filter((r) => counts[r] > 0);
  if (present.length < 2) return null;
  return (
    <nav className="mh-results" aria-label="Results shown">
      {present.map((r) => {
        const on = results.includes(r);
        return (
          <Link
            key={r}
            href={historyHref(base, game, 1, toggleResult(results, r))}
            scroll={false}
            className={`cut cut-chip mh-result ${r}${on ? " on" : ""}`}
            aria-label={`${RESULT_LABEL[r]}: ${counts[r]} ${counts[r] === 1 ? "Match" : "Matches"}, ${on ? "shown" : "hidden"}`}
          >
            <i aria-hidden="true" />
            {RESULT_LABEL[r]}
            <span className="tnum">{counts[r]}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/** How many Matches have each result. */
export function resultCounts(rows: readonly { result: MatchResult }[]): Record<MatchResult, number> {
  const counts: Record<MatchResult, number> = { won: 0, lost: 0, draw: 0, "no-show": 0, refunded: 0 };
  for (const r of rows) counts[r.result] += 1;
  return counts;
}

/** Newer / Older under a Match history, with the page and the count. */
export function HistoryPages({ base, game, results = PLAYED, page, pages, total }: { base: string; game: HistoryGame | null; results?: readonly MatchResult[]; page: number; pages: number; total: number }) {
  if (pages <= 1) return null;
  return (
    <nav className="mh-pages" aria-label="Pages">
      <PageLink to={page > 1 ? historyHref(base, game, page - 1, results) : null} rel="prev">
        <ChevronLeft aria-hidden="true" /> Newer
      </PageLink>
      <span className="meta tnum" aria-current="page">
        Page {page} of {pages} · {total} {total === 1 ? "Match" : "Matches"}
      </span>
      <PageLink to={page < pages ? historyHref(base, game, page + 1, results) : null} rel="next">
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
