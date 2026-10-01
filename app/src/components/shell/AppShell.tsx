"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { GuideCorner, GuideProvider } from "@/components/guide/Guide";
import { SearchProvider } from "./SearchContext";
import { NAV, SidebarBody, isHere } from "./Sidebar";
import { SiteFooter } from "./SiteFooter";
import { TopBar } from "./TopBar";

/** Desktop: fixed sidebar + top bar. Below 1024px: the sidebar becomes a drawer and a bottom nav appears. */
export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const [drawer, setDrawer] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (drawer && !d.open) d.showModal();
    if (!drawer && d.open) d.close();
  }, [drawer]);

  return (
    <SearchProvider>
      <GuideProvider>
      <div className="shell">
        <aside className="sidebar" aria-label="Sidebar">
          <SidebarBody />
          <GuideCorner dock="side" />
        </aside>

        <dialog
          ref={ref}
          className="drawer"
          aria-label="Menu"
          onClose={() => setDrawer(false)}
          onClick={(e) => {
            if (e.target === e.currentTarget) setDrawer(false);
          }}
        >
          <div className="drawer-in">
            <button type="button" className="cut icon-btn drawer-x" aria-label="Close menu" onClick={() => setDrawer(false)}>
              <X aria-hidden="true" />
            </button>
            <SidebarBody onNavigate={() => setDrawer(false)} />
          </div>
        </dialog>

        <div className="content">
          <TopBar onMenu={() => setDrawer(true)} />
          <main className="app-main">{children}</main>
          <SiteFooter />
        </div>

        <nav className="bottom-nav" aria-label="Main">
          {NAV.map(({ href, label, Icon }) => {
            const here = isHere(path, href);
            return (
              <Link key={href} href={href} aria-current={here ? "page" : undefined}>
                <Icon aria-hidden="true" />
                {label}
              </Link>
            );
          })}
        </nav>
        <GuideCorner dock="nav" />
      </div>
      </GuideProvider>
    </SearchProvider>
  );
}
