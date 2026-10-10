"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOC_GROUPS } from "./nav";

/** The Docs table of contents: used by the desktop sidebar and the phone menu. */
export function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname().replace(/\/$/, "") || "/docs";
  return (
    <nav aria-label="Docs" className="docs-nav">
      {DOC_GROUPS.map((g) => (
        <div key={g.id} className="docs-nav-group">
          <p className="docs-nav-label">{g.label}</p>
          <ul>
            {g.pages.map((p) => {
              const here = p.href === path;
              return (
                <li key={p.href}>
                  <Link href={p.href} aria-current={here ? "page" : undefined} className={here ? "here" : undefined} onClick={onNavigate}>
                    {p.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
