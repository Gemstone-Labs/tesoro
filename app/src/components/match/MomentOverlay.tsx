"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bust, GemaMark, type BustName } from "@/components/ui";
import { fmtGemas } from "@/lib/format";
import { scheduleMoment } from "./moment";
import { Shards } from "./ResultMotion";

const SHOW_MS = 3000;

const sessionStore = () => {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
};

/**
 * A short celebration over the result: the bust in turning emerald rays and a burst of Gema shards
 * for ~3 s, or until clicked or dismissed with Escape or Enter. The result underneath has no
 * character. Shown once per `momentKey` per browser tab; focus moves to it while it shows and goes
 * back afterwards. `onDone` runs when it closes, or at once when this Match's moment was already shown.
 */
export function MomentOverlay({ bust, title, amount, momentKey, onDone }: { bust: BustName; title: string; amount: number; momentKey?: string; onDone?: () => void }) {
  const [show, setShow] = useState(false);
  const close = useRef<HTMLButtonElement>(null);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  const hide = useCallback(() => {
    setShow(false);
    done.current?.();
  }, []);

  useEffect(
    () =>
      scheduleMoment(momentKey, sessionStore(), () => setShow(true), () => done.current?.()),
    [momentKey],
  );

  useEffect(() => {
    if (!show) return;
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus({ preventScroll: true });
    const timer = setTimeout(hide, SHOW_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== "Enter") return;
      e.preventDefault();
      hide();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", onKey);
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
  }, [show, hide]);

  if (!show) return null;
  return (
    <div className="mo" role="dialog" aria-modal="true" aria-labelledby="mo-title" aria-describedby="mo-amount" onClick={hide}>
      <div className="mo-stage">
        <span className="mo-rays" aria-hidden="true" />
        <Shards n={24} delay={120} />
        <Bust name={bust} width={bust === "duoWin" ? 520 : 300} className="mo-bust" priority />
      </div>
      <div className="mo-text">
        <b id="mo-title">{title}</b>
        <span id="mo-amount">
          <GemaMark size={30} /> +{fmtGemas(amount)} Gemas
        </span>
        <button ref={close} type="button" className="mo-close" onClick={hide}>
          Continue <kbd>Esc</kbd>
        </button>
      </div>
    </div>
  );
}
