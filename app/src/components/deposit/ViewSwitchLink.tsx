"use client";

import Link from "next/link";
import { useViewMode } from "@/lib/deposit/use-view-mode";
import type { ViewMode } from "@/lib/deposit/view-mode";

const TARGET: Record<ViewMode, string> = { simple: "/vault", advanced: "/wallet" };
const LABEL: Record<ViewMode, string> = { simple: "Simple view", advanced: "Advanced view" };

/** A quiet link that remembers the chosen view and goes to its money page: "Simple view" → Vault, "Advanced view" → Wallet. */
export function ViewSwitchLink({ to, className = "dep-link" }: { to: ViewMode; className?: string }) {
  const { setMode } = useViewMode();
  return (
    <Link href={TARGET[to]} className={className} onClick={() => setMode(to)}>
      {LABEL[to]}
    </Link>
  );
}
