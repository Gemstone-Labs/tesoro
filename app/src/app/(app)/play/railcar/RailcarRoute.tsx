"use client";

import { RailcarScreen } from "@/games/railcar/RailcarScreen";
import { useRailcar } from "@/games/railcar/useRailcar";
import type { RailcarView } from "@/games/railcar/view";

/** Before any car exists (or while the first read runs): an empty car to board. Boarding opens one. */
const EMPTY: RailcarView = { phase: "boarding", seated: 0, maxSeats: 100, minSeats: 5, leavesInSec: null, riders: [], mySeat: null, entry: 500n };

export function RailcarRoute() {
  const r = useRailcar();
  const share = () => {
    const url = window.location.href;
    if (navigator.share) void navigator.share({ title: "Railcar", url }).catch(() => undefined);
    else void navigator.clipboard?.writeText(url).catch(() => undefined);
  };
  return (
    <RailcarScreen
      view={r.view ?? EMPTY}
      busy={r.busy}
      error={r.error}
      brake={r.brake}
      actions={{ onBoard: r.signedIn ? () => void r.board() : undefined, onStepOff: () => void r.stepOff(), onJump: () => void r.jump(), onPlayAgain: r.playAgain, onShare: share }}
    />
  );
}
