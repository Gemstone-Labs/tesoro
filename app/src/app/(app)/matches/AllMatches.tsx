"use client";

import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { GameTabs, HistoryPages, gameFilter } from "@/components/match/MatchHistory";
import { DelayedMatches } from "@/components/match/DelayedMatches";
import { MatchBanner, MatchBannerSkeleton } from "@/components/match/MatchBanner";
import { Button, Card } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { useChainData } from "@/lib/chain/ChainDataProvider";
import { accountHistory, historyPage } from "@/lib/chain/history";
import { GAME_NAMES } from "@/lib/mock";

/** Every finished Match of the signed-in Account (played or backed), newest first, 20 per page. */
export function AllMatches() {
  const { auth, onChain, snapshot } = useAccount();
  const { error, refresh } = useChainData();
  const params = useSearchParams();
  const game = gameFilter(params.get("game"));
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
        <GameTabs base="/matches" game={game} />
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
      {snapshot?.matchesLoaded && <DelayedMatches matches={[...snapshot.matches, ...snapshot.funded].filter((m) => !game || m.game === game)} now={now} />}
      {!snapshot?.matchesLoaded ? null : rows.length === 0 ? (
        <div className="mh-state">
          <p>{game ? `No finished ${GAME_NAMES[game]} Matches yet.` : "No finished Matches yet."} They appear here when they finish.</p>
          <Button size="sm" href={game ? `/play/${game}` : "/play"}>Play a Match</Button>
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
          <HistoryPages base="/matches" game={game} page={view.page} pages={view.pages} total={rows.length} />
        </>
      )}
      {error && snapshot && <p className="note">Couldn’t refresh; showing what was last loaded.</p>}
    </div>
  );
}
