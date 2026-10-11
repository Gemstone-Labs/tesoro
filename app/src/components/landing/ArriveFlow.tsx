"use client";

import { ArrowRight } from "lucide-react";
import { useEffect, useRef } from "react";
import { GemaMark } from "@/components/ui/gema";

/**
 * Gemas → Entry → Your game. The Gema in the first pill travels into the slot in the last one (hopping over Entry when
 * the row is horizontal), rests there, then starts again from the first pill. Static under reduced motion.
 */
export function ArriveFlow() {
  const root = useRef<HTMLDivElement>(null);
  const home = useRef<HTMLSpanElement>(null);
  const dest = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const el = root.current!;
    const place = () => {
      const r = el.getBoundingClientRect();
      const a = home.current!.getBoundingClientRect();
      const b = dest.current!.getBoundingClientRect();
      const dx = b.left - a.left;
      const dy = b.top - a.top;
      el.style.setProperty("--x0", `${a.left - r.left}px`);
      el.style.setProperty("--y0", `${a.top - r.top}px`);
      el.style.setProperty("--dx", `${dx}px`);
      el.style.setProperty("--dy", `${dy}px`);
      el.style.setProperty("--hop", Math.abs(dx) > Math.abs(dy) ? "-30px" : "0px");
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    el.classList.add("is-live");
    return () => {
      ro.disconnect();
      el.classList.remove("is-live");
    };
  }, []);

  return (
    <div ref={root} className="lp-arrive" aria-hidden>
      <span className="lp-pill cut cut-btn">
        <span ref={home} className="lp-arrive-slot home">
          <GemaMark size={18} />
        </span>
        Gemas
      </span>
      <ArrowRight />
      <span className="lp-pill cut cut-btn">Entry</span>
      <ArrowRight />
      <span className="lp-pill strong cut cut-btn lp-arrive-dest">
        <span ref={dest} className="lp-arrive-slot">
          <GemaMark size={18} />
        </span>
        Your game
      </span>
      <span className="lp-arrive-gem">
        <span>
          <GemaMark size={18} />
        </span>
      </span>
    </div>
  );
}
