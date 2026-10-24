"use client";

import Link from "next/link";
import { ChevronRight, HandCoins } from "lucide-react";
import { useAccount } from "@/lib/account";
import { useBackingBoard } from "@/lib/chain/useBackingBoard";
import { useNowSecs } from "@/lib/chain/useNowSecs";

/** Mounted only for a signed-in Player; reuse the Backing board's public Request read. */
export function VaultBacking() {
  const { snapshot } = useAccount();
  const { board } = useBackingBoard();
  const now = useNowSecs();
  const me = snapshot?.accountKey.toBase58();
  const count = me ? (board?.requests ?? []).filter((r) => r.player === me && r.live && r.status === "open" && now < r.expiresAt).length : 0;
  if (!count) return null;
  return (
    <Link href="/backing" className="cut cut-card vt-backing">
      <HandCoins aria-hidden="true" />
      <span>Backing · {count} open</span>
      <ChevronRight aria-hidden="true" />
    </Link>
  );
}
