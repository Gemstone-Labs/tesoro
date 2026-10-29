"use client";

import { Menu } from "lucide-react";
import { AvatarSkeleton } from "@/components/account/Player";
import { Button, CountUp, GemaMark } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { requestDeposit } from "@/lib/deposit/bus";
import { AccountMenu } from "./AccountMenu";
import { PoolChest } from "./PoolChest";
import { Wordmark } from "./Sidebar";

export function TopBar({ onMenu }: { onMenu: () => void }) {
  const { gemas, auth, ready, error } = useAccount();
  const signedIn = auth.status === "signed-in";
  const signedOut = auth.status === "signed-out";

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
            <button type="button" className="cut cut-card gpill" aria-label="Your Gemas, buy Gemas" title="Buy Gemas" onClick={() => requestDeposit()}>
              <GemaMark size={30} glint />
              <b className="tnum">{ready ? <CountUp value={gemas.total} /> : "—"}</b>
              <span>Gemas</span>
            </button>
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
