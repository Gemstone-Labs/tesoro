"use client";

import { useViewMode } from "@/lib/deposit/use-view-mode";
import type { ViewMode } from "@/lib/deposit/view-mode";

const LABEL: Record<ViewMode, string> = { simple: "Simple view", advanced: "Pro view" };

/** A quiet in-text link that switches the Vault to the other view in place. */
export function ViewSwitchLink({ to, className = "dep-link" }: { to: ViewMode; className?: string }) {
  const { setMode } = useViewMode();
  return (
    <button type="button" className={className} onClick={() => setMode(to)}>
      {LABEL[to]}
    </button>
  );
}
