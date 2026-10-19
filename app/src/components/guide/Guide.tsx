"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Image from "next/image";
import { Lightbulb } from "lucide-react";
import { art } from "@/lib/art";
import { useAuth } from "@/lib/auth/context";
import "./guide.css";

export type PoseName = keyof typeof art.guide;

/** One contextual tip the Guide can say. `id` is what "dismissed" is remembered by. */
export interface GuideTip {
  id: string;
  pose: PoseName;
  title?: string;
  text: string;
  /** Optional follow-up link inside the bubble (following it also dismisses the tip). */
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
  dismiss: () => void;
}

const Ctx = createContext<GuideApi | null>(null);
const ViewCtx = createContext<GuideView | null>(null);
const STORE = "tesoro-guide-dismissed";
const LOAD_WAIT_MS = 1500;

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
 * The Guide's state: pages register a tip with `useGuideTip`; one shows at a time (the earliest
 * registered that is not dismissed). Dismissal is remembered per tip in localStorage.
 * Shown once the sign-in state is known (it sits bottom right, away from Sign in), so a newcomer sees the first tip too. Hidden while a game is running (`useGuideHidden`). `GuideOverlay` renders it.
 */
export function GuideProvider({ children }: { children: ReactNode }) {
  const [tips, setTips] = useState<GuideTip[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [hidden, setHidden] = useState(0);
  const status = useAuth().status;
  const known = status === "signed-in" || status === "signed-out";

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

  const tip = hidden === 0 && known ? (tips.find((t) => !dismissed.includes(t.id)) ?? null) : null;
  const view = useMemo<GuideView>(
    () => ({
      tip,
      dismiss: () => {
        if (!tip) return;
        const next = [...dismissed, tip.id];
        setDismissed(next);
        writeDismissed(next);
      },
    }),
    [tip, dismissed],
  );

  return (
    <Ctx.Provider value={api}>
      <ViewCtx.Provider value={view}>{children}</ViewCtx.Provider>
    </Ctx.Provider>
  );
}

/**
 * The Guide: the first time a tip applies, the page darkens and the character steps in from the
 * bottom right with the tip in a speech bubble. It stays until "Got it" (or the tip's link, or
 * Escape) and is then remembered as dismissed for good. The page stays usable underneath: only
 * the bubble takes clicks and focus is never moved.
 */
export function GuideOverlay() {
  const v = useContext(ViewCtx);
  const tip = v?.tip ?? null;
  return v && tip ? <GuideScene key={tip.id} tip={tip} dismiss={v.dismiss} /> : null;
}

/** Waits for the pose to load (at most `LOAD_WAIT_MS`) so the entrance plays with the art in it. */
function GuideScene({ tip, dismiss }: { tip: GuideTip; dismiss: () => void }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), LOAD_WAIT_MS);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (!ready) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [ready, dismiss]);
  const pose = art.guide[tip.pose];
  return (
    <div className={`guide${ready ? " in" : ""}`} role="dialog" aria-labelledby="guide-title" aria-describedby="guide-text">
      <div className="guide-figure">
        <Image className={`guide-bust${pose.faces === "right" ? " flip" : ""}`} src={pose.src} alt="" width={pose.w} height={pose.h} priority onLoad={() => setReady(true)} />
        <div className="guide-say">
          <div className="cut cut-card guide-bubble">
            <p className="guide-eyebrow">
              <Lightbulb aria-hidden="true" /> Tip
            </p>
            <b id="guide-title">{tip.title ?? "Good to know"}</b>
            <p id="guide-text">{tip.text}</p>
            <div className="guide-actions">
              {tip.link && (
                <Link href={tip.link.href} className="guide-link" onClick={dismiss}>
                  {tip.link.label}
                </Link>
              )}
              <button type="button" className="cut cut-btn btn guide-ok" onClick={dismiss}>
                Got it
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Registers `tip` while `active` (and this component is mounted). No provider: does nothing. */
export function useGuideTip(tip: GuideTip, active = true) {
  const api = useContext(Ctx);
  const ref = useRef(tip);
  useEffect(() => {
    ref.current = tip;
  });
  const { id, pose, title, text } = tip;
  useEffect(() => {
    if (!api || !active) return;
    api.register({ ...ref.current, id, pose, title, text });
    return () => api.unregister(id);
  }, [api, active, id, pose, title, text]);
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
