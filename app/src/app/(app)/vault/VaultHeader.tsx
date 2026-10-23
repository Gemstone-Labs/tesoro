"use client";

import { Button } from "@/components/ui";
import { POST_REQUEST_HREF } from "@/lib/backing/post-link";
import { requestDeposit } from "@/lib/deposit/bus";
import { useViewMode } from "@/lib/deposit/use-view-mode";
import { requestGetGemas } from "@/lib/get-gemas";

/** The same header in both views, with no visible title: Buy Gemas first, then Borrow Gemas (a Backing Request). */
export function VaultHeader() {
  const { mode } = useViewMode();
  return (
    <header className="vt-head">
      <h1 className="sr-only">Vault</h1>
      <div className="vt-head-actions">
        <Button variant="money" size="lg" onClick={() => (mode === "simple" ? requestDeposit() : requestGetGemas())}>Buy Gemas</Button>
        <Button size="lg" href={POST_REQUEST_HREF}>Borrow Gemas</Button>
      </div>
    </header>
  );
}
