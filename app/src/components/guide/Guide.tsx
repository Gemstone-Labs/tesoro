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

const Ctx = createContext<GuideApi | null>(null);
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
 * The corner Guide: a small bust bottom-left with a speech bubble for contextual tips. Pages
 * register a tip with `useGuideTip`; one shows at a time (the earliest registered that is not
 * dismissed). Dismissal is remembered per tip in localStorage. Hidden while a game is running
 * (`useGuideHidden`), a tappable chip below 1024px. Decorative: the tip text is real text, never the
 * only place its information lives.
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

  const tip = tips.find((t) => !dismissed.includes(t.id)) ?? null;
  const dismiss = () => {
    if (!tip) return;
    const next = [...dismissed, tip.id];
    setDismissed(next);
    writeDismissed(next);
    setOpen(false);
  };

  return (
    <Ctx.Provider value={api}>
      {children}
      {tip && hidden === 0 && (
        <aside className={`guide${open ? " open" : ""}`} aria-label="Tip">
          <button type="button" className="cut cut-btn guide-chip" aria-expanded={open} aria-label={`Tip: ${tip.title ?? tip.text}`} onClick={() => setOpen((o) => !o)}>
            <Bust name={tip.bust} width={44} />
          </button>
          <div className="guide-full">
            <Bust name={tip.bust} width={112} className="guide-bust" />
            <div className="cut cut-card guide-bubble" role="status">
              {tip.title && <b>{tip.title}</b>}
              <p>{tip.text}</p>
              <div className="guide-actions">
                {tip.link && (
                  <Link href={tip.link.href} className="guide-link" onClick={dismiss}>
                    {tip.link.label}
                  </Link>
                )}
                <button type="button" className="guide-x" onClick={dismiss} aria-label="Dismiss tip">
                  <X aria-hidden="true" /> Got it
                </button>
              </div>
            </div>
          </div>
        </aside>
      )}
    </Ctx.Provider>
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
