"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { CLIP_SIZE, MAX_PLAYING } from "./clips";
import { HIGHLIGHT_MS, buildHoneycomb, chooseHighlight, isHighlightCandidate } from "./honeycomb";

type Connection = EventTarget & { saveData?: boolean };
const INITIAL_GRID = buildHoneycomb(1440, 900);

/** Constant diagonal drift and one complete spotlight cycle at a time. */
export function VideoWall() {
  const root = useRef<HTMLDivElement>(null);
  const manualPause = useRef(false);
  const refresh = useRef(() => {});
  const [grid, setGrid] = useState(INITIAL_GRID);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setGrid(buildHoneycomb(width, height));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const connection = (navigator as Navigator & { connection?: Connection }).connection;
    const tiles = [...el.querySelectorAll<HTMLElement>(".vw-tile")];
    const videos = tiles.map((tile) => tile.querySelector("video")!);
    let selected: string | null = null;
    let disposed = false;
    let playing = new Set<HTMLVideoElement>();

    const visibleTiles = () => tiles.map((tile, index) => ({ tile, video: videos[index], rect: tile.getBoundingClientRect() }))
      .filter(({ rect }) => rect.right > 0 && rect.left < innerWidth && rect.bottom > 0 && rect.top < innerHeight);

    const selectNext = () => {
      const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
      const content = document.querySelector<HTMLElement>(".wl-main")!.getBoundingClientRect();
      const protectedAreas = [content, ...[...document.querySelectorAll<HTMLElement>(".vw-toggle")]
        .map((node) => node.getBoundingClientRect())];
      const visible = visibleTiles();
      const dx = grid.period / grid.duration * HIGHLIGHT_MS / 1000;
      const dy = -grid.rise / grid.duration * HIGHLIGHT_MS / 1000;
      const candidates = visible.filter(({ rect }) => {
        const end = { left: rect.left + dx, right: rect.right + dx, top: rect.top + dy, bottom: rect.bottom + dy };
        return isHighlightCandidate(rect, viewport, protectedAreas) && isHighlightCandidate(end, viewport, protectedAreas);
      });
      // On small screens prioritize the art above the headline, allowing a cropped side edge.
      const peripheral = visible.filter(({ rect }) => rect.top >= 72 && rect.bottom < content.top - 12);
      const pool = candidates.length ? candidates : peripheral.length ? peripheral : visible;
      const next = chooseHighlight(pool.map(({ tile }) => tile.dataset.tile!), selected);
      const repeat = next === selected;
      for (const tile of tiles) tile.dataset.highlighted = "false";
      const active = tiles.find((tile) => tile.dataset.tile === next);
      // A lone eligible tile can repeat, but still receives a complete new fade cycle.
      if (active && repeat) void active.offsetWidth;
      if (active) active.dataset.highlighted = "true";
      selected = next;
    };

    const update = () => {
      const staticArt = motion.matches || !!connection?.saveData;
      const still = manualPause.current || staticArt || document.hidden;
      el.dataset.motion = still ? "paused" : "running";
      el.dataset.still = String(staticArt);
      if (!selected) selectNext();
      const visible = visibleTiles();
      const active = visible.find(({ tile }) => tile.dataset.tile === selected);
      const limit = innerWidth <= 640 ? MAX_PLAYING.phone : MAX_PLAYING.wide;
      const ordered = [active, ...visible.filter((item) => item !== active)
        .sort((a, b) => Number(playing.has(b.video)) - Number(playing.has(a.video)))];
      playing = new Set(still ? [] : ordered.filter((item) => item !== undefined).slice(0, limit).map((item) => item.video));
      for (const video of videos) {
        if (!playing.has(video)) {
          video.pause();
          continue;
        }
        if (!video.getAttribute("src")) video.src = `/art/waitlist/clip-${video.dataset.clip}.mp4`;
        if (video.paused) void video.play().then(() => {
          if (disposed || !playing.has(video)) video.pause();
        }).catch(() => {});
      }
    };
    const onCycleEnd = (event: AnimationEvent) => {
      if (event.animationName !== "vw-spotlight" || disposed) return;
      // Selection belongs to the finished animation, never to visibility polling or scaled geometry.
      selectNext();
      update();
    };
    const onLoop = (event: AnimationEvent) => {
      if (event.animationName !== "vw-diagonal" || !selected || disposed) return;
      const nextId = selected.startsWith("lead-") ? selected.replace("lead-", "0-")
        : selected.startsWith("0-") ? selected.replace("0-", "1-") : null;
      const previous = tiles.find((tile) => tile.dataset.tile === selected);
      const next = tiles.find((tile) => tile.dataset.tile === nextId);
      if (!previous || !next) return;
      const phase = previous.querySelector(".vw-face")!.getAnimations()[0]?.currentTime ?? 0;
      const videoTime = previous.querySelector("video")!.currentTime;
      previous.dataset.highlighted = "false";
      next.dataset.highlighted = "true";
      selected = nextId;
      // The duplicate occupies the same screen position after wrapping. Carry the fade and footage with it.
      for (const animation of next.getAnimations({ subtree: true })) animation.currentTime = phase;
      const video = next.querySelector("video")!;
      if (video.readyState >= 1) video.currentTime = videoTime;
      else video.addEventListener("loadedmetadata", () => { video.currentTime = videoTime; }, { once: true });
      update();
    };

    refresh.current = update;
    update();
    const timer = window.setInterval(update, 500);
    el.addEventListener("animationend", onCycleEnd);
    el.addEventListener("animationiteration", onLoop);
    motion.addEventListener("change", update);
    connection?.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("scroll", update, { passive: true });
    return () => {
      disposed = true;
      refresh.current = () => {};
      clearInterval(timer);
      el.removeEventListener("animationend", onCycleEnd);
      el.removeEventListener("animationiteration", onLoop);
      motion.removeEventListener("change", update);
      connection?.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("scroll", update);
      videos.forEach((video) => video.pause());
    };
  }, [grid]);

  return (
    <>
      <div className="vw" aria-hidden="true" ref={root} style={{
        "--vw-width": `${grid.width}px`, "--vw-height": `${grid.height}px`,
        "--vw-period": `${grid.period}px`, "--vw-rise": `${grid.rise}px`,
        "--vw-duration": `${grid.duration}s`, "--vw-highlight-duration": `${HIGHLIGHT_MS}ms`,
      } as CSSProperties}>
        <div className="vw-track">
          {grid.loopTiles.map((tile) => (
            <div key={tile.id} className="vw-tile" data-tile={tile.id}
              style={{ left: tile.x, top: tile.y }}>
              <div className="vw-face">
                <div className="vw-hex">
                  <video data-clip={tile.clip} muted loop playsInline preload="none" tabIndex={-1}
                    width={CLIP_SIZE.width} height={CLIP_SIZE.height} poster={`/art/waitlist/clip-${tile.clip}.webp`} />
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="vw-shade" />
      </div>
      <button className="vw-toggle" type="button" aria-label={paused ? "Resume motion" : "Pause motion"}
        title={paused ? "Resume motion" : "Pause motion"} aria-pressed={paused} onClick={() => {
        manualPause.current = !manualPause.current;
        setPaused(manualPause.current);
        refresh.current();
      }}>
        <span aria-hidden="true">{paused ? "▶" : "Ⅱ"}</span>
      </button>
    </>
  );
}
