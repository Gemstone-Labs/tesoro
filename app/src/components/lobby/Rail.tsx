"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";

/** A titled horizontal rail: bold condensed header, "VIEW ALL →", ← → arrows that scroll the track. */
export function Rail({
  id,
  title,
  viewAll,
  cols,
  children,
  aside,
  className,
}: {
  id: string;
  title: string;
  viewAll?: string;
  /** Tiles visible at once on wide screens (narrower containers show fewer, see lobby.css). */
  cols: 3 | 4 | 6;
  children: ReactNode;
  /** Extra header content (e.g. an active-filter note). */
  aside?: ReactNode;
  className?: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ start: true, end: true });

  const measure = useCallback(() => {
    const t = track.current;
    if (!t) return;
    setEdge({ start: t.scrollLeft <= 2, end: t.scrollLeft + t.clientWidth >= t.scrollWidth - 2 });
  }, []);

  useEffect(() => {
    measure();
    const t = track.current;
    if (!t) return;
    const ro = new ResizeObserver(measure);
    ro.observe(t);
    return () => ro.disconnect();
  }, [measure, children]);

  const scroll = (dir: 1 | -1) => {
    const t = track.current;
    if (!t) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    t.scrollBy({ left: dir * t.clientWidth * 0.9, behavior: reduce ? "auto" : "smooth" });
  };

  return (
    <section className={`rail ${className ?? ""}`} aria-labelledby={`${id}-h`} id={id} data-cols={cols}>
      <header className="rail-head">
        <h2 id={`${id}-h`} className="h-section">{title}</h2>
        {aside}
        <span className="rail-tools">
          {viewAll && (
            <Link href={viewAll} className="view-all">
              View all <ArrowRight aria-hidden="true" />
            </Link>
          )}
          <button type="button" className="cut icon-btn arrow" aria-label={`Scroll ${title} left`} disabled={edge.start} onClick={() => scroll(-1)}>
            <ArrowLeft aria-hidden="true" />
          </button>
          <button type="button" className="cut icon-btn arrow" aria-label={`Scroll ${title} right`} disabled={edge.end} onClick={() => scroll(1)}>
            <ArrowRight aria-hidden="true" />
          </button>
        </span>
      </header>
      <div className="rail-track" ref={track} onScroll={measure}>
        {children}
      </div>
    </section>
  );
}
