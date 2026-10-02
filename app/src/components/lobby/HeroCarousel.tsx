"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowRight, Pause, Play } from "lucide-react";
import { Button, EntryPicker } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { MAX_ENTRY_SOURCES } from "@/lib/chain/ledger";
import { art } from "@/lib/art";
import { fmtGemas } from "@/lib/format";
import type { EntrySize, GameId } from "@/lib/mock";
import { useQueueDepth } from "./useQueueDepth";

interface Slide {
  game: GameId;
  title: string;
  sub: string;
  image: string;
  defaultEntry: EntrySize;
  /** Two-line title, smaller type. */
  long?: boolean;
}

const SLIDES: Slide[] = [
  { game: "block-puzzle", title: "Block Puzzle", sub: "Same Seed · 90 seconds · higher score wins", image: art.blockPuzzleHero, defaultEntry: 1000 },
  { game: "holdem", title: "Heads-up Hold'em", sub: "Real-time · 2 players", image: art.holdemHero, defaultEntry: 500, long: true },
];

const ADVANCE_MS = 7000;

const hrefFor = (kind: "queue" | "challenge", game: GameId, entry: number) =>
  `/play/${kind}?${game === "holdem" ? "game=holdem&" : ""}entry=${entry}`;

export function HeroCarousel() {
  // 0..N-1 are the slides, N is a clone of slide 0 so the last slide always has a next one peeking in.
  const [index, setIndex] = useState(0);
  const [jump, setJump] = useState(false);
  const [paused, setPaused] = useState(false);
  const [hover, setHover] = useState(false);
  const [entries, setEntries] = useState<Record<GameId, EntrySize>>({ "block-puzzle": 1000, holdem: 500 });
  const [reduced, setReduced] = useState(true);
  const depth = useQueueDepth();

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
              entry={entries[s.game]}
              onEntry={(e) => setEntries((cur) => ({ ...cur, [s.game]: e }))}
              waiting={depth[s.game]}
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
  entry,
  onEntry,
  waiting,
  onSelect,
}: {
  slide: Slide;
  active: boolean;
  clone: boolean;
  position: string;
  entry: EntrySize;
  onEntry: (e: EntrySize) => void;
  waiting: number;
  onSelect: () => void;
}) {
  const { gemas, auth, onChain, loading, entryProblem } = useAccount();
  const router = useRouter();
  const signedIn = auth.status === "signed-in" || auth.status === "unconfigured";
  const problem = signedIn && onChain ? entryProblem(entry) : null;
  const canEnter = !signedIn || loading || (onChain ? problem === null : gemas.available >= entry);
  const go = (href: string, reason: string) => auth.gate(reason, () => router.push(href));

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
        <div className="slide-entry">
          <EntryPicker value={entry} onChange={onEntry} legend={`Entry for ${slide.title}`} name={`hero-${slide.game}`} maxAffordable={signedIn && onChain ? gemas.available : undefined} isDisabled={signedIn && onChain ? (size) => entryProblem(size) !== null : undefined} />
        </div>
        <Button variant="money" size="lg" block onClick={() => go(hrefFor("queue", slide.game, entry), "Enter a Match")} disabled={!canEnter}>
          Play now
        </Button>
        <p className="slide-meta">
          {canEnter ? (
            <>
              {waiting} waiting in Queue ·{" "}
              <button type="button" onClick={() => go(hrefFor("challenge", slide.game, entry), "Challenge a friend")}>
                Challenge a friend
              </button>
            </>
          ) : (
            <>
              {problem === "too-many-sources" ? (
                <>Your Gemas are spread over more than {MAX_ENTRY_SOURCES} Sources. <Link href="/wallet">Redeem a few small balances in your Wallet</Link></>
              ) : (
                <>
                  You need {fmtGemas(entry)} Gemas to enter. <Link href="/wallet">Get Gemas in your Wallet</Link>
                </>
              )}
            </>
          )}
        </p>
      </div>
    </article>
  );
}
