"use client";

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "../fx";

/** A number that eases to its new value instead of jumping; jumps straight there under reduced motion. */
export function Rolling({ value, format, duration = 350 }: { value: number; format: (n: number) => string; duration?: number }) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(value);
  const cur = useRef(value);
  useEffect(() => {
    const from = cur.current;
    if (from === value) return;
    if (reduced) return;
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / duration);
      cur.current = from + (value - from) * (1 - (1 - p) ** 3);
      setShown(cur.current);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, duration, reduced]);
  return <>{format(reduced ? value : shown)}</>;
}
