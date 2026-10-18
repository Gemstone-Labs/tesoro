"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { EditProfileSheet } from "@/components/account/EditProfileSheet";
import { GuideOverlay, GuideProvider } from "@/components/guide/Guide";
import { SearchProvider } from "./SearchContext";
import { NAV, SidebarBody, isHere } from "./Sidebar";
import { SiteFooter } from "./SiteFooter";
import { TopBar } from "./TopBar";

/** Screens that exist for one action (play, queue, challenge, a Match, an opening Position): no link directory under them. */
function bareScreen(path: string | null) {
  return !!path && (path.startsWith("/play/") || path === "/wallet/opening");
}

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

        <div className="content" data-bare={bareScreen(path) || undefined}>
          <TopBar onMenu={() => setDrawer(true)} />
          <main className="app-main" key={path}>{children}</main>
          {!bareScreen(path) && <SiteFooter />}
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
        <GuideOverlay />
        <EditProfileSheet />
      </div>
      </GuideProvider>
    </SearchProvider>
  );
}
