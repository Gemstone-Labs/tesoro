"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { Button, Card } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { requestDeposit } from "@/lib/deposit/bus";
import { readGemasQuery } from "@/lib/deposit/query";
import { useViewMode } from "@/lib/deposit/use-view-mode";
import { requestGetGemas } from "@/lib/get-gemas";
import { WalletView } from "../wallet/WalletView";
import { SimpleVault } from "./SimpleVault";
import { ViewToggle } from "@/components/deposit/ViewToggle";
import { VaultHeader } from "./VaultHeader";
import "./vault.css";

export default function VaultPage() {
  return (
    <Suspense>
      <Vault />
    </Suspense>
  );
}

/** `/vault?deposit=1` or `?open=1` (the Lobby, a game that needs Gemas, old links) opens what the current view uses, then drops the query. */
function useGemasQuery(ready: boolean, simple: boolean) {
  const params = useSearchParams();
  const router = useRouter();
  const { wanted, intent } = readGemasQuery(params);
  const game = intent?.game;
  const need = intent?.need;
  useEffect(() => {
    if (!wanted || !ready) return;
    const from = game ? { game, need: need ?? null } : null;
    if (simple) requestDeposit(from);
    else requestGetGemas(from);
    router.replace("/vault");
  }, [wanted, ready, simple, game, need, router]);
}

function Vault() {
  const { auth } = useAccount();
  const { mode, resolved } = useViewMode();
  const signedIn = auth.status === "signed-in";
  const simple = mode === "simple";
  // Signed out there is no Advanced sheet to open: only the deposit modal can answer the link.
  useGemasQuery(resolved && (signedIn || (auth.status === "signed-out" && simple)), simple);

  if (auth.status === "signed-out") {
    return (
      <Card large as="section" aria-label="Sign in to see your Vault">
        <div className="stack">
          <h1 className="page-title">Vault</h1>
          <p className="meta">Your Gemas, deposits and winnings belong to your Account. Sign in to see them.</p>
          <Button block onClick={() => auth.openSignIn()}>Sign in</Button>
        </div>
      </Card>
    );
  }

  return (
    <>
      <VaultHeader />
      {resolved && (
        <div className="wl">
          <WalletView part="card" />
          <div className="vt-below">
            <ViewToggle />
            {simple ? <SimpleVault /> : <WalletView part="body" />}
          </div>
        </div>
      )}
    </>
  );
}
