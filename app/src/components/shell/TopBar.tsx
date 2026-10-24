"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { AvatarSkeleton } from "@/components/account/Player";
import { Button, CountUp, GemaMark } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { requestDeposit } from "@/lib/deposit/bus";
import { useViewMode } from "@/lib/deposit/use-view-mode";
import { requestGetGemas } from "@/lib/get-gemas";
import { AccountMenu } from "./AccountMenu";
import { PoolChest } from "./PoolChest";
import { Wordmark } from "./Sidebar";

export function TopBar({ onMenu }: { onMenu: () => void }) {
  const { gemas, auth, ready, error } = useAccount();
  const path = usePathname();
  const signedIn = auth.status === "signed-in";
  const signedOut = auth.status === "signed-out";
  const onVault = path === "/vault";
  const simple = useViewMode().mode === "simple";

  return (
    <header className="topbar">
      <button type="button" className="cut icon-btn menu-btn" aria-label="Open menu" onClick={onMenu}>
        <Menu aria-hidden="true" />
      </button>
      <span className="top-word"><Wordmark /></span>
      <div className="top-right">
        <PoolChest />
        {auth.status !== "signed-out" &&
          (ready || (error && auth.status !== "loading") ? (
            <Link
              href="/vault"
              className="cut cut-card gpill"
              aria-label={simple || onVault ? "Your Gemas, buy Gemas" : "Your Gemas, open Vault"}
              title={simple ? "Buy Gemas" : "Simulated yield · 1 month = 10 min"}
              onClick={(e) => {
                if (simple) {
                  e.preventDefault();
                  requestDeposit();
                  return;
                }
                if (!onVault) return;
                e.preventDefault();
                requestGetGemas();
              }}
            >
              <GemaMark size={30} glint />
              <b className="tnum">{ready ? <CountUp value={gemas.total} /> : "—"}</b>
              <span>Gemas</span>
            </Link>
          ) : (
            <div className="cut cut-card gpill skel" role="status" aria-label="Loading your Gemas">
              <div className="gp-mark-skel" />
              <div className="skel-line lg" style={{ width: 88 }} />
            </div>
          ))}
        {signedIn && <AccountMenu />}
        {auth.status === "loading" && (
          <span className="cut cut-btn avatar" aria-hidden="true">
            <AvatarSkeleton />
          </span>
        )}
        {signedOut && (
          <Button onClick={() => auth.openSignIn()}>Sign in</Button>
        )}
      </div>
    </header>
  );
}
