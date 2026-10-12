"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import { HEADER_PX } from "./gridView";

/** Where the head of the line is, seen from the view: inside it, or past one of its edges. */
export type LiveDir = "in" | "up" | "down" | "left" | "right";

/** What the screen tells the button every frame: the head's place in the band area (px), where it is, the price text. */
export interface LiveState {
  x: number;
  y: number;
  dir: LiveDir;
  price: string;
}

interface Zoom {
  out: () => void;
  in: () => void;
  atMin: boolean;
  atMax: boolean;
}

interface Props {
  /** The view has been moved off the line. */
  away: boolean;
  onGo: () => void;
  /** The screen hands over the function it calls every frame. */
  bind: (update: ((s: LiveState) => void) | null) => void;
  /** Size of the band area the controls sit over, px. */
  viewW: number;
  bodyH: number;
  zoom: Zoom;
}

const LABEL = "Back to the live price";

/** Below this view width the plaque moves to the right so it never covers the zoom bar. */
const NARROW_PX = 520;

/** The view's controls: the zoom bar at the bottom left, and "Back to live" at the bottom while the view is off the line, its arrow pointing to where the line went. */
export function LiveButton({ away, onGo, bind, viewW, bodyH, zoom }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const price = useRef<HTMLSpanElement>(null);
  const shown = useRef({ dir: "", px: "" });
  useEffect(() => {
    bind((s) => {
      const el = root.current;
      if (!el) return;
      const S = shown.current;
      if (S.dir !== s.dir) {
        S.dir = s.dir;
        el.dataset.dir = s.dir;
      }
      if (S.px !== s.price && price.current) {
        S.px = s.price;
        price.current.textContent = s.price;
      }
    });
    return () => bind(null);
  }, [bind]);

  const style = { top: HEADER_PX, height: bodyH } as CSSProperties;
  return (
    <div ref={root} className="tg-lv" data-on={away} data-dir="in" data-narrow={viewW < NARROW_PX} style={style}>
      <div className="cut cut-card lv-bar" role="group" aria-label="Zoom">
        <button type="button" className="lv-seg" aria-label="Zoom out" title="Zoom out (minus key)" aria-disabled={zoom.atMax} onClick={zoom.out}>
          &minus;
        </button>
        <button type="button" className="lv-seg" aria-label="Zoom in" title="Zoom in (plus key)" aria-disabled={zoom.atMin} onClick={zoom.in}>
          +
        </button>
      </div>
      <button type="button" className="cut cut-btn lv-btn" aria-label={LABEL} title={LABEL} onClick={onGo} inert={!away}>
        <svg className="lv-arrow" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2 8h10M8 3.5 12.5 8 8 12.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
        </svg>
        <span className="lv-t">Back to live</span>
        <span ref={price} className="lv-px tnum" />
      </button>
    </div>
  );
}
