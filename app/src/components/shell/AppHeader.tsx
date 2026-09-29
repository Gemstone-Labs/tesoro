"use client";

import Link from "next/link";
import { useAccount } from "@/lib/account";
import { GemaAmount, GemaMark } from "@/components/ui";

export function AppHeader() {
  const { gemas } = useAccount();
  return (
    <header className="app-head">
      <div className="app-head-in">
        <Link href="/" className="wordmark">
          <GemaMark size={18} />
          Tesoro
        </Link>
        <Link href="/wallet" className="cut cut-chip gchip" aria-label="Your Gemas, open Wallet">
          <GemaAmount value={gemas.total} size="md" />
        </Link>
      </div>
    </header>
  );
}
