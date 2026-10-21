"use client";

import { Button } from "@/components/ui";
import { requestDeposit, type DepositIntent } from "@/lib/deposit/bus";
import { useViewMode } from "@/lib/deposit/use-view-mode";
import { getGemasHref } from "@/lib/deposit/view-mode";

/** "Get Gemas" in the Player's view: the deposit modal in Simple, today's Wallet sheet in Advanced. */
export function GetGemasButton({ intent }: { intent?: DepositIntent }) {
  const { mode } = useViewMode();
  if (mode === "simple") {
    return (
      <Button variant="money" onClick={() => requestDeposit(intent)}>
        Get Gemas
      </Button>
    );
  }
  return (
    <Button variant="money" href={getGemasHref("advanced", intent)}>
      Get Gemas
    </Button>
  );
}
