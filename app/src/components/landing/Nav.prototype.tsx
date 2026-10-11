"use client";

/**
 * PROTOTYPE ONLY (branch proto/landing-nav-11-10-2026). Five takes on the landing nav, switched by
 * `?variant=` from Nav.tsx. Throwaway: fold the winner into Nav.tsx properly, then drop this file.
 */
import { ChevronDown, Menu, Moon, Sun, X } from "lucide-react";
import { useEffect, useState } from "react";
import { TesoroLogo, TesoroMark } from "@/components/brand";
import { art } from "@/lib/art";
import { appHref } from "@/lib/landing/config";
import { THEME_KEY, type Theme } from "./theme";
import { useTheme } from "./useTheme";

const SECTIONS = [
  ["how-it-works", "How it works"],
  ["gemas", "Gemas"],
  ["games", "Games"],
  ["backing", "Backing"],
  ["multichain", "Chains"],
  ["studios", "Studios"],
] as const;
const SHORT = SECTIONS.filter(([id]) => ["how-it-works", "games", "backing", "studios"].includes(id));

const GAMES = [
  { id: "block-puzzle", name: "Block Puzzle", note: "Play anytime · 90 s", art: art.blockPuzzleHero },
  { id: "holdem", name: "Heads-up Hold’em", note: "Real-time · two Players", art: art.holdemHero },
];

/* ---------- shared hooks (state only; each variant owns its layout) ---------- */

function useScroll() {
  const [s, set] = useState({ y: 0, dir: 0 as -1 | 0 | 1 });
  useEffect(() => {
    let last = scrollY;
    const on = () => {
      const y = scrollY;
      set((p) => ({ y, dir: Math.abs(y - last) < 4 ? p.dir : y > last ? 1 : -1 }));
      last = y;
    };
    on();
    addEventListener("scroll", on, { passive: true });
    return () => removeEventListener("scroll", on);
  }, []);
  return s;
}

/** Which section is under the reading line, and how far through each section the reader is (0..1). */
function useSections() {
  const [state, set] = useState<{ active: string | null; progress: Record<string, number> }>({ active: null, progress: {} });
  useEffect(() => {
    const on = () => {
      const line = innerHeight * 0.35;
      let active: string | null = null;
      const progress: Record<string, number> = {};
      for (const [id] of SECTIONS) {
        const el = document.getElementById(id);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        progress[id] = Math.min(1, Math.max(0, (line - r.top) / r.height));
        if (r.top <= line && r.bottom > line) active = id;
      }
      set({ active, progress });
    };
    on();
    addEventListener("scroll", on, { passive: true });
    addEventListener("resize", on);
    return () => {
      removeEventListener("scroll", on);
      removeEventListener("resize", on);
    };
  }, []);
  return state;
}

function ThemeButton({ className = "" }: { className?: string }) {
  const theme = useTheme();
  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {}
  };
  return (
    <button
      type="button"
      className={`icon-btn cut lp-theme ${className}`}
      onClick={toggle}
      aria-pressed={theme === "light"}
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
    >
      {theme === "dark" ? <Sun aria-hidden /> : <Moon aria-hidden />}
    </button>
  );
}

function Logo({ height = 30 }: { height?: number }) {
  return (
    <a href="#top" className="lp-logo" aria-label="Tesoro, back to top">
      <TesoroLogo height={height} tone="dark" className="on-dark" />
      <TesoroLogo height={height} tone="light" className="on-light" />
    </a>
  );
}

function Cta({ label = "Launch app", className = "" }: { label?: string; className?: string }) {
  return (
    <a className={`btn money cut cut-btn lp-launch lp-shine ${className}`} href={appHref()}>
      {label}
    </a>
  );
}

/** Next Monday 00:00 UTC: when the weekly Season pays out. */
function useSeasonLeft() {
  const [left, set] = useState("");
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      end.setUTCDate(end.getUTCDate() + ((8 - end.getUTCDay()) % 7 || 7));
      const ms = end.getTime() - now.getTime();
      const d = Math.floor(ms / 864e5);
      const h = Math.floor((ms % 864e5) / 36e5);
      const m = Math.floor((ms % 36e5) / 6e4);
      set(d ? `${d}d ${h}h` : `${h}h ${m}m`);
    };
    tick();
    const t = setInterval(tick, 30_000);
    return () => clearInterval(t);
  }, []);
  return left;
}

/* ---------- A · Island: a floating pill that follows the reader ---------- */

