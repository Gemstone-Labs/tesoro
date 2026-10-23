"use client";

import { ContinueRail } from "@/components/lobby/ContinueRail";
import { GameGrid } from "@/components/lobby/GameGrid";
import { LiveWins } from "@/components/lobby/LiveWins";
import { useAccount } from "@/lib/account";
import { useFriends } from "@/lib/friends/FriendsProvider";
import "@/components/lobby/play-home.css";

/** Play is home: what's open for you, recent wins, then every Game. A Game's tile opens its page (entry, Play now). */
export function PlayHome() {
  const { openMatches } = useAccount();
  const friendChallenges = useFriends().view?.challenges ?? [];

  return (
    <div className="play-home">
      {(openMatches.length > 0 || friendChallenges.length > 0) && <ContinueRail matches={openMatches} challenges={friendChallenges} />}
      <LiveWins />
      <GameGrid />
    </div>
  );
}
