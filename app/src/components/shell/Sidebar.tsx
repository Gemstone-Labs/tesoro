"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, CircleHelp, Gamepad2, HandCoins, House, Trophy, Wallet, type LucideIcon } from "lucide-react";
import { TesoroLogo } from "@/components/brand";

export const NAV: { href: string; label: string; Icon: LucideIcon }[] = [
  { href: "/lobby", label: "Lobby", Icon: House },
  { href: "/play", label: "Play", Icon: Gamepad2 },
  { href: "/backing", label: "Backing", Icon: HandCoins },
  { href: "/leaderboard", label: "Leaderboard", Icon: Trophy },
  { href: "/wallet", label: "Wallet", Icon: Wallet },
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

/** The sidebar content: shared by the fixed desktop sidebar and the mobile/tablet drawer. */
export function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname();
  return (
    <>
      <div className="side-top">
        <Wordmark onNavigate={onNavigate} />
      </div>
      <nav aria-label="Main" className="side-nav">
        {NAV.map(({ href, label, Icon }) => {
          const here = isHere(path, href);
          return (
            <Link key={href} href={href} className={`cut cut-card side-link${here ? " here" : ""}`} aria-current={here ? "page" : undefined} onClick={onNavigate}>
              <Icon aria-hidden="true" />
              {label}
            </Link>
          );
        })}
      </nav>
      <hr className="side-rule" />
      <div className="side-nav docs">
        <Link href="/docs" className="cut cut-card side-link" onClick={onNavigate}>
          <BookOpen aria-hidden="true" />
          Docs
        </Link>
        <Link href="/help" className={`cut cut-card side-link${isHere(path, "/help") ? " here" : ""}`} aria-current={isHere(path, "/help") ? "page" : undefined} onClick={onNavigate}>
          <CircleHelp aria-hidden="true" />
          Help
        </Link>
      </div>
    </>
  );
}
