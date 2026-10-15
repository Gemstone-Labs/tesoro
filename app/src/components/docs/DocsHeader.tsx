"use client";

import { Menu, Moon, Search, Sun, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { TesoroLogo } from "@/components/brand";
import { THEME_KEY, type Theme } from "@/components/landing/theme";
import { useTheme } from "@/components/landing/useTheme";
import { NavList } from "./NavList";
import { ALL_PAGES } from "./nav";
import { BRAND } from "@/lib/brand";

export function DocsHeader() {
  const theme = useTheme();
  const router = useRouter();
  const [menu, setMenu] = useState(false);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return ALL_PAGES.filter((p) => {
      const hay = `${p.title} ${p.summary} ${p.keywords ?? ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    }).slice(0, 6);
  }, [q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === "/" && !(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    document.body.style.overflow = menu ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [menu]);

  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {}
  };

  const go = (href: string) => {
    setQ("");
    setOpen(false);
    router.push(href);
  };

  return (
    <header className="docs-top">
      <div className="docs-top-in">
        <button type="button" className="icon-btn cut docs-menu-btn" aria-expanded={menu} aria-controls="docs-menu" onClick={() => setMenu((m) => !m)} aria-label={menu ? "Close menu" : "Open menu"}>
          {menu ? <X aria-hidden /> : <Menu aria-hidden />}
        </button>
        <Link href="/" className="docs-logo" aria-label={`${BRAND.name}, home`}>
          <TesoroLogo height={28} tone="dark" className="on-dark" />
          <TesoroLogo height={28} tone="light" className="on-light" />
        </Link>
        <Link href="/docs" className="docs-badge mono">
          Docs
        </Link>
        <div className="docs-search">
          <Search aria-hidden />
          <input
            ref={input}
            type="search"
            value={q}
            placeholder="Search docs"
            aria-label="Search the docs"
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 120)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && results[0]) go(results[0].href);
              if (e.key === "Escape") {
                setQ("");
                e.currentTarget.blur();
              }
            }}
          />
          <kbd aria-hidden>/</kbd>
          {open && q.trim() && (
            <ul className="docs-results cut cut-card" role="listbox">
              {results.length ? (
                results.map((r) => (
                  <li key={r.href} role="option" aria-selected={false}>
                    <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => go(r.href)}>
                      <b>{r.title}</b>
                      <span>{r.summary}</span>
                    </button>
                  </li>
                ))
              ) : (
                <li className="none">No page matches &ldquo;{q}&rdquo;.</li>
              )}
            </ul>
          )}
        </div>
        <button type="button" className="icon-btn cut" onClick={toggleTheme} aria-pressed={theme === "light"} aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}>
          {theme === "dark" ? <Sun aria-hidden /> : <Moon aria-hidden />}
        </button>
        <Link className="btn neutral cut cut-btn docs-launch" href="/lobby">
          Launch app
        </Link>
      </div>
      {menu && (
        <div id="docs-menu" className="docs-menu">
          <NavList onNavigate={() => setMenu(false)} />
        </div>
      )}
    </header>
  );
}
