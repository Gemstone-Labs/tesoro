"use client";

import { PlayerAvatar, PlayerName } from "@/components/account/Player";
import { stripLine, type StripState } from "@/games/block-puzzle/opponent";

/**
 * The opponent under the board: who they are and what the public table shows of them. Their score is the last one they
 * wrote (the program stops updating it at 80 s and shows "?" from then); it is never their board.
 */
export function BurstOpponentStrip({ account, state }: { account: string | null; state: StripState }) {
  const hidden = state.kind === "hidden";
  return (
    <div className={`bpx-opp k-${state.kind}`} role="status" aria-live="polite">
      {account ? <PlayerAvatar account={account} size={32} /> : <span className="bpx-opp-q" aria-hidden="true">?</span>}
      <span className="bpx-opp-name">{account ? <PlayerName account={account} /> : "Opponent"}</span>
      <span className={`bpx-opp-line tnum${hidden ? " q" : ""}`} aria-label={hidden ? "Hidden until the Match ends" : undefined}>
        {stripLine(state)}
      </span>
    </div>
  );
}