export function NavA() {
  const { y } = useScroll();
  const { active } = useSections();
  const [open, setOpen] = useState(false);
  const scrolled = y > 24;
  return (
    <header className="lp-nav pn-a" data-scrolled={scrolled} data-open={open}>
      <div className="pn-a-pill cut">
        <a href="#top" className="pn-a-mark" aria-label="Tesoro, back to top">
          {scrolled ? <TesoroMark size={26} /> : (
            <>
              <TesoroLogo height={26} tone="dark" className="on-dark" />
              <TesoroLogo height={26} tone="light" className="on-light" />
            </>
          )}
        </a>
        <nav className="pn-a-links" aria-label="Sections">
          {SHORT.map(([id, label]) => (
            <a key={id} href={`#${id}`} aria-current={active === id ? "location" : undefined}>
              {label}
            </a>
          ))}
          <a href="/docs">Docs</a>
        </nav>
        <ThemeButton className="pn-a-theme" />
        <button type="button" className="icon-btn cut pn-a-menu" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Menu">
          {open ? <X aria-hidden /> : <Menu aria-hidden />}
        </button>
        <Cta />
        <span className="lp-progress" aria-hidden />
      </div>
      {open && (
        <nav className="pn-a-drop cut" aria-label="Sections" onClick={() => setOpen(false)}>
          {SECTIONS.map(([id, label]) => (
            <a key={id} href={`#${id}`} aria-current={active === id ? "location" : undefined}>
              {label}
            </a>
          ))}
          <a href="/docs">Docs</a>
        </nav>
      )}
    </header>
  );
}

/* ---------- B · Ticker: a live strip above a plain bar ---------- */

export function NavB() {
  const { y } = useScroll();
  const left = useSeasonLeft();
  const [open, setOpen] = useState(false);
  const scrolled = y > 24;
  return (
    <header className="lp-nav pn-b" data-scrolled={scrolled}>
      <div className="pn-b-strip" aria-label="Live on Tesoro">
        <div className="pn-b-strip-in">
          <span><i className="pn-dot" aria-hidden /> Live on devnet</span>
          <span>This Season pays out in <b>{left}</b></span>
          <span>Top 10 Players paid every Monday</span>
          <span>Your Principal is never played</span>
          <span className="pn-b-chains">SOL · ETH · HYPE</span>
        </div>
      </div>
      <div className="lp-nav-in pn-b-bar">
        <Logo height={28} />
        <nav className="pn-b-links" aria-label="Sections">
          {SHORT.map(([id, label]) => (
            <a key={id} href={`#${id}`}>{label}</a>
          ))}
        </nav>
        <a className="pn-b-docs" href="/docs">Docs</a>
        <ThemeButton />
        <button type="button" className="icon-btn cut pn-b-menu" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Menu">
          {open ? <X aria-hidden /> : <Menu aria-hidden />}
        </button>
        <Cta label="Play now" />
      </div>
      {open && (
        <nav className="pn-b-drop" aria-label="Sections" onClick={() => setOpen(false)}>
          {SECTIONS.map(([id, label]) => (
            <a key={id} href={`#${id}`}>{label}</a>
          ))}
          <a href="/docs">Docs</a>
        </nav>
      )}
      <span className="lp-progress" aria-hidden />
    </header>
  );
}

/* ---------- C · Chapters: numbered sections, each with its own reading bar ---------- */

export function NavC() {
  const { y } = useScroll();
  const { active, progress } = useSections();
  const [open, setOpen] = useState(false);
  const idx = SECTIONS.findIndex(([id]) => id === active);
  return (
    <header className="lp-nav pn-c" data-scrolled={y > 24}>
      <div className="lp-nav-in">
        <Logo height={28} />
        <nav className="pn-c-chapters" aria-label="Sections">
          {SECTIONS.map(([id, label], i) => (
            <a key={id} href={`#${id}`} aria-current={active === id ? "location" : undefined} data-done={(progress[id] ?? 0) >= 1}>
              <span className="pn-c-n">{String(i + 1).padStart(2, "0")}</span>
              <span className="pn-c-l">{label}</span>
              <span className="pn-c-bar" style={{ "--p": progress[id] ?? 0 } as React.CSSProperties} aria-hidden />
            </a>
          ))}
        </nav>
        <button type="button" className="pn-c-now" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="pn-c-n">{idx >= 0 ? `${String(idx + 1).padStart(2, "0")} / 06` : "00 / 06"}</span>
          <span>{idx >= 0 ? SECTIONS[idx][1] : "Start"}</span>
          <ChevronDown aria-hidden />
        </button>
        <a className="pn-c-docs" href="/docs">Docs</a>
        <ThemeButton />
        <Cta />
      </div>
      <div className="pn-c-segs" aria-hidden>
        {SECTIONS.map(([id]) => (
          <i key={id} style={{ "--p": progress[id] ?? 0 } as React.CSSProperties} />
        ))}
      </div>
      {open && (
        <nav className="pn-c-drop" aria-label="Sections" onClick={() => setOpen(false)}>
          {SECTIONS.map(([id, label], i) => (
            <a key={id} href={`#${id}`} aria-current={active === id ? "location" : undefined}>
              <span className="pn-c-n">{String(i + 1).padStart(2, "0")}</span> {label}
            </a>
          ))}
          <a href="/docs"><span className="pn-c-n">→</span> Docs</a>
        </nav>
      )}
    </header>
  );
}

