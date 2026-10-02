"use client";

import { useEffect, useRef, useState } from "react";
import { fmtGemas } from "@/lib/format";

/**
 * A figure that rolls to its new value (ease-out, ~0.8 s) instead of jumping, so a balance change is
 * seen. `from` makes it roll in on mount (a won amount counting up). Jumps straight there under
 * prefers-reduced-motion.
 */
export function CountUp({ value, from, format = fmtGemas, duration = 800 }: { value: number; from?: number; format?: (n: number) => string; duration?: number }) {
  const [shown, setShown] = useState(from ?? value);
  const current = useRef(from ?? value);

  useEffect(() => {
    const from = current.current;
    if (from === value) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const p = reduced ? 1 : Math.min(1, (t - t0) / duration);
      const n = Math.round(from + (value - from) * (1 - (1 - p) ** 3));
      current.current = n;
      setShown(n);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  return <>{format(shown)}</>;
}
