"use client";

import { useEffect, useState, type ReactNode } from "react";
import { BookOpen } from "lucide-react";
import type { GameMenuItem } from "@/games/fx/GameActions";
import type { GuideGame } from "@/lib/how-to-play";
import { markFirstPracticeGuideShown, shouldShowFirstPracticeGuide } from "@/lib/how-to-play-seen";
import { HowToPlay } from "./HowToPlay";

/**
 * Holds a Practice Game back until the guide has been seen once on this device. While the guide is open the Game is not
 * mounted, so no countdown or clock runs; closing it (Start practice, Esc, the close button) mounts the Game as usual.
 */
export function FirstPracticeGuide({ game, children }: { game: GuideGame; children: ReactNode }) {
  const [phase, setPhase] = useState<"checking" | "guide" | "play">("checking");
  useEffect(() => {
    // After mount: storage does not exist on the server, so the first render must not read it.
    const id = setTimeout(() => {
      if (shouldShowFirstPracticeGuide(game)) {
        markFirstPracticeGuideShown(game);
        setPhase("guide");
      } else setPhase("play");
    }, 0);
    return () => clearTimeout(id);
  }, [game]);
  return (
    <>
      <HowToPlay game={game} open={phase === "guide"} end="first-practice" onClose={() => setPhase("play")} />
      {phase === "play" && children}
    </>
  );
}

/**
 * The "How to play" item of a Practice pause card and the dialog it opens. The Game stays paused underneath; closing the
 * guide returns to the pause card. Render `dialog` anywhere in the Game; add `item` to the pause card's items.
 */
export function usePracticeHowTo(game: GuideGame): { item: GameMenuItem; dialog: ReactNode } {
  const [open, setOpen] = useState(false);
  return {
    item: { label: "How to play", icon: <BookOpen aria-hidden="true" />, onSelect: () => setOpen(true) },
    dialog: <HowToPlay game={game} open={open} onClose={() => setOpen(false)} end="practice-menu" />,
  };
}
