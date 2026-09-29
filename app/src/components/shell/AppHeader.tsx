"use client";

import Link from "next/link";
import { useAccount } from "@/lib/account";
import { GemaAmount, GemaMark } from "@/components/ui";

export function AppHeader() {
  const { gemas, auth, account } = useAccount();
  const signedIn = auth.status === "signed-in";
  const signedOut = auth.status === "signed-out";
  return (
    <header className="app-head">
      <div className="app-head-in">
        <Link href="/" className="wordmark">
          <GemaMark size={18} />
          Tesoro
        </Link>
        <div className="head-actions">
          {!signedOut && (
            <Link href="/wallet" className="cut cut-chip gchip" aria-label="Your Gemas, open Wallet">
              <GemaAmount value={gemas.total} size="md" />
            </Link>
          )}
          {signedIn && (
            <button type="button" className="cut cut-chip account-btn" onClick={auth.openAccount} aria-label="Open Account">
              <span>{account.displayName}</span>
            </button>
          )}
          {signedOut && (
            <button type="button" className="cut cut-chip account-btn" onClick={() => auth.openSignIn()}>
              Sign in
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
