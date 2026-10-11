"use client";

import { useEffect, useRef } from "react";
import { CLIP_SIZE, FIRST_CLIPS, MAX_PLAYING, WALL } from "./clips";
import { LINES } from "./geometry";

type Navigator = { connection?: { saveData?: boolean } };

/**
 * Casual-game clips drifting in tilted columns behind the diagonal. Posters only under reduced motion or
 * Save-Data; otherwise at most a handful of tiles play at once: the ones on screen above the diagonal, the first
 * few at load and the rest when the browser is idle.
 */
export function VideoWall() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches || (navigator as Navigator).connection?.saveData;
    if (still) return;

    const videos = [...el.querySelectorAll("video")];
    const onScreen = new Set<HTMLVideoElement>();
    let idle = false;

    /** Only tiles above the diagonal play; of those, the topmost first. */
    const isAbove = (v: HTMLVideoElement, frame: DOMRect, line: (typeof LINES)["wide"] | (typeof LINES)["tall"]) => {
      const r = v.getBoundingClientRect();
      const x = (r.left + r.width / 2 - frame.left) / frame.width;
      const y = (r.top + r.height / 2 - frame.top) / frame.height;
      const side = (x - line.x1) * (line.y2 - line.y1) - (y - line.y1) * (line.x2 - line.x1);
      return side > 0; // y grows downwards, so a positive side is above the diagonal
    };

    const rebalance = () => {
      const frame = el.getBoundingClientRect();
      const phone = matchMedia("(max-width: 640px)").matches;
      const line = phone ? LINES.tall : LINES.wide;
      const want = [...onScreen]
        .filter((v) => idle || Number(v.dataset.clip) <= FIRST_CLIPS)
        .filter((v) => isAbove(v, frame, line))
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
        .slice(0, phone ? MAX_PLAYING.phone : MAX_PLAYING.wide);
      const keep = new Set(want);
      for (const v of videos) {
        if (keep.has(v)) {
          if (v.paused) void v.play().catch(() => {});
        } else if (!v.paused) v.pause();
      }
    };

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) onScreen.add(e.target as HTMLVideoElement);
          else onScreen.delete(e.target as HTMLVideoElement);
        }
        rebalance();
      },
      { rootMargin: "80px" },
    );
    videos.forEach((v) => io.observe(v));

    // The tiles drift across the diagonal without any intersection change, so look again now and then.
    const tick = window.setInterval(() => document.visibilityState === "visible" && rebalance(), 1500);
    const idleApi = "requestIdleCallback" in window;
    const wake = () => {
      idle = true;
      rebalance();
    };
    const handle = idleApi ? window.requestIdleCallback(wake, { timeout: 2500 }) : window.setTimeout(wake, 1200);

    return () => {
      io.disconnect();
      clearInterval(tick);
      if (idleApi) window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
    };
  }, []);

  return (
    <div className="vw" aria-hidden ref={root}>
      <div className="vw-tilt">
        {WALL.map((clips, c) => (
          <div key={c} className={`vw-col vw-col-${c}`}>
            <div className="vw-track">
              {[0, 1].flatMap((copy) =>
                clips.map((n, pos) => (
                  <video
                    key={`${copy}-${pos}`}
                    className="vw-clip"
                    data-clip={n}
                    muted
                    loop
                    playsInline
                    preload="none"
                    tabIndex={-1}
                    width={CLIP_SIZE.width}
                    height={CLIP_SIZE.height}
                    poster={`/art/waitlist/clip-${n}.webp`}
                  >
                    <source src={`/art/waitlist/clip-${n}.webm`} type="video/webm" />
                    <source src={`/art/waitlist/clip-${n}.mp4`} type="video/mp4" />
                  </video>
                )),
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
