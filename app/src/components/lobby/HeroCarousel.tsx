"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import Link from "next/link";
import { ArrowRight, Pause, Play } from "lucide-react";
import { PlayerAvatar } from "@/components/account/Player";
import { Button } from "@/components/ui";
import { challengeHref, practiceHref } from "@/lib/game-params";
import { useAccount } from "@/lib/account";
import { art } from "@/lib/art";
import { awayNotice } from "@/lib/chain/protections";
import { useAway } from "@/lib/chain/useAway";
import type { QueueSeat } from "@/lib/chain/read";
import type { GameId } from "@/lib/mock";
import { firstSlideGame } from "./first-slide";
import { useQueue } from "./useQueue";

interface Slide {
  game: GameId;
  title: string;
  sub: string;
  image: string;
  /** Two-line title, smaller type. */
  long?: boolean;
}

/** The featured Games. Entry, Queue and Challenge live on each Game's page; the hero only leads there. */
export const SLIDES: Slide[] = [
  { game: "holdem", title: "Buckshot Hold'em", sub: "Real-time · 2 players", image: art.holdemHero, long: true },
  { game: "trading-duel", title: "Trading Duel", sub: "Live price · 2.5 minutes · most hits wins", image: art.tradingDuelHero },
  { game: "block-puzzle", title: "Block Puzzle", sub: "Same pieces · 90 seconds · higher score wins", image: art.blockPuzzleHero },
];

const ADVANCE_MS = 7000;

