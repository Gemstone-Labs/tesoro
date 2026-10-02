"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { TesoroLogo } from "@/components/brand";
import { appHref } from "@/lib/landing/config";
import { THEME_KEY, type Theme } from "./theme";

const LINKS = [
  ["How it works", "#how-it-works"],
  ["Games", "#games"],
  ["Backing", "#backing"],
  ["Studios", "#studios"],
] as const;


const readTheme = (): Theme => (document.documentElement.dataset.theme === "light" ? "light" : "dark");
const subscribeTheme = (onChange: () => void) => {
  const mo = new MutationObserver(onChange);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => mo.disconnect();
};

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => "dark" as Theme);

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
        <nav className="lp-links" aria-label="Sections">
          {LINKS.map(([label, href]) => (
            <a key={href} href={href}>
              {label}
            </a>
          ))}
          <span className="lp-dim" aria-disabled="true" title="Docs are coming soon">
            Docs
          </span>
        </nav>
        <button
          type="button"
          className="icon-btn cut lp-theme"
          onClick={toggle}
          aria-pressed={theme === "light"}
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        >
          {theme === "dark" ? <Sun aria-hidden /> : <Moon aria-hidden />}
        </button>
        <a className="btn money cut cut-btn lp-launch" href={appHref()}>
          Launch app
        </a>
      </div>
    </header>
  );
}