/* ---------- D · Menu: almost nothing in the bar; a full-screen index behind one button ---------- */

export function NavD() {
  const { y, dir } = useScroll();
  const [open, setOpen] = useState(false);
  const hidden = y >= 80 && dir === 1;
  useEffect(() => {
    document.documentElement.style.overflow = open ? "hidden" : "";
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [open]);
  return (
    <>
      <header className="lp-nav pn-d" data-scrolled={y > 24} data-hidden={hidden && !open}>
        <div className="lp-nav-in">
          <Logo height={28} />
          <button type="button" className="pn-d-menu cut cut-btn" onClick={() => setOpen(true)} aria-expanded={open}>
            <Menu aria-hidden /> Menu
          </button>
          <Cta label="Play now" />
        </div>
        <span className="lp-progress" aria-hidden />
      </header>
      {open && (
        <div className="pn-d-sheet" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="lp-nav-in pn-d-top">
            <Logo height={28} />
            <ThemeButton />
            <button type="button" className="icon-btn cut" onClick={() => setOpen(false)} aria-label="Close menu">
              <X aria-hidden />
            </button>
          </div>
          <div className="pn-d-body">
            <nav className="pn-d-index" aria-label="Sections" onClick={() => setOpen(false)}>
              {SECTIONS.map(([id, label], i) => (
                <a key={id} href={`#${id}`}>
                  <span className="pn-d-n">{String(i + 1).padStart(2, "0")}</span>
                  {label}
                </a>
              ))}
            </nav>
            <aside className="pn-d-side">
              <p className="lp-eyebrow">Play now</p>
              {GAMES.map((g) => (
                <a key={g.id} className="pn-game cut cut-card" href={appHref(`/play/${g.id}`)}>
                  <img src={g.art} alt="" width={2400} height={1000} />
                  <span>
                    <b>{g.name}</b>
                    <small>{g.note}</small>
                  </span>
                </a>
              ))}
              <div className="pn-d-foot">
                <a href="/docs">Docs</a>
                <a href={appHref("/leaderboard")}>Leaderboard</a>
                <a href={appHref("/help")}>Help</a>
              </div>
            </aside>
          </div>
        </div>
      )}
    </>
  );
}

/* ---------- E · Games first: the games open from the bar itself ---------- */

export function NavE() {
  const { y } = useScroll();
  const [games, setGames] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!games) return;
    const close = (e: MouseEvent) => !(e.target as HTMLElement).closest(".pn-e-games, .pn-e-panel") && setGames(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setGames(false);
    addEventListener("click", close);
    addEventListener("keydown", esc);
    return () => {
      removeEventListener("click", close);
      removeEventListener("keydown", esc);
    };
  }, [games]);
  return (
    <header className="lp-nav pn-e" data-scrolled={y > 24 || games}>
      <div className="lp-nav-in">
        <Logo height={28} />
        <nav className="lp-links cut pn-e-links" aria-label="Sections">
          <button type="button" className="pn-e-games" aria-expanded={games} onClick={() => setGames(!games)} onMouseEnter={() => setGames(true)}>
            Games <ChevronDown aria-hidden />
          </button>
          {SHORT.filter(([id]) => id !== "games").map(([id, label]) => (
            <a key={id} href={`#${id}`}>{label}</a>
          ))}
          <a href="/docs">Docs</a>
        </nav>
        <ThemeButton />
        <button type="button" className="icon-btn cut pn-e-menu" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Menu">
          {open ? <X aria-hidden /> : <Menu aria-hidden />}
        </button>
        <Cta label="Play now" />
      </div>
      {(games || open) && (
        <div className="pn-e-panel" onMouseLeave={() => setGames(false)}>
          <div className="lp-nav-in pn-e-panel-in">
            <div className="pn-e-tiles">
              {GAMES.map((g) => (
                <a key={g.id} className="pn-game cut cut-card" href={appHref(`/play/${g.id}`)}>
                  <img src={g.art} alt="" width={2400} height={1000} />
                  <span>
                    <b>{g.name}</b>
                    <small>{g.note}</small>
                  </span>
                  <em className="pn-e-practice">Practice free →</em>
                </a>
              ))}
            </div>
            <div className="pn-e-aside">
              <p className="lp-eyebrow">New here?</p>
              <p>Every game has a free practice mode. Try one before you play for Gemas.</p>
              <a href="#games" className="lp-link" onClick={() => setGames(false)}>See how the games work</a>
              {open && (
                <nav className="pn-e-mlinks" aria-label="Sections" onClick={() => setOpen(false)}>
                  {SECTIONS.map(([id, label]) => (
                    <a key={id} href={`#${id}`}>{label}</a>
                  ))}
                  <a href="/docs">Docs</a>
                </nav>
              )}
            </div>
          </div>
        </div>
      )}
      <span className="lp-progress" aria-hidden />
    </header>
  );
}
