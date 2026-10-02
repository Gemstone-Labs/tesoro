"use client";

import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { GameTabs, HistoryPages, gameFilter } from "@/components/match/MatchHistory";
import { MatchRow } from "@/components/match/MatchRow";
import { Button, Card, SkeletonCards } from "@/components/ui";
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

      {!snapshot ? (
        error ? (
          <div className="mh-state" role="alert">
            <p>Your Matches could not be read from Solana devnet.</p>
            <Button size="sm" onClick={() => void refresh()}>Try again</Button>
          </div>
        ) : (
          <div className="mh-list">
            <SkeletonCards count={4} avatar={false} className="mh-skel" label="Reading your Matches from Solana devnet…" />
          </div>
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
          <HistoryPages base="/matches" game={game} page={view.page} pages={view.pages} total={rows.length} />
        </>
      )}
      {error && snapshot && <p className="note">Could not refresh from Solana devnet; showing the last read.</p>}
    </div>
  );
}
