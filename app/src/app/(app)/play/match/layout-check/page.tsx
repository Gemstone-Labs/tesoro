"use client";

import { Suspense, useState } from "react";
import { notFound, useSearchParams } from "next/navigation";
import { Arena } from "@/games/fx";
import { MatchStage, StageAction } from "@/components/match/MatchStage";
import { DEV_WALLET } from "@/lib/chain/config";
import type { GameId } from "@/lib/mock";

function Preview() {
  const params = useSearchParams();
  const [deadline] = useState(() => Math.floor(Date.now() / 1000) + 3600);
  if (params.has("motion")) return <div data-rail-preview>
    {(["block-puzzle", "holdem", "trading-duel", "vanguard"] as GameId[]).flatMap((game) =>
      (["waiting", "setup"] as const).map((kind) => <div key={`${game}-${kind}`} data-rail-case={`${game}/${kind}`}>
        <Arena game={game}><MatchStage game={game} kind={kind} entry={500} pot={940}
          me="B6AeTq3rNbHkzG4mJdP7wq8vXsY2cLf5eRuKa9hFRPm" opponent="D1gtWm5xQ8pLr2nVb7kZs4yHc6jTe3uAo9fGi1d5uHP" />
        </Arena>
      </div>))}
  </div>;
  const game = (["block-puzzle", "holdem", "trading-duel", "vanguard"] as GameId[]).find((g) => g === params.get("game")) ?? "block-puzzle";
  return <Arena game={game}>
    <MatchStage game={game} kind="waiting" entry={500} pot={940} me="B6AeTq3rNbHkzG4mJdP7wq8vXsY2cLf5eRuKa9hFRPm" opponent={null}
      deadline={deadline}
      challengeLink={params.has("challenge") ? "https://play.tesoro.games/play/challenge/example" : null}
      error={params.has("error") ? "We couldn’t refund your entry. Please try again." : null}
      actions={<StageAction onClick={() => {}}>Cancel and refund</StageAction>} />
  </Arena>;
}

/** Local rendering of the real waiting screen and shell, without funding a Match. */
export default function LayoutCheck() {
  if (!DEV_WALLET) notFound();
  return <Suspense><Preview /></Suspense>;
}
