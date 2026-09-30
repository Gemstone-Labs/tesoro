"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, CircleHelp, Gamepad2, HandCoins, House, Wallet, type LucideIcon } from "lucide-react";
import { GemaMark } from "@/components/ui";
import { PositionsCard } from "./PositionsCard";

export const NAV: { href: string; label: string; Icon: LucideIcon }[] = [
  { href: "/", label: "Lobby", Icon: House },
  { href: "/play", label: "Play", Icon: Gamepad2 },
  { href: "/backing", label: "Backing", Icon: HandCoins },
  { href: "/wallet", label: "Wallet", Icon: Wallet },
];

export function isHere(path: string, href: string): boolean {
  return href === "/" ? path === "/" : path.startsWith(href);
}

export function Wordmark({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link href="/" className="wordmark" onClick={onNavigate}>
      <GemaMark size={34} />
      Tesoro
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
        <span className="cut cut-chip fair">Fair play · on-chain</span>
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
        <span className="cut cut-card side-link soon" aria-disabled="true" title="Coming soon">
          <BookOpen aria-hidden="true" />
          Docs
        </span>
        <span className="cut cut-card side-link soon" aria-disabled="true" title="Coming soon">
          <CircleHelp aria-hidden="true" />
          Help
        </span>
      </div>
      {!path.startsWith("/wallet") && <PositionsCard onNavigate={onNavigate} />}
    </>
  );
}
