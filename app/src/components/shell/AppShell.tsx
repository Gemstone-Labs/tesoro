"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { EditProfileSheet } from "@/components/account/EditProfileSheet";
import { LimitsSheet } from "@/components/account/LimitsSheet";
import { GuideBanner, GuideOverlay, GuideProvider } from "@/components/guide/Guide";
import { SidebarBody, isHere, useNavItems } from "./Sidebar";
import { DepositHost } from "@/components/deposit/DepositSheet";
import { SiteFooter } from "./SiteFooter";
import { TopBar } from "./TopBar";
import { useAccount } from "@/lib/account";
import { useFriends } from "@/lib/friends/FriendsProvider";
import { useShellPress } from "./useShellPress";

/** Screens that exist for one action (play, queue, challenge, a Match, an opening Position): no link directory under them. */
function bareScreen(path: string | null) {
  return !!path && (/^\/play\/(practice|queue|challenge|match)(\/|$)/.test(path) || path === "/wallet/opening");
}

/**
 * Desktop: fixed sidebar + top bar + footer. Below 1024px: a bottom nav with Play in the centre, a drawer for what the
 * nav leaves out, and no footer.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const onPointerDownCapture = useShellPress();
  const [drawer, setDrawer] = useState(false);
  const { nav } = useNavItems();
  const { openMatches } = useAccount();
  const friendsWaiting = useFriends().view?.badge ?? 0;
  const badge: Record<string, { n: number; lit: boolean; label: string } | undefined> = {
    "/matches": openMatches.length ? { n: openMatches.length, lit: openMatches.some((m) => m.status === "active"), label: "open" } : undefined,
    "/friends": friendsWaiting ? { n: friendsWaiting, lit: true, label: "waiting for you" } : undefined,
  };
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (drawer && !d.open) d.showModal();
    if (!drawer && d.open) d.close();
  }, [drawer]);

  return (
      <GuideProvider>
      <div className="shell" onPointerDownCapture={onPointerDownCapture}>
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
            <SidebarBody drawer onNavigate={() => setDrawer(false)} />
          </div>
        </dialog>

        <div className="content" data-bare={bareScreen(path) || undefined}>
          <TopBar onMenu={() => setDrawer(true)} />
          <main className="app-main" key={path}>
            <GuideBanner />
            {children}
          </main>
          {!bareScreen(path) && <SiteFooter />}
        </div>

        <nav className="bottom-nav" aria-label="Main">
          {nav.map(({ href, label, Icon }) => {
            const here = isHere(path, href);
            const b = badge[href];
            return (
              <Link
                key={href}
                href={href}
                aria-current={here ? "page" : undefined}
                aria-label={b ? `${label}, ${b.n} ${b.label}` : undefined}
              >
                <span className="nav-icon">
                  <Icon key={here ? "active" : "idle"} aria-hidden="true" />
                  {b && <b key={b.n} className={`nav-badge${b.lit ? " lit" : ""}`} aria-hidden="true">{b.n}</b>}
                </span>
                {label}
              </Link>
            );
          })}
        </nav>
        <GuideOverlay />
        <EditProfileSheet />
        <DepositHost />
        <LimitsSheet />
      </div>
      </GuideProvider>
  );
}
