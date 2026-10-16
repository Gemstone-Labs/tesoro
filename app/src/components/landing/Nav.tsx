"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { TesoroLogo, XFollow } from "@/components/brand";
import { appHref } from "@/lib/landing/config";
import { THEME_KEY, type Theme } from "./theme";
import { useTheme } from "./useTheme";

const LINKS = [
  ["How it works", "#how-it-works"],
  ["Games", "#games"],
  ["Backing", "#backing"],
  ["Studios", "#studios"],
] as const;


export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const theme = useTheme();

  useEffect(() => {
    const onScroll = () => setScrolled(scrollY > 24);
    onScroll();
    addEventListener("scroll", onScroll, { passive: true });
    return () => removeEventListener("scroll", onScroll);
  }, []);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {}
  };

  return (
    <header className="lp-nav" data-scrolled={scrolled}>
      <div className="lp-nav-in">
        <a href="#top" className="lp-logo" aria-label="Tesoro, back to top">
          <TesoroLogo height={30} tone="dark" className="on-dark" />
          <TesoroLogo height={30} tone="light" className="on-light" />
        </a>
        <nav className="lp-links cut" aria-label="Sections">
          {LINKS.map(([label, href]) => (
            <a key={href} href={href}>
              {label}
            </a>
          ))}
          <a href="/docs">Docs</a>
        </nav>
        <XFollow place="head" className="lp-x" />
        <button
          type="button"
          className="icon-btn cut lp-theme"
          onClick={toggle}
          aria-pressed={theme === "light"}
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        >
          {theme === "dark" ? <Sun aria-hidden /> : <Moon aria-hidden />}
        </button>
        <a className="btn money cut cut-btn lp-launch lp-shine" href={appHref()}>
          Launch app
        </a>
      </div>
      <span className="lp-progress" aria-hidden />
    </header>
  );
}
