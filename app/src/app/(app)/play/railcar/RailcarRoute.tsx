"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { RailcarScreen } from "@/games/railcar/RailcarScreen";
import { useRailcar } from "@/games/railcar/useRailcar";
import { useAccount } from "@/lib/account";
import type { RailcarView } from "@/games/railcar/view";

/** Before any car exists (or while the first read runs): an empty car to board. Boarding opens one. */
const EMPTY: RailcarView = { phase: "boarding", seated: 0, maxSeats: 100, minSeats: 5, leavesInSec: null, riders: [], mySeat: null, myBacker: null, entry: 500n };

export function RailcarRoute() {
  // `?backing=<offer>`: the Backing page's "Board Railcar" for an accepted Offer.
  const offer = useSearchParams().get("backing");
  const router = useRouter();
  const r = useRailcar(offer);
  const { auth } = useAccount();
  // A used Offer stays on the seat it boarded; the page itself goes back to boarding with the Player's own Gemas.
  useEffect(() => {
    if (offer && r.offerSpent) router.replace("/play/railcar", { scroll: false });
  }, [offer, r.offerSpent, router]);
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
      offer={r.offer}
      watch={r.watch}
      actions={{ onBoard: r.signedIn ? () => void r.board() : undefined, onSignIn: () => auth.openSignIn(), onStepOff: () => void r.stepOff(), onJump: () => void r.jump(), onPlayAgain: r.playAgain, onShare: share }}
    />
  );
}
