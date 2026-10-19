"use client";

import Image from "next/image";
import { useMemo } from "react";
import { Button, SkeletonCards } from "@/components/ui";
import { CheckIcon, MinusIcon, XIcon } from "@/components/ui/icons";
import { GemasLabel } from "@/app/(app)/wallet/AdvanceQuote";
import { useAccount } from "@/lib/account";
import { art } from "@/lib/art";
import { accountHistory } from "@/lib/chain/history";
import { playAgainRows, playAgainTarget } from "@/lib/chain/lobby-plays";
import { GAME_NAMES } from "@/lib/mock";
import { Rail } from "./Rail";

const RESULT = {
  won: { word: "Won", Icon: CheckIcon },
  lost: { word: "Lost", Icon: XIcon },
  draw: { word: "Draw", Icon: MinusIcon },
  refunded: { word: "Refunded", Icon: MinusIcon },
} as const;

/** PLAY AGAIN: the last few finished Matches, each one tap from being played again. Signed in with at least one settled Match only. */
export function PlayAgainRail() {
  const { auth, snapshot } = useAccount();
  const rows = useMemo(() => (snapshot?.matchesLoaded ? playAgainRows(accountHistory(snapshot.matches, snapshot.funded)) : []), [snapshot]);
  if (auth.status !== "signed-in") return null;

  if (!snapshot?.matchesLoaded) {
    return (
      <Rail id="play-again" title="Play again" cols={3} className="again-rail">
        <SkeletonCards count={1} label="Loading your last Matches" avatar={false} />
      </Rail>
    );
  }
  if (rows.length === 0) return null;

  return (
    <Rail id="play-again" title="Play again" cols={3} className="again-rail">
      {rows.map((r) => {
        const { word, Icon } = RESULT[r.result];
        const target = playAgainTarget(r);
        return (
          <div key={r.id} className="cut cut-card again">
            <span className="cut again-art" aria-hidden="true">
              <Image src={art.hero[r.game]} alt="" fill sizes="96px" />
            </span>
            <span className="again-text">
              <strong>{GAME_NAMES[r.game]}</strong>
              <span className={`again-result ${r.result}`}>
                <Icon aria-hidden="true" />
                {word}
              </span>
              <small>{target.sameOpponent ? "Same opponent" : "New opponent"}</small>
            </span>
            <Button variant="money" size="sm" href={target.href}>
              <GemasLabel action="Play again" gemas={r.entry} />
            </Button>
          </div>
        );
      })}
    </Rail>
  );
}
