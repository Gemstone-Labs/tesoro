"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { RideHistory, type RidePage } from "@/games/railcar/RideHistory";
import { useAccount } from "@/lib/account";
import { fetchRidePage } from "@/lib/chain/history-client";
import { winPath } from "@/lib/win-card";

export function RideRoute({ id }: { id: string }) {
  const router = useRouter();
  const { snapshot } = useAccount();
  // undefined while reading, null when the history has no such ride.
  const [page, setPage] = useState<RidePage | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void fetchRidePage(id).then((p) => live && setPage(p));
    return () => {
      live = false;
    };
  }, [id]);

  if (page === undefined) return <p className="status" role="status">Loading the ride…</p>;
  if (page === null)
    return (
      <div className="mh-state">
        <p>This ride is not in the history yet. A ride appears here once it is paid out.</p>
        <Button size="sm" href="/play/railcar">Play Railcar</Button>
      </div>
    );
  const placed = page.ride?.outcome === "placed";
  const share = () => {
    // A ride with places has a win card (its last Player off); a refunded ride shares this page.
    const url = new URL(placed ? winPath(id) : window.location.pathname, window.location.origin).toString();
    if (navigator.share) void navigator.share({ title: "Railcar", url }).catch(() => undefined);
    else void navigator.clipboard?.writeText(url).catch(() => undefined);
  };
  return <RideHistory page={page} me={snapshot?.accountKey.toBase58() ?? null} actions={{ onPlayAgain: () => router.push("/play/railcar"), onShare: share }} />;
}
