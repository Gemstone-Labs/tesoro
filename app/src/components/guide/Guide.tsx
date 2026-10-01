"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Bust, type BustName } from "@/components/ui";
import "./guide.css";

/** One contextual tip the corner Guide can say. `id` is what "dismissed" is remembered by. */
export interface GuideTip {
  id: string;
  bust: BustName;
  title?: string;
  text: string;
  /** Optional follow-up link inside the bubble. */
  link?: { href: string; label: string };
}

interface GuideApi {
  register: (tip: GuideTip) => void;
  unregister: (id: string) => void;
  hide: (delta: 1 | -1) => void;
}

interface GuideView {
  /** The tip to show now, or null (none registered, all dismissed, or a game is running). */
  tip: GuideTip | null;
  open: boolean;
  setOpen: (open: boolean | ((o: boolean) => boolean)) => void;
  dismiss: () => void;
}

const Ctx = createContext<GuideApi | null>(null);
const ViewCtx = createContext<GuideView | null>(null);
const STORE = "tesoro-guide-dismissed";

function readDismissed(): string[] {
  try {
    const raw = localStorage.getItem(STORE);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeDismissed(ids: string[]) {
  try {
    localStorage.setItem(STORE, JSON.stringify(ids));
  } catch {
    // private mode: the tip stays dismissed for this page load only
  }
}

/**
 * The corner Guide's state: pages register a tip with `useGuideTip`; one shows at a time (the
 * earliest registered that is not dismissed). Dismissal is remembered per tip in localStorage.
 * Hidden while a game is running (`useGuideHidden`). `GuideCorner` renders it.
 */
export function GuideProvider({ children }: { children: ReactNode }) {
  const [tips, setTips] = useState<GuideTip[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [hidden, setHidden] = useState(0);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDismissed(readDismissed()), 0);
    return () => clearTimeout(t);
  }, []);

  const register = useCallback((tip: GuideTip) => {
    setTips((cur) => (cur.some((t) => t.id === tip.id) ? cur.map((t) => (t.id === tip.id ? tip : t)) : [...cur, tip]));
  }, []);
  const unregister = useCallback((id: string) => setTips((cur) => cur.filter((t) => t.id !== id)), []);
  const hide = useCallback((d: 1 | -1) => setHidden((h) => Math.max(0, h + d)), []);
  const api = useMemo(() => ({ register, unregister, hide }), [register, unregister, hide]);

  const tip = hidden === 0 ? (tips.find((t) => !dismissed.includes(t.id)) ?? null) : null;
  const view = useMemo<GuideView>(
    () => ({
      tip,
      open,
      setOpen,
      dismiss: () => {
        if (!tip) return;
        const next = [...dismissed, tip.id];
        setDismissed(next);
        writeDismissed(next);
        setOpen(false);
      },
    }),
    [tip, open, dismissed],
  );

  return (
    <Ctx.Provider value={api}>
      <ViewCtx.Provider value={view}>{children}</ViewCtx.Provider>
    </Ctx.Provider>
  );
}

/**
 * The Guide: a small bust with a speech bubble for the current tip. It lives in chrome, never over
 * the content: `dock="side"` sits at the bottom of the desktop sidebar (1024px and up), `dock="nav"`
 * is a tappable chip at the left end of the bottom nav below 1024px whose bubble opens on demand.
 * Decorative: the tip text is real text, never the only place its information lives.
 */
export function GuideCorner({ dock }: { dock: "side" | "nav" }) {
  const v = useContext(ViewCtx);
  const { tip, open, setOpen } = v ?? { tip: null, open: false, setOpen: () => undefined };
  useEffect(() => {
    if (!open || dock !== "nav") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, dock, setOpen]);
  if (!v || !tip) return null;
  const bubble = (
    <div className="cut cut-card guide-bubble" role="status">
      {tip.title && <b>{tip.title}</b>}
      <p>{tip.text}</p>
      <div className="guide-actions">
        {tip.link && (
          <Link href={tip.link.href} className="guide-link" onClick={v.dismiss}>
            {tip.link.label}
          </Link>
        )}
        <button type="button" className="guide-x" onClick={v.dismiss} aria-label="Dismiss tip">
          <X aria-hidden="true" /> Got it
        </button>
      </div>
    </div>
  );
  if (dock === "side") {
    return (
      <aside className="guide guide-side" aria-label="Tip">
        {bubble}
        <Bust name={tip.bust} width={96} className="guide-bust" />
      </aside>
    );
  }
  return (
    <aside className={`guide guide-nav${open ? " open" : ""}`} aria-label="Tip">
      <button type="button" className="guide-chip" aria-expanded={open} aria-label={`Tip: ${tip.title ?? tip.text}`} onClick={() => setOpen((o) => !o)}>
        <Bust name={tip.bust} width={44} />
      </button>
      {open && <div className="guide-pop">{bubble}</div>}
    </aside>
  );
}

/** Registers `tip` while `active` (and this component is mounted). No provider: does nothing. */
export function useGuideTip(tip: GuideTip, active = true) {
  const api = useContext(Ctx);
  const ref = useRef(tip);
  useEffect(() => {
    ref.current = tip;
  });
  const { id, bust, title, text } = tip;
  useEffect(() => {
    if (!api || !active) return;
    api.register({ ...ref.current, id, bust, title, text });
    return () => api.unregister(id);
  }, [api, active, id, bust, title, text]);
}

/** Hides the Guide while `hidden` is true: call from anything that is a running game. */
export function useGuideHidden(hidden: boolean) {
  const api = useContext(Ctx);
  useEffect(() => {
    if (!api || !hidden) return;
    api.hide(1);
    return () => api.hide(-1);
  }, [api, hidden]);
}
