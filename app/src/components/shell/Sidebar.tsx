"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import { BookOpen, ChevronRight, CircleHelp, Gamepad2, HandCoins, House, Swords, Trophy, Wallet, type LucideIcon } from "lucide-react";
import { AvatarSkeleton, PlayerAvatar, PlayerName } from "@/components/account/Player";
import { TesoroLogo } from "@/components/brand";
import { useAccount } from "@/lib/account";
import { accountKeyOf } from "@/lib/chain/account-key";

type NavItem = { href: string; label: string; Icon: LucideIcon };
const LOBBY: NavItem = { href: "/lobby", label: "Lobby", Icon: House };
const PLAY: NavItem = { href: "/play", label: "Play", Icon: Gamepad2 };
const MATCHES: NavItem = { href: "/matches", label: "Matches", Icon: Swords };
const BACKING: NavItem = { href: "/backing", label: "Backing", Icon: HandCoins };
const BOARD: NavItem = { href: "/leaderboard", label: "Leaderboard", Icon: Trophy };
const WALLET: NavItem = { href: "/wallet", label: "Wallet", Icon: Wallet };

/** The phone bottom nav. */
export const NAV: NavItem[] = [LOBBY, PLAY, BACKING, BOARD, WALLET];

/** The sidebar, in labelled groups. */
const GROUPS: { title: string; items: NavItem[] }[] = [
  { title: "Play", items: [LOBBY, PLAY, MATCHES] },
  { title: "Money", items: [BACKING, WALLET] },
  { title: "Season", items: [BOARD] },
];

export function isHere(path: string, href: string): boolean {
  return path.startsWith(href);
}

export function Wordmark({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link href="/lobby" className="wordmark" aria-label="Tesoro, home" onClick={onNavigate}>
      <TesoroLogo height={34} />
    </Link>
  );
}

/** Open Matches; lit when one has an opponent found. Neutral: navigation is never emerald. */
function OpenCount({ n, lit }: { n: number; lit: boolean }) {
  if (!n) return null;
  return (
    <span className={`side-count${lit ? " lit" : ""}`} aria-label={lit ? `${n} open, opponent found` : `${n} open`}>
      {lit && <i aria-hidden="true" />}
      {n}
    </span>
  );
}

function SideLink({ item, path, onNavigate, after }: { item: NavItem; path: string; onNavigate?: () => void; after?: React.ReactNode }) {
  const here = isHere(path, item.href);
  return (
    <Link href={item.href} className={`cut cut-card side-link${here ? " here" : ""}`} aria-current={here ? "page" : undefined} onClick={onNavigate}>
      <item.Icon aria-hidden="true" />
      <span className="side-label">{item.label}</span>
      {after}
    </Link>
  );
}

/** The sidebar content: shared by the fixed desktop sidebar and the mobile/tablet drawer. */
export function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname();
  const { auth, snapshot, openMatches } = useAccount();
  const me = useMemo(
    () => (auth.status !== "signed-in" ? null : (snapshot?.accountKey.toBase58() ?? (auth.addresses.solana ? accountKeyOf(auth.addresses.solana) : null))),
    [auth.status, snapshot, auth.addresses.solana],
  );
  const count = <OpenCount n={openMatches.length} lit={openMatches.some((m) => m.status === "active")} />;
  const profile = me ? `/account/${me}` : null;

  return (
    <>
      <div className="side-top">
        <Wordmark onNavigate={onNavigate} />
      </div>
      <nav aria-label="Main" className="side-groups">
        {GROUPS.map((g) => (
          <div key={g.title} className="side-nav">
            <h3 className="side-group-h">{g.title}</h3>
            {g.items.map((item) => (
              <SideLink key={item.href} item={item} path={path} onNavigate={onNavigate} after={item === MATCHES && count} />
            ))}
          </div>
        ))}
      </nav>
      <hr className="side-rule" />
      <div className="side-nav side-lower">
        <SideLink item={{ href: "/docs", label: "Docs", Icon: BookOpen }} path={path} onNavigate={onNavigate} />
        <SideLink item={{ href: "/help", label: "Help", Icon: CircleHelp }} path={path} onNavigate={onNavigate} />
      </div>
      {me && profile ? (
        <Link
          href={profile}
          className={`cut cut-card side-profile${isHere(path, profile) ? " here" : ""}`}
          aria-current={isHere(path, profile) ? "page" : undefined}
          onClick={onNavigate}
        >
          <span className="cut side-avatar">
            <PlayerAvatar account={me} size={40} wait />
          </span>
          <span className="side-profile-body">
            <PlayerName account={me} className="side-profile-name" wait />
            <span className="side-profile-sub">Your profile</span>
          </span>
          <ChevronRight aria-hidden="true" />
        </Link>
      ) : (
        (auth.status === "loading" || auth.status === "signed-in") && (
          <div className="cut cut-card side-profile skel" aria-hidden="true">
            <span className="cut side-avatar">
              <AvatarSkeleton />
            </span>
            <span className="side-profile-body">
              <span className="skel-line lg" style={{ width: "62%" }} />
              <span className="skel-line" style={{ width: "44%" }} />
            </span>
          </div>
        )
      )}
    </>
  );
}