export function HeroCarousel() {
  // 0..N-1 are the slides, N is a clone of slide 0 so the last slide always has a next one peeking in.
  // `picked` is null until the visitor or the auto-advance moves the carousel: until then it shows the opening slide.
  const [picked, setPicked] = useState<number | null>(null);
  const [jump, setJump] = useState(false);
  const [paused, setPaused] = useState(false);
  const [hover, setHover] = useState(false);
  const [reduced, setReduced] = useState(true);
  const queue = useQueue();
  const { snapshot, auth } = useAccount();
  const me = snapshot?.accountKey.toBase58();
  /** Who is looking is known: signed out, or signed in with the Account read. Until then the Player's own seat could count as someone waiting. */
  const settled = auth.status === "signed-out" || auth.status === "unconfigured" || (auth.status === "signed-in" && !!me);
  // Open on the first Game with someone else waiting once the Queue has landed and the viewer is known; Slide 0 until then.
  const opening = queue && settled ? Math.max(0, SLIDES.findIndex((s) => s.game === firstSlideGame(queue, SLIDES.map((s) => s.game), me))) : 0;
  const index = picked ?? opening;
  const setIndex = useCallback((to: number | ((i: number) => number)) => setPicked((p) => (typeof to === "function" ? to(p ?? opening) : to)), [opening]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Swipe: the track follows a finger; letting go past 40px, or a quick flick, moves one slide. Any touch ends auto-advance,
  // so the slide never changes under a thumb. A move the visitor makes runs faster than the auto-advance glide.
  const [manual, setManual] = useState(false);
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; t: number; axis: "x" | "y" | null } | null>(null);
  const swiped = useRef(false);
  const n = SLIDES.length;
  // Under reduced motion there is no slide animation, so it wraps straight to the first slide instead of through the clone.
  const step = (dir: 1 | -1) => {
    setManual(true);
    setIndex((i) => (reduced ? (((i % n) + dir + n) % n) : dir > 0 ? Math.min(i + 1, n) : i === 0 ? n - 1 : i - 1));
  };
  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (e.pointerType === "mouse" || drag.current) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, axis: null };
    swiped.current = false;
    setPaused(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      d.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (d.axis === "x") e.currentTarget.setPointerCapture(e.pointerId);
    }
    if (d.axis !== "x" || reduced || !track.current) return;
    // Nothing sits left of the first slide: resist the drag there instead of stopping dead.
    const off = index === 0 && dx > 0 ? dx * 0.35 : dx;
    track.current.style.transition = "none";
    track.current.style.transform = `translateX(calc(${-index * 100}% + ${off}px))`;
  };
  const endDrag = (e: PointerEvent<HTMLElement>, cancel = false) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    if (track.current) {
      track.current.style.transition = "";
      track.current.style.transform = "";
    }
    if (cancel || d.axis !== "x") return;
    setManual(true);
    const dx = e.clientX - d.x;
    const flick = Math.abs(dx) > 10 && Math.abs(dx) / Math.max(1, e.timeStamp - d.t) > 0.11;
    if (Math.abs(dx) < 40 && !flick) return;
    swiped.current = true;
    step(dx < 0 ? 1 : -1);
  };

  const running = !paused && !hover && !reduced;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      setManual(false);
      setIndex((i) => Math.min(i + 1, SLIDES.length));
    }, ADVANCE_MS);
    return () => clearInterval(t);
  }, [running, index, setIndex]);

  // After sliding onto the clone, snap back to the real first slide without animating.
  useEffect(() => {
    if (jump) {
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => setJump(false)));
      return () => cancelAnimationFrame(raf);
    }
  }, [jump]);
  const active = index % SLIDES.length;

  return (
    <section
      className="hero"
      aria-roledescription="carousel"
      aria-label="Featured games"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocusCapture={() => setHover(true)}
      onBlurCapture={() => setHover(false)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endDrag(e)}
      onPointerCancel={(e) => endDrag(e, true)}
      onClickCapture={(e) => {
        if (swiped.current) {
          swiped.current = false;
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      style={{ ["--i" as string]: index, ["--advance" as string]: `${ADVANCE_MS}ms` }}
      data-running={running || undefined}
    >
      <div
        ref={track}
        className={`hero-track${jump ? " jump" : ""}${manual ? " manual" : ""}`}
        aria-live={running ? "off" : "polite"}
        onTransitionEnd={(e) => {
          if (e.target === e.currentTarget && index === SLIDES.length) {
            setJump(true);
            setIndex(0);
          }
        }}
      >
        {[...SLIDES, SLIDES[0]].map((s, i) => {
          const clone = i === SLIDES.length;
          return (
            <HeroSlide
              key={clone ? "clone" : s.game}
              slide={s}
              active={i === index}
              clone={clone}
              position={`${i + 1} of ${SLIDES.length}`}
              waiting={queue?.[s.game] ?? null}
              onSelect={() => setIndex(clone ? 0 : i)}
            />
          );
        })}
      </div>
      <button type="button" className="cut icon-btn hero-next" aria-label="Next game" onClick={() => step(1)}>
        <ArrowRight aria-hidden="true" />
      </button>
      <div className="hero-dots">
        <div role="group" aria-label="Choose a slide" className="dots">
          {SLIDES.map((s, i) => (
            <button key={s.game} type="button" className={i === active ? "on" : undefined} aria-label={`${s.title}, slide ${i + 1} of ${SLIDES.length}`} aria-current={i === active} onClick={() => {
                setManual(true);
                setIndex(i);
              }}>
              {i === active && <i key={index} aria-hidden="true" />}
            </button>
          ))}
        </div>
        {!reduced && (
          <button type="button" className="hero-pause" aria-label={paused ? "Resume auto-advance" : "Pause auto-advance"} onClick={() => setPaused((p) => !p)}>
            {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
          </button>
        )}
      </div>
    </section>
  );
}

function HeroSlide({
  slide,
  active,
  clone,
  position,
  waiting,
  onSelect,
}: {
  slide: Slide;
  active: boolean;
  clone: boolean;
  position: string;
  /** Open Queue Matches for this Game; null until read. */
  waiting: QueueSeat[] | null;
  onSelect: () => void;
}) {
  const { snapshot } = useAccount();
  const me = snapshot?.accountKey.toBase58();
  const away = useAway();
  const awayText = away ? awayNotice(away) : null;
  const others = waiting?.filter((w) => w.player !== me) ?? null;

  return (
    <article
      className={`cut cut-frame slide${active ? " active" : ""}${slide.long ? " long" : ""}`}
      role="group"
      aria-roledescription="slide"
      aria-label={`${position}: ${slide.title}`}
      aria-hidden={clone || undefined}
      onClick={active ? undefined : onSelect}
    >
      <div className="slide-art" aria-hidden="true">
        <Image src={slide.image} alt="" fill priority={active && !clone} sizes="(min-width: 1024px) 60vw, 100vw" />
        <span className="sparkles">
          {Array.from({ length: 10 }, (_, i) => (
            <i key={i} />
          ))}
        </span>
      </div>
      <div className="slide-body" {...(active ? {} : { inert: true })}>
        <h2 className="slide-title">{slide.title}</h2>
        <p className="slide-sub">{slide.sub}</p>
        <div className="slide-cta">
          {awayText ? (
            <p className="status" role="status">{awayText}</p>
          ) : (
            <Button variant="money" size="lg" href={`/play/${slide.game}`}>
              Play now
            </Button>
          )}
          <Button size="lg" href={practiceHref(slide.game)}>
            Practice free
          </Button>
        </div>
        <QueueStrip seats={others} game={slide.game} />
      </div>
    </article>
  );
}

/** Who is waiting in the Queue for this Game. */
function QueueStrip({ seats, game }: { seats: QueueSeat[] | null; game: GameId }) {
  const n = seats?.length ?? 0;
  const faces = [...new Set(seats?.map((w) => w.player))].slice(0, 3);
  const [title, note] = seats === null ? ["Queue", "Checking…"] : n === 0 ? ["No one waiting yet", null] : [`${n} waiting in Queue`, "Ready to play now"];
  return (
    <div className="cut slide-queue">
      {n > 0 && <span className="slide-queue-live" aria-hidden="true" />}
      <span className="slide-queue-faces" aria-hidden="true">
        {n === 0 ? <i /> : faces.map((p) => <PlayerAvatar key={p} account={p} size={26} />)}
        {n > faces.length && <b>+{n - faces.length}</b>}
      </span>
      <p className="slide-queue-text">
        <strong>{title}</strong>
        {note ? <small>{note}</small> : <Link href={challengeHref(game)}>Challenge a friend</Link>}
      </p>
    </div>
  );
}
