"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Menu, Search, X } from "lucide-react";
import { Button, CountUp, GemaMark } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { AccountMenu } from "./AccountMenu";
import { useSearch } from "./SearchContext";
import { Wordmark } from "./Sidebar";

export function TopBar({ onMenu }: { onMenu: () => void }) {
  const { gemas, auth } = useAccount();
  const { query, setQuery } = useSearch();
  const path = usePathname();
  const router = useRouter();
  const signedIn = auth.status === "signed-in";
  const signedOut = auth.status === "signed-out";
  const onLobby = path === "/lobby";

  return (
    <header className={`topbar${onLobby ? " on-lobby" : ""}`}>
      <button type="button" className="cut icon-btn menu-btn" aria-label="Open menu" onClick={onMenu}>
        <Menu aria-hidden="true" />
      </button>
      <span className="top-word"><Wordmark /></span>
      <form
        className="cut cut-card search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (!onLobby) router.push("/lobby");
        }}
      >
        <Search aria-hidden="true" />
        <input
          type="search"
          name="q"
          aria-label="Search games"
          placeholder="Search games"
          autoComplete="off"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!onLobby && e.target.value) router.push("/lobby");
          }}
        />
        {query && (
          <button type="button" className="search-clear" aria-label="Clear search" onClick={() => setQuery("")}>
            <X aria-hidden="true" />
          </button>
        )}
      </form>
      <div className="top-right">
        {auth.status !== "signed-out" && auth.status !== "loading" && (
          <Link href="/wallet" className="cut cut-card gpill" aria-label="Your Gemas, open Wallet" title="Simulated yield · 1 month = 10 min">
            <GemaMark size={30} glint />
            <b className="tnum"><CountUp value={gemas.total} /></b>
            <span>Gemas</span>
          </Link>
        )}
        {signedIn && <AccountMenu />}
        {signedOut && (
          <Button onClick={() => auth.openSignIn()}>Sign in</Button>
        )}
      </div>
    </header>
  );
}
