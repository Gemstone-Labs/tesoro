"use client";

import { ContinueRail, ContinueSkeleton } from "@/components/lobby/ContinueRail";
import { GameGrid } from "@/components/lobby/GameGrid";
import { LiveWins } from "@/components/lobby/LiveWins";
import { useAccount } from "@/lib/account";
import { useFriends } from "@/lib/friends/FriendsProvider";
import "@/components/lobby/play-home.css";

/** Play is home: what's open for you, recent wins, then every Game. A Game's tile opens its page (entry, Play now). */
export function PlayHome() {
  const { openMatches, auth, snapshot, error } = useAccount();
  const friends = useFriends();
  const friendChallenges = friends.view?.challenges ?? [];
  const pending = auth.status === "loading" || (auth.status === "signed-in" && ((!snapshot?.matchesLoaded && !error) || friends.status === "loading" || friends.status === "locked"));

  return (
    <div className="play-home">
      {openMatches.length > 0 || friendChallenges.length > 0 ? <ContinueRail matches={openMatches} challenges={friendChallenges} /> : pending ? <ContinueSkeleton /> : null}
      <LiveWins />
      <GameGrid />
    </div>
  );
}
