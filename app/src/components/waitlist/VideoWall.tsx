"use client";

import { useEffect, useRef } from "react";
import { CLIP_SIZE, FIRST_CLIPS, WALL_COLUMNS } from "./clips";

type Navigator = { connection?: { saveData?: boolean } };

/**
 * Casual-game clips drifting in tilted columns behind the diagonal. Posters only under reduced motion or
 * Save-Data; otherwise a clip plays while it is on screen, the first few at once and the rest when the browser is idle.
 */
export function VideoWall() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches || (navigator as Navigator).connection?.saveData;
    if (still) return;

    const videos = [...el.querySelectorAll("video")];
    const visible = new Set<HTMLVideoElement>();
    let idle = false;
    const wants = (v: HTMLVideoElement) => visible.has(v) && (idle || Number(v.dataset.clip) <= FIRST_CLIPS);
    const sync = (v: HTMLVideoElement) => (wants(v) ? void v.play().catch(() => {}) : v.pause());

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const v = e.target as HTMLVideoElement;
          if (e.isIntersecting) visible.add(v);
          else visible.delete(v);
          sync(v);
        }
      },
      { rootMargin: "80px" },
    );
    videos.forEach((v) => io.observe(v));

    const wake = () => {
      idle = true;
      videos.forEach(sync);
    };
    const idleApi = "requestIdleCallback" in window;
    const handle = idleApi ? window.requestIdleCallback(wake, { timeout: 2500 }) : window.setTimeout(wake, 1200);

    return () => {
      io.disconnect();
      if (idleApi) window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
    };
  }, []);

  return (
    <div className="vw" aria-hidden ref={root}>
      <div className="vw-tilt">
        {WALL_COLUMNS.map((clips, c) => (
          <div key={c} className={`vw-col vw-col-${c}`}>
            <div className="vw-track">
              {[0, 1].flatMap((copy) =>
                clips.map((n, pos) => (
                  <video
                    key={`${copy}-${n}`}
                    className={`vw-clip${pos === 2 ? " vw-extra" : ""}`}
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
