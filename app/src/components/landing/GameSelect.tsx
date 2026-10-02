"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";

export type LandingGame = {
  id: string;
  name: string;
  /** One short line under the name on the shelf. */
  note: string;
  body: string;
  facts: [label: string, value: string][];
  /** Wide hero art; its dark left third carries the name. */
  art: string;
  /** Pixel size of public/art/landing/loop-<id>.{webm,mp4,webp}. */
  loop: [width: number, height: number];
  href: string;
};

/** Seconds the stage stays on a game before showing the next one, until the visitor picks a game. */
const DWELL = 10;

/**
 * The shelf picks a game, the stage plays its gameplay loop beside what you need to know about it.
 * Loops load and play only while the stage is in view, never under reduced motion. On desktop the stage
 * moves to the next game by itself (paused while hovered or focused) until the visitor picks one.
 */
export function GameSelect({ games, footnote }: { games: LandingGame[]; footnote: string }) {
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState(false);
  const [inView, setInView] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const videos = useRef<(HTMLVideoElement | null)[]>([]);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const bars = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    if (!stage.current) return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0.35 });
    io.observe(stage.current);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    videos.current.forEach((v, i) => {
      if (!v) return;
      if (i === active && inView) v.play().catch(() => {});
      else v.pause();
    });
  }, [active, inView]);

  useEffect(() => {
    const bar = bars.current[active];
    const auto = !picked && inView && games.length > 1 && matchMedia("(hover: hover) and (min-width: 1024px) and (prefers-reduced-motion: no-preference)").matches;
    if (!auto || !bar) return;
    let elapsed = 0;
    let last = performance.now();
    bar.style.transform = "scaleX(0)";
    let frame = requestAnimationFrame(function tick(now) {
      if (!root.current?.matches(":hover, :focus-within")) elapsed += (now - last) / 1000;
      last = now;
      if (elapsed >= DWELL) return setActive((a) => (a + 1) % games.length);
      bar.style.transform = `scaleX(${elapsed / DWELL})`;
      frame = requestAnimationFrame(tick);
    });
    return () => {
      cancelAnimationFrame(frame);
      bar.style.transform = "";
    };
  }, [active, picked, inView, games.length]);

  const pick = (i: number) => {
    setPicked(true);
    setActive(i);
  };
  const onKey = (e: KeyboardEvent) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (active + step + games.length) % games.length;
    pick(next);
    tabs.current[next]?.focus();
  };

  return (
    <div ref={root} className="lp-games-select" data-reveal>
      <div className="lp-shelf" role="tablist" aria-label="Games" onKeyDown={onKey}>
        {games.map((g, i) => (
          <button
            key={g.id}
            ref={(el) => void (tabs.current[i] = el)}
            type="button"
            role="tab"
            id={`game-tab-${g.id}`}
            aria-selected={i === active}
            aria-controls="game-stage"
            tabIndex={i === active ? 0 : -1}
            className="lp-shelf-tab cut cut-card"
            onClick={() => pick(i)}
          >
            <picture>
              <img src={g.art} alt="" loading="lazy" width={2400} height={1000} />
            </picture>
            <span className="lp-shelf-name">{g.name}</span>
            <span className="lp-shelf-note">{g.note}</span>
            <i ref={(el) => void (bars.current[i] = el)} className="lp-shelf-bar" aria-hidden />
          </button>
        ))}
      </div>

      <div ref={stage} id="game-stage" role="tabpanel" aria-labelledby={`game-tab-${games[active].id}`} className="lp-stage cut cut-frame">
        <div className="lp-stage-screen">
          {games.map((g, i) => (
            <video
              key={g.id}
              ref={(el) => void (videos.current[i] = el)}
              className="lp-loop"
              data-on={i === active || undefined}
              data-tall={g.loop[1] > g.loop[0] || undefined}
              muted
              loop
              playsInline
              preload="none"
              poster={`/art/landing/loop-${g.id}.webp`}
              width={g.loop[0]}
              height={g.loop[1]}
              aria-label={`${g.name} gameplay`}
              aria-hidden={i !== active}
            >
              <source src={`/art/landing/loop-${g.id}.webm`} type="video/webm" />
              <source src={`/art/landing/loop-${g.id}.mp4`} type="video/mp4" />
            </video>
          ))}
        </div>
        <div className="lp-stage-info">
          {games.map((g, i) => (
            <div key={g.id} className="lp-stage-game" hidden={i !== active}>
              <h3 className="lp-stage-name">{g.name}</h3>
              <p className="lp-body">{g.body}</p>
              <dl className="lp-stage-facts">
                {g.facts.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <a className="btn neutral block cut cut-btn" href={g.href}>
                See {g.name}
              </a>
            </div>
          ))}
          <p className="lp-stage-foot mono">{footnote}</p>
        </div>
      </div>
    </div>
  );
}
