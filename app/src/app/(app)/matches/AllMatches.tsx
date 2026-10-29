"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { GameTabs, HistoryPages, ResultFilter, gameFilter, historyHref, resultCounts } from "@/components/match/MatchHistory";
import { DelayedMatches } from "@/components/match/DelayedMatches";
import { ContinueRail } from "@/components/lobby/ContinueRail";
import { MatchBanner, MatchBannerSkeleton, ResultFilterSkeleton } from "@/components/match/MatchBanner";
import { Button, Card } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { useChainData } from "@/lib/chain/ChainDataProvider";
import { fetchAllHistory } from "@/lib/chain/history-client";
import { RESULTS, historyPage, resultFilter, type HistoryRow } from "@/lib/chain/history";
import { GAME_NAMES } from "@/lib/mock";

/** Every finished Match of the signed-in Account (played or backed), newest first, 10 banners per page. */
export function AllMatches() {
  const { auth, onChain, snapshot, openMatches } = useAccount();
  const { error, refresh } = useChainData();
  const params = useSearchParams();
  const game = gameFilter(params.get("game"));
  const results = resultFilter(params.get("result"));
  const [now] = useState(() => Date.now());

  const accountKey = onChain && snapshot ? snapshot.accountKey.toBase58() : null;
  // Finished Matches come from the Match history; null: the history is not available.
  const [history, setHistory] = useState<HistoryRow[] | null | undefined>(undefined);
  useEffect(() => {
    if (!accountKey) return;
    let live = true;
    void fetchAllHistory(accountKey).then((h) => live && setHistory(h));
    return () => {
      live = false;
    };
  }, [accountKey]);
  const rows = useMemo(() => (history ?? []).filter((r) => !game || r.game === game), [history, game]);
  const shown = rows.filter((r) => results.includes(r.result));
  const open = openMatches.filter((m) => !game || m.game === game);
  const view = historyPage(shown, Number(params.get("page") ?? 1));

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
        <h1 className="page-title title-desk">Matches</h1>
        <GameTabs base="/matches" game={game} results={results} />
        {snapshot?.matchesLoaded && history !== undefined ? (
          <ResultFilter base="/matches" game={game} results={results} counts={resultCounts(rows)} />
        ) : !error ? (
          <ResultFilterSkeleton />
        ) : null}
      </header>

      {!snapshot?.matchesLoaded ? (
        error ? (
          <div className="mh-state" role="alert">
            <p>Your Matches couldn’t be loaded.</p>
            <Button size="sm" onClick={() => void refresh()}>Try again</Button>
          </div>
        ) : (
          <MatchBannerSkeleton count={4} label="Loading your Matches…" />
        )
      ) : null}
      {open.length > 0 && <ContinueRail matches={open} title="Open" rows />}
      {(!snapshot?.matchesLoaded ? !error : history === undefined || rows.length > 0) && <h2 className="h-section mh-finished-h">Finished</h2>}
      {snapshot?.matchesLoaded && <DelayedMatches matches={[...snapshot.matches, ...snapshot.funded].filter((m) => !game || m.game === game)} now={now} />}
      {snapshot?.matchesLoaded && history === undefined && <MatchBannerSkeleton count={4} label="Loading your Matches…" />}
      {snapshot?.matchesLoaded && history === null && <p className="note">Your finished Matches aren’t available right now. Matches in progress are shown above.</p>}
      {snapshot?.matchesLoaded && history && (rows.length === 0 ? (
        <div className="mh-state">
          <p>{game ? `No finished ${GAME_NAMES[game]} Matches yet.` : "No finished Matches yet."} They appear here when they finish.</p>
          <Button size="sm" href={game ? `/play/${game}` : "/play"}>Play a Match</Button>
        </div>
      ) : shown.length === 0 ? (
        <div className="mh-state">
          <p>No {game ? `${GAME_NAMES[game]} ` : ""}Matches with these results.</p>
          <Button size="sm" href={historyHref("/matches", game, 1, RESULTS)}>Show all results</Button>
        </div>
      ) : (
        <>
          <div className="mb-list" aria-label={`${game ? GAME_NAMES[game] : "All"} Matches, page ${view.page} of ${view.pages}`} role="list">
            {view.rows.map((r) => (
              <div key={r.id} role="listitem">
                <MatchBanner r={r} account={snapshot.accountKey.toBase58()} now={now} me={snapshot.accountKey.toBase58()} />
              </div>
            ))}
          </div>
          <HistoryPages base="/matches" game={game} results={results} page={view.page} pages={view.pages} total={shown.length} />
        </>
      ))}
      {error && snapshot && <p className="note">Couldn’t refresh; showing what was last loaded.</p>}
    </div>
  );
}
