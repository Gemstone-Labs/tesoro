"use client";

import { useEffect, useRef, useState } from "react";
import { sfx } from "./sfx";

/**
 * Big 3-2-1-Go overlay, centred in the nearest positioned parent. `onDone` fires the moment "Go!" appears
 * (start the clock then); the overlay clears itself shortly after and calls `onEnd`. Keep it mounted until `onEnd`. Ticks and a go cue play unless muted.
 * `<Countdown from={3} onDone={start} />`. Under reduced motion the numbers still change, just without scaling.
 */
export function Countdown({ from = 3, goText = "Go!", onDone, onEnd, className = "" }: { from?: number; goText?: string; onDone?: () => void; onEnd?: () => void; className?: string }) {
  const [n, setN] = useState(from);
  const cbs = useRef({ onDone, onEnd });
  useEffect(() => {
    cbs.current = { onDone, onEnd };
  });

  useEffect(() => {
    if (n > 0) {
      sfx("tick");
      const t = setTimeout(() => setN(n - 1), 800);
      return () => clearTimeout(t);
    }
    sfx("go");
    cbs.current.onDone?.();
    const t = setTimeout(() => setN(-1), 700);
    return () => clearTimeout(t);
  }, [n]);

  useEffect(() => {
    if (n < 0) cbs.current.onEnd?.();
  }, [n]);

  if (n < 0) return null;
  const text = n > 0 ? String(n) : goText;
  return (
    <div className={`fx-countdown ${className}`} role="timer" aria-live="assertive">
      <span key={n} className={`fx-count-n${n === 0 ? " go" : ""}`}>
        {text}
      </span>
    </div>
  );
}
