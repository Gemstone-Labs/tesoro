"use client";

import { useEffect, useState } from "react";
import { sfx } from "./sfx";

/**
 * Big 3-2-1-Go overlay, centred in the nearest positioned parent. `onDone` fires the moment "Go!" appears
 * (start the clock then); the overlay clears itself shortly after. Ticks and a go cue play unless muted.
 * `<Countdown from={3} onDone={start} />`. Under reduced motion the numbers still change, just without scaling.
 */
export function Countdown({ from = 3, goText = "Go!", onDone, className = "" }: { from?: number; goText?: string; onDone?: () => void; className?: string }) {
  const [n, setN] = useState(from);

  useEffect(() => {
    if (n > 0) {
      sfx("tick");
      const t = setTimeout(() => setN(n - 1), 800);
      return () => clearTimeout(t);
    }
    sfx("go");
    onDone?.();
    const t = setTimeout(() => setN(-1), 700);
    return () => clearTimeout(t);
    // onDone is read once when Go appears
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
