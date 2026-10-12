"use client";

import { useEffect, useRef, useSyncExternalStore, type CSSProperties } from "react";
import { HEADER_PX } from "./gridView";

/** Four takes on the way back to the line after looking elsewhere; `?live=A|B|C|D` picks one. Deleting the losers means deleting their entries here and their rules in grid.css. */
export type LiveVariant = "A" | "B" | "C" | "D";
export const LIVE_DEFAULT: LiveVariant = "A";

/** Where the head of the line is, seen from the view: inside it, or past one of its edges. */
export type LiveDir = "in" | "up" | "down" | "left" | "right";

/** What the screen tells the button every frame: the head's place in the band area (px), where it is, the price text. */
export interface LiveState {
  x: number;
  y: number;
  dir: LiveDir;
  price: string;
}

const noop = () => () => {};
function fromUrl(): LiveVariant {
  const q = new URLSearchParams(window.location.search).get("live")?.toUpperCase();
  return q === "A" || q === "B" || q === "C" || q === "D" ? q : LIVE_DEFAULT;
}
export const useLiveVariant = (): LiveVariant => useSyncExternalStore(noop, fromUrl, () => LIVE_DEFAULT);

interface Zoom {
  out: () => void;
  in: () => void;
  atMin: boolean;
  atMax: boolean;
}

interface Props {
  variant: LiveVariant;
  /** The view has been moved off the line. */
  away: boolean;
  onGo: () => void;
  /** The screen hands over the function it calls every frame. */
  bind: (update: ((s: LiveState) => void) | null) => void;
  /** Size of the band area the button sits over, px. */
  viewW: number;
  bodyH: number;
  zoom: Zoom;
}

const LABEL = "Back to the live price";

function Arrow() {
  return (
    <svg className="lv-arrow" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 8h10M8 3.5 12.5 8 8 12.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
    </svg>
  );
}

const Diamond = () => <i className="lv-dia" aria-hidden="true" />;

/** The wording and shape of each take. A and C show a button only while away; B follows the price pointer; D is a toolbar. */
export function LiveButton({ variant, away, onGo, bind, viewW, bodyH, zoom }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const price = useRef<HTMLSpanElement>(null);
  const shown = useRef({ dir: "", px: "", x: NaN, y: NaN });
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
      const x = Math.round(Math.max(70, Math.min(viewW - 70, s.x)));
      const y = Math.round(Math.max(28, Math.min(bodyH - 28, s.y)));
      if (x !== S.x || y !== S.y) {
        S.x = x;
        S.y = y;
        el.style.setProperty("--lv-x", `${x}px`);
        el.style.setProperty("--lv-y", `${y}px`);
      }
    });
    return () => bind(null);
  }, [bind, viewW, bodyH, variant]);

  const style = { top: HEADER_PX, height: bodyH, "--lv-w": `${viewW}px`, "--lv-bh": `${bodyH}px` } as CSSProperties;
  const common = { "aria-label": LABEL, title: LABEL, onClick: onGo, inert: !away };

  if (variant === "D") {
    return (
      <div ref={root} className="tg-lv" data-v="D" data-on={away} data-dir="in" style={style}>
        <div className="cut cut-card lv-bar" role="group" aria-label="View">
          <button type="button" className="lv-seg" aria-label="Zoom out" title="Zoom out (minus key)" aria-disabled={zoom.atMax} onClick={zoom.out}>
            &minus;
          </button>
          <button type="button" className="lv-seg" aria-label="Zoom in" title="Zoom in (plus key)" aria-disabled={zoom.atMin} onClick={zoom.in}>
            +
          </button>
          <button type="button" className="lv-seg lv-live" aria-label={LABEL} title={away ? LABEL : "Following the live price"} aria-disabled={!away} onClick={() => away && onGo()}>
            <Diamond />
            <span>Live</span>
            <span ref={price} className="lv-px tnum" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={root} className="tg-lv" data-v={variant} data-on={away} data-dir="in" style={style}>
      <button type="button" className="cut cut-btn lv-btn" {...common}>
        {variant === "A" && (
          <>
            <Arrow />
            <span className="lv-t">Back to live</span>
            <span ref={price} className="lv-px tnum" />
          </>
        )}
        {variant === "B" && (
          <>
            <Arrow />
            <span className="lv-t">Live</span>
            <span ref={price} className="lv-px tnum" />
          </>
        )}
        {variant === "C" && (
          <>
            <span className="lv-glow" aria-hidden="true" />
            <Arrow />
            <span className="lv-t">Live</span>
          </>
        )}
      </button>
    </div>
  );
}
