"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { ArrowRight, Pause, Play } from "lucide-react";
import { PlayerAvatar } from "@/components/account/Player";
import { Button } from "@/components/ui";
import { practiceHref } from "@/lib/game-params";
import { useAccount } from "@/lib/account";
import { art } from "@/lib/art";
import type { QueueSeat } from "@/lib/chain/read";
import type { GameId } from "@/lib/mock";
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
const SLIDES: Slide[] = [
  { game: "block-puzzle", title: "Block Puzzle", sub: "Same pieces · 90 seconds · higher score wins", image: art.blockPuzzleHero },
  { game: "holdem", title: "Heads-up Hold'em", sub: "Real-time · 2 players", image: art.holdemHero, long: true },
  { game: "trading-duel", title: "Trading Duel", sub: "Live price · 2.5 minutes · most hits wins", image: art.tradingDuelHero },
];

const ADVANCE_MS = 7000;

export function HeroCarousel() {
  // 0..N-1 are the slides, N is a clone of slide 0 so the last slide always has a next one peeking in.
  const [index, setIndex] = useState(0);
  const [jump, setJump] = useState(false);
  const [paused, setPaused] = useState(false);
  const [hover, setHover] = useState(false);
  const [reduced, setReduced] = useState(true);
  const queue = useQueue();

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const running = !paused && !hover && !reduced;
  const next = () => setIndex((i) => Math.min(i + 1, SLIDES.length));
  useEffect(() => {
    if (!running) return;
    const t = setInterval(next, ADVANCE_MS);
    return () => clearInterval(t);
  }, [running, index]);

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
      style={{ ["--i" as string]: index, ["--advance" as string]: `${ADVANCE_MS}ms` }}
      data-running={running || undefined}
    >
      <div
        className={`hero-track${jump ? " jump" : ""}`}
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
      <button type="button" className="cut icon-btn hero-next" aria-label="Next game" onClick={next}>
        <ArrowRight aria-hidden="true" />
      </button>
      <div className="hero-dots">
        <div role="group" aria-label="Choose a slide" className="dots">
          {SLIDES.map((s, i) => (
            <button key={s.game} type="button" className={i === active ? "on" : undefined} aria-label={`${s.title}, slide ${i + 1} of ${SLIDES.length}`} aria-current={i === active} onClick={() => setIndex(i)}>
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
          <Button variant="money" size="lg" href={`/play/${slide.game}`}>
            Play now
          </Button>
          <Button size="lg" href={practiceHref(slide.game)}>
            Practice free
          </Button>
        </div>
        <QueueStrip seats={others} />
      </div>
    </article>
  );
}

/** Who is waiting in the Queue for this Game. */
function QueueStrip({ seats }: { seats: QueueSeat[] | null }) {
  const n = seats?.length ?? 0;
  const faces = [...new Set(seats?.map((w) => w.player))].slice(0, 3);
  const [title, note] = seats === null ? ["Queue", "Checking…"] : n === 0 ? ["Queue is open", "Be the first in"] : [`${n} waiting in Queue`, "Ready to play now"];
  return (
    <div className="cut slide-queue">
      {n > 0 && <span className="slide-queue-live" aria-hidden="true" />}
      <span className="slide-queue-faces" aria-hidden="true">
        {n === 0 ? <i /> : faces.map((p) => <PlayerAvatar key={p} account={p} size={26} />)}
        {n > faces.length && <b>+{n - faces.length}</b>}
      </span>
      <p className="slide-queue-text">
        <strong>{title}</strong>
        <small>{note}</small>
      </p>
    </div>
  );
}
