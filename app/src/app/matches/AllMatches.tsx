"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { MatchRow } from "@/components/match/MatchRow";
import { Button, Card } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { useChainData } from "@/lib/chain/ChainDataProvider";
import { accountHistory, historyPage } from "@/lib/chain/history";
import { GAME_NAMES } from "@/lib/mock";
import type { GameId } from "@/lib/mock";

const FILTERS: [GameId | null, string][] = [
  [null, "All"],
  ["block-puzzle", GAME_NAMES["block-puzzle"]],
  ["holdem", "Hold'em"],
];

const href = (game: GameId | null, page: number) => {
  const q = new URLSearchParams();
  if (game) q.set("game", game);
  if (page > 1) q.set("page", String(page));
  const s = q.toString();
  return s ? `/matches?${s}` : "/matches";
};

/** Every finished Match of the signed-in Account (played or backed), newest first, 20 per page. */
export function AllMatches() {
  const { auth, onChain, snapshot } = useAccount();
  const { error, refresh } = useChainData();
  const params = useSearchParams();
  const gameParam = params.get("game");
  const game: GameId | null = gameParam === "block-puzzle" || gameParam === "holdem" ? gameParam : null;
  const [now] = useState(() => Date.now());

  const rows = useMemo(
    () => (onChain && snapshot ? accountHistory(snapshot.matches, snapshot.funded).filter((r) => !game || r.game === game) : []),
    [onChain, snapshot, game],
  );
  const view = historyPage(rows, Number(params.get("page") ?? 1));

  if (auth.status === "signed-out") {
    return (
      <Card large as="section" aria-label="Sign in to see your Matches">
        <div className="stack">
          <h1 className="page-title">Matches</h1>
          <p className="meta">Your Match history belongs to your Account. Sign in to see it.</p>
          <Button block onClick={() => auth.openSignIn()}>Sign in</Button>
        </div>
      </Card>
    );
  }

  return (
    <div className="mh-page">
      <header className="mh-head">
        <h1 className="page-title">Matches</h1>
        <nav className="mh-tabs" aria-label="Game">
          {FILTERS.map(([id, label]) => (
            <Link key={label} href={href(id, 1)} aria-current={game === id ? "page" : undefined} className={game === id ? "on" : undefined}>
              {label}
            </Link>
          ))}
        </nav>
      </header>

      {!snapshot ? (
        error ? (
          <div className="mh-state" role="alert">
            <p>Your Matches could not be read from Solana devnet.</p>
            <Button size="sm" onClick={() => void refresh()}>Try again</Button>
          </div>
        ) : (
          <p className="meta mh-state" role="status">Reading your Matches from Solana devnet…</p>
        )
      ) : rows.length === 0 ? (
        <div className="mh-state">
          <p>{game ? `No finished ${GAME_NAMES[game]} Matches yet.` : "No finished Matches yet."} They appear here as they settle on Solana devnet.</p>
          <Button size="sm" href={game ? `/play/${game}` : "/play"}>Play a Match</Button>
        </div>
      ) : (
        <>
          <div className="mh-list" aria-label={`${game ? GAME_NAMES[game] : "All"} Matches, page ${view.page} of ${view.pages}`} role="list">
            {view.rows.map((r) => (
              <div key={r.id} role="listitem">
                <MatchRow r={r} now={now} showGame={!game} />
              </div>
            ))}
          </div>
          <nav className="mh-pages" aria-label="Pages">
            <PageLink to={view.page > 1 ? href(game, view.page - 1) : null} rel="prev">
              <ChevronLeft aria-hidden="true" /> Newer
            </PageLink>
            <span className="meta tnum" aria-current="page">
              Page {view.page} of {view.pages} · {rows.length} {rows.length === 1 ? "Match" : "Matches"}
            </span>
            <PageLink to={view.page < view.pages ? href(game, view.page + 1) : null} rel="next">
              Older <ChevronRight aria-hidden="true" />
            </PageLink>
          </nav>
        </>
      )}
      {error && snapshot && <p className="note">Could not refresh from Solana devnet; showing the last read.</p>}
    </div>
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
