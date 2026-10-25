"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import { BookOpen, ChevronRight, CircleHelp, FileText, Gamepad2, HandCoins, LogOut, Shield, Swords, Trophy, Users, Wallet, type LucideIcon } from "lucide-react";
import { AvatarSkeleton, PlayerAvatar, PlayerName } from "@/components/account/Player";
import { TesoroLogo } from "@/components/brand";
import { useAccount } from "@/lib/account";
import { accountKeyOf } from "@/lib/chain/account-key";
import { BRAND } from "@/lib/brand";
import { useFriends } from "@/lib/friends/FriendsProvider";

type NavItem = { href: string; label: string; Icon: LucideIcon };
const PLAY: NavItem = { href: "/play", label: "Play", Icon: Gamepad2 };
const MATCHES: NavItem = { href: "/matches", label: "Matches", Icon: Swords };
const FRIENDS: NavItem = { href: "/friends", label: "Friends", Icon: Users };
const BACKING: NavItem = { href: "/backing", label: "Backing", Icon: HandCoins };
const BOARD: NavItem = { href: "/leaderboard", label: "Leaderboard", Icon: Trophy };
const VAULT: NavItem = { href: "/vault", label: "Vault", Icon: Wallet };

/** The phone bottom nav: Play in the centre. Backing has no tab: it is in the drawer and on the Vault. */
export const NAV: NavItem[] = [MATCHES, FRIENDS, PLAY, BOARD, VAULT];

/** The sidebar, in labelled groups. */
const GROUPS: { title: string; items: NavItem[] }[] = [
  { title: "Play", items: [PLAY, MATCHES, FRIENDS] },
  { title: "Money", items: [VAULT, BACKING] },
  { title: "Season", items: [BOARD] },
];

/** The nav lists: one money item, the Vault, in both views. */
export function useNavItems(): { nav: NavItem[]; groups: typeof GROUPS } {
  return { nav: NAV, groups: GROUPS };
}

export function isHere(path: string, href: string): boolean {
  // /wallet/opening is part of the Vault: the nav keeps the Vault lit there.
  return path.startsWith(href) || (href === "/vault" && path.startsWith("/wallet"));
}

export function Wordmark({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link href="/play" className="wordmark" aria-label={`${BRAND.name}, home`} onClick={onNavigate}>
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

/**
 * The sidebar content, for the fixed desktop sidebar. With `drawer` (phones and tablets, beside the bottom nav) it leaves out
 * what the bottom nav already has and adds what the footer carries on desktop.
 */
export function SidebarBody({ onNavigate, drawer = false }: { onNavigate?: () => void; drawer?: boolean }) {
  const path = usePathname();
  const { auth, snapshot, openMatches } = useAccount();
  const me = useMemo(
    () => (auth.status !== "signed-in" ? null : (snapshot?.accountKey.toBase58() ?? (auth.addresses.solana ? accountKeyOf(auth.addresses.solana) : null))),
    [auth.status, snapshot, auth.addresses.solana],
  );
  const { groups } = useNavItems();
  const count = <OpenCount n={openMatches.length} lit={openMatches.some((m) => m.status === "active")} />;
  const friendsBadge = useFriends().view?.badge ?? 0;
  const friendCount = friendsBadge > 0 && (
    <span className="side-count lit" aria-label={`${friendsBadge} waiting for you`}>
      {friendsBadge}
    </span>
  );
  const profile = me ? `/account/${me}` : null;

  return (
    <>
      <div className="side-top">
        <Wordmark onNavigate={onNavigate} />
      </div>
      {drawer ? (
        <nav aria-label="More" className="side-nav">
          <SideLink item={BACKING} path={path} onNavigate={onNavigate} />
        </nav>
      ) : (
      <nav aria-label="Main" className="side-groups">
        {groups.map((g) => (
          <div key={g.title} className="side-nav">
            <h3 className="side-group-h">{g.title}</h3>
            {g.items.map((item) => (
              <SideLink key={item.href} item={item} path={path} onNavigate={onNavigate} after={item === MATCHES ? count : item === FRIENDS ? friendCount : null} />
            ))}
          </div>
        ))}
      </nav>
      )}
      <hr className="side-rule" />
      <div className="side-nav side-lower">
        <SideLink item={{ href: "/docs", label: "Docs", Icon: BookOpen }} path={path} onNavigate={onNavigate} />
        <SideLink item={{ href: "/help", label: "Help", Icon: CircleHelp }} path={path} onNavigate={onNavigate} />
        {drawer && (
          <>
            <SideLink item={{ href: "/terms", label: "Terms", Icon: FileText }} path={path} onNavigate={onNavigate} />
            <SideLink item={{ href: "/privacy", label: "Privacy", Icon: Shield }} path={path} onNavigate={onNavigate} />
          </>
        )}
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
      {drawer && auth.status === "signed-in" && (
        <button
          type="button"
          className="cut cut-card side-link side-signout"
          onClick={() => {
            onNavigate?.();
            void auth.signOut();
          }}
        >
          <LogOut aria-hidden="true" />
          <span className="side-label">Sign out</span>
        </button>
      )}
    </>
  );
}
