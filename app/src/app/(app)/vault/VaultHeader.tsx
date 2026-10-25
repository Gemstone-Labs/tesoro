"use client";

import { Button } from "@/components/ui";
import { POST_REQUEST_HREF } from "@/lib/backing/post-link";
import { requestDeposit } from "@/lib/deposit/bus";
import { useViewMode } from "@/lib/deposit/use-view-mode";
import { requestGetGemas } from "@/lib/get-gemas";

/** Buy Gemas first, then Borrow Gemas (a Backing Request), wherever the layout places them. */
export function VaultActions({ mobile = false }: { mobile?: boolean }) {
  const { mode } = useViewMode();
  return (
    <div className={`vt-head-actions${mobile ? " vt-mobile-actions" : ""}`}>
      <Button variant="money" size="lg" onClick={() => (mode === "simple" ? requestDeposit() : requestGetGemas())}>Buy Gemas</Button>
      <Button size="lg" href={POST_REQUEST_HREF}>Borrow Gemas</Button>
    </div>
  );
}

export function VaultHeader() {
  return (
    <header className="vt-head">
      <h1 className="page-title title-desk">Vault</h1>
      <VaultActions />
    </header>
  );
}
