"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "Lobby" },
  { href: "/play", label: "Play" },
  { href: "/wallet", label: "Wallet" },
] as const;

export function BottomNav() {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Main">
      <div className="nav-in">
        {ITEMS.map(({ href, label }) => {
          const here = href === "/" ? path === "/" : path.startsWith(href);
          return (
            <Link key={href} href={href} aria-current={here ? "page" : undefined}>
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
