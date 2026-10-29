"use client";

import { Button } from "@/components/ui";
import { requestDeposit, type DepositIntent } from "@/lib/deposit/bus";
/** "Buy Gemas": opens the one Buy Gemas sheet, in the Player's view. */
export function GetGemasButton({ intent }: { intent?: DepositIntent }) {
  return (
    <Button variant="money" onClick={() => requestDeposit(intent)}>
      Buy Gemas
    </Button>
  );
}
