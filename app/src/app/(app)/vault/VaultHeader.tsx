"use client";

import { Button } from "@/components/ui";
import { POST_REQUEST_HREF } from "@/lib/backing/post-link";
import { requestDeposit } from "@/lib/deposit/bus";
import { useViewMode } from "@/lib/deposit/use-view-mode";
import { requestGetGemas } from "@/lib/get-gemas";

/** The same header in both views: title and rate on the left; Borrow Gemas (a Backing Request) and Buy Gemas on the right. */
export function VaultHeader() {
  const { mode } = useViewMode();
  return (
    <header className="page-head vt-head">
      <div>
        <h1 className="page-title">Vault</h1>
        <p className="page-sub">1 Gema = $0.01</p>
      </div>
      <div className="vt-head-actions">
        <Button size="lg" href={POST_REQUEST_HREF}>Borrow Gemas</Button>
        <Button variant="money" size="lg" onClick={() => (mode === "simple" ? requestDeposit() : requestGetGemas())}>Buy Gemas</Button>
      </div>
    </header>
  );
}
