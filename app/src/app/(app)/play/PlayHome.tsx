"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { ContinueRail, ContinueSkeleton } from "@/components/lobby/ContinueRail";
import { continueMotion, continuePlaceholder, readHadContinue, writeHadContinue } from "@/components/lobby/continue-memory";
import { GameGrid } from "@/components/lobby/GameGrid";
import { LiveWins } from "@/components/lobby/LiveWins";
import { useAccount } from "@/lib/account";
import { accountKeyOf } from "@/lib/chain/account-key";
import { useFriends } from "@/lib/friends/FriendsProvider";
import "@/components/lobby/play-home.css";

const subscribeNothing = () => () => {};

/**
 * Play is home: what's open for you, recent wins, then every Game. A Game's tile opens its page (entry, Play now).
 * Continue shows nothing while it loads, so a Player with nothing open never sees a placeholder come and go. A Player whose last
 * read found something open sees a same-height placeholder, since the row is likely to come back; it folds away if it doesn't.
 */
export function PlayHome() {
  const { openMatches, auth, snapshot, error } = useAccount();
  const friends = useFriends();
  const friendChallenges = friends.view?.challenges ?? [];
  const items = openMatches.length > 0 || friendChallenges.length > 0;
  const signedIn = auth.status === "signed-in";
  const pending = auth.status === "loading" || (signedIn && ((!snapshot?.matchesLoaded && !error) || friends.status === "loading" || friends.status === "locked"));
  const wallet = auth.addresses?.solana;
  const account = signedIn && wallet ? accountKeyOf(wallet) : null;
  const likely = useSyncExternalStore(subscribeNothing, () => readHadContinue(account), () => false);
  const placeholder = continuePlaceholder({ items, pending, signedIn, likely });

  const [seen, setSeen] = useState({ items, placeholder });
  const [motion, setMotion] = useState<"none" | "reveal" | "collapse">("none");
  if (seen.items !== items || seen.placeholder !== placeholder) {
    setSeen({ items, placeholder });
    setMotion(continueMotion(seen, { items, placeholder }));
  }

  // Remember what the last finished read found.
  useEffect(() => {
    if (account && !pending) writeHadContinue(account, items);
  }, [account, pending, items]);

  const slot = items ? (
    <div className={`continue-slot${motion === "reveal" ? " reveal" : ""}`}>
      <ContinueRail matches={openMatches} challenges={friendChallenges} />
    </div>
  ) : placeholder ? (
    <div className="continue-slot">
      <ContinueSkeleton />
    </div>
  ) : motion === "collapse" ? (
    <div className="continue-slot collapse" onAnimationEnd={() => setMotion("none")}>
      <ContinueSkeleton />
    </div>
  ) : null;

  return (
    <div className="play-home">
      {slot}
      <LiveWins />
      <GameGrid />
    </div>
  );
}
