"use client";

import { useEffect, useRef, type PointerEvent } from "react";

const CONTROLS = ".bottom-nav a, .topbar .menu-btn, .topbar .pchest, .topbar .gpill, .topbar .acct-btn, .topbar .btn";
const PRESS_MS = 120;

/** Give even a brief touch a painted press, without delaying the action or navigation. */
export function useShellPress() {
  const press = useRef<{ el: HTMLElement; id: number; paintedAt: number | null; released: boolean; x: number; y: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const frame = useRef<number>(undefined);

  function clear() {
    clearTimeout(timer.current);
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
    press.current?.el.removeAttribute("data-pressed");
    press.current = null;
  }

  useEffect(() => {
    const release = (e: globalThis.PointerEvent) => {
      if (press.current?.id !== e.pointerId) return;
      const p = press.current;
      p.released = true;
      if (p.paintedAt !== null) timer.current = setTimeout(clear, Math.max(0, PRESS_MS - (performance.now() - p.paintedAt)));
    };
    const cancel = (e: globalThis.PointerEvent) => {
      if (press.current?.id === e.pointerId) clear();
    };
    const move = (e: globalThis.PointerEvent) => {
      const p = press.current;
      if (p?.id === e.pointerId && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) clear();
    };
    document.addEventListener("pointerup", release, true);
    document.addEventListener("pointercancel", cancel, true);
    document.addEventListener("pointermove", move, true);
    window.addEventListener("blur", clear);
    return () => {
      clear();
      document.removeEventListener("pointerup", release, true);
      document.removeEventListener("pointercancel", cancel, true);
      document.removeEventListener("pointermove", move, true);
      window.removeEventListener("blur", clear);
    };
  }, []);

  return (e: PointerEvent<HTMLElement>) => {
    if (!e.isPrimary || e.button !== 0 || !(e.target instanceof Element)) return;
    const el = e.target.closest<HTMLElement>(CONTROLS);
    if (!el || !e.currentTarget.contains(el) || el.matches(":disabled, [aria-disabled='true']")) return;
    clear();
    const p = { el, id: e.pointerId, paintedAt: null as number | null, released: false, x: e.clientX, y: e.clientY };
    press.current = p;
    el.setAttribute("data-pressed", "true");
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      p.paintedAt = performance.now();
      if (p.released) timer.current = setTimeout(clear, PRESS_MS);
    });
  };
}
