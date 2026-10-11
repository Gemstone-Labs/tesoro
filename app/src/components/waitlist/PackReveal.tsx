"use client";

import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TesoroMark } from "@/components/brand";
import { art } from "@/lib/art";
import type { SpotGem } from "@/lib/waitlist-spot";
import { CARD, SpotCard, type CardFonts } from "./SpotCard";

/** Where the pack tears, as a share of its height. */
const TEAR = 19;
const TEETH = 22;
const FONTS: CardFonts = { display: "var(--f-display)", sans: "var(--f-body)" };
/** How long the burst plays before the card turns and settles in the modal. */
const BURST_MS = 1150;
/** The tear finishes itself past this. */
const DONE_AT = 0.96;

const jag = (i: number) => (((i * 37) % 11) - 5) * 0.16;
const zig = (y0: number, y1: number, ltr: boolean) =>
  Array.from({ length: TEETH * 2 + 1 }, (_, i) => {
    const x = (i / (TEETH * 2)) * 100;
    return `${(ltr ? x : 100 - x).toFixed(2)}% ${i % 2 ? y1 : y0}%`;
  });
const tear = (ltr: boolean) =>
  Array.from({ length: 31 }, (_, i) => {
    const x = (i / 30) * 100;
    return `${(ltr ? x : 100 - x).toFixed(2)}% ${(TEAR + jag(ltr ? i : 30 - i)).toFixed(2)}%`;
  });
const STRIP = `polygon(${[...zig(1.6, 0, true), ...tear(false)].join(", ")})`;
const BODY = `polygon(${[...tear(true), ...zig(98.4, 100, false)].join(", ")})`;

const SHARDS = Array.from({ length: 26 }, (_, i) => {
  const a = (i / 26) * Math.PI * 2 + (i % 3) * 0.21;
  const r = 170 + ((i * 53) % 190);
  return {
    "--x": `${(Math.cos(a) * r).toFixed(1)}px`,
    "--y": `${(Math.sin(a) * r * 0.8).toFixed(1)}px`,
    "--r": `${(i * 67) % 360}deg`,
    "--s": `${9 + ((i * 7) % 15)}px`,
    "--d": `${(i % 5) * 45}ms`,
  } as React.CSSProperties;
});

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The card scaled to its box, tilting toward the pointer with a foil sheen. */
const Card = forwardRef<HTMLDivElement, { gem: SpotGem }>(function Card({ gem }, ref) {
  const box = useRef<HTMLDivElement | null>(null);
  const [k, setK] = useState(0.5);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setK(e.contentRect.width / CARD.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const tilt = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse" || reducedMotion()) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    e.currentTarget.style.setProperty("--tx", `${((0.5 - y) * 10).toFixed(2)}deg`);
    e.currentTarget.style.setProperty("--ty", `${((x - 0.5) * 14).toFixed(2)}deg`);
    e.currentTarget.style.setProperty("--shine", `${(x * 100).toFixed(1)}%`);
  };
  const rest = (e: React.PointerEvent<HTMLDivElement>) => {
    for (const p of ["--tx", "--ty", "--shine"]) e.currentTarget.style.removeProperty(p);
  };
  return (
    <div
      ref={(el) => {
        box.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) ref.current = el;
      }}
      className="pk-card"
      onPointerMove={tilt}
      onPointerLeave={rest}
    >
      <div className="pk-card-in" style={{ height: CARD.height * k }}>
        <div style={{ position: "absolute", left: 0, top: 0, transform: `scale(${k})`, transformOrigin: "0 0" }}>
          <SpotCard gem={gem} src={art.avatars[gem.avatar - 1]} fonts={FONTS} />
        </div>
        <span className="pk-card-sheen" aria-hidden />
      </div>
    </div>
  );
});


function Face({ gem }: { gem: SpotGem }) {
  return (
    <div className="pk-face">
      <TesoroMark size={44} />
      <span className="pk-kicker">Early access</span>
      <b className="pk-name">Waitlist pack</b>
      <span className="pk-emblem" aria-hidden>
        ?
      </span>
      <span className="pk-count">1 gemstone animal inside</span>
      <span className="pk-spot mono">Spot #{gem.spot}</span>
    </div>
  );
}

type Phase = "sealed" | "torn" | "open";
type Box = { cx: number; cy: number; long: number };

/**
 * The waitlist reward: a sealed pack in the middle of the screen. Drag along its top to tear it, as
 * far as you drag and no further (Open it for me does it in one go). The strip flies off, the gem's
 * light bursts out in rays and shards, the card rises out upright, then turns flat and settles in a
 * modal with Share and Try it now. Reduced motion opens straight to the card.
 */
export function PackReveal({
  gem,
  shareHref,
  tryHref,
  sealed = true,
  onOpen,
  onClose,
}: {
  gem: SpotGem;
  shareHref: string;
  tryHref: string;
  sealed?: boolean;
  /** Runs once the card shows, so the page can name the gem from then on. */
  onOpen?: () => void;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>(() => (sealed && !reducedMotion() ? "sealed" : "open"));
  const pack = useRef<HTMLDivElement>(null);
  const inside = useRef<HTMLDivElement>(null);
  const shown = useRef<HTMLDivElement>(null);
  const from = useRef<Box | null>(null);
  const ripButton = useRef<HTMLButtonElement>(null);
  const shareLink = useRef<HTMLAnchorElement>(null);
  const drag = useRef<{ x: number; p0: number; moved: boolean } | null>(null);
  const progress = useRef(0);
  const timers = useRef<number[]>([]);

  const setProgress = (p: number) => {
    const el = pack.current;
    const step = Math.floor(p * 8);
    if (el && step > Math.floor(progress.current * 8) && step < 8) {
      el.classList.remove("tick");
      void el.offsetWidth;
      el.classList.add("tick");
      navigator.vibrate?.(6);
    }
    progress.current = p;
    el?.style.setProperty("--p", p.toFixed(3));
  };

  const finish = useCallback(() => {
    if (progress.current > 1) return;
    progress.current = 2;
    setPhase("torn");
    timers.current.push(
      window.setTimeout(() => {
        const r = inside.current?.getBoundingClientRect();
        from.current = r ? { cx: r.left + r.width / 2, cy: r.top + r.height / 2, long: Math.max(r.width, r.height) } : null;
        setPhase("open");
      }, BURST_MS),
    );
  }, []);

  const ripAll = () => {
    if (progress.current >= 1) return;
    const start = progress.current;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 700);
      setProgress(start + (1 - start) * k * k);
      if (k < 1) requestAnimationFrame(step);
      else finish();
    };
    requestAnimationFrame(step);
  };

  useEffect(() => {
    const t = timers.current;
    return () => t.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", onKey);
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
  }, [onClose]);

  useEffect(() => {
    if (phase === "sealed") ripButton.current?.focus({ preventScroll: true });
    if (phase === "open") {
      shareLink.current?.focus({ preventScroll: true });
      onOpen?.();
    }
  }, [phase, onOpen]);

  // The card left the pack upright: it turns flat and grows from there into its place in the modal.
  useLayoutEffect(() => {
    const a = from.current;
    const el = shown.current;
    if (phase !== "open" || !a || !el) return;
    from.current = null;
    const b = el.getBoundingClientRect();
    const dx = a.cx - (b.left + b.width / 2);
    const dy = a.cy - (b.top + b.height / 2);
    el.classList.add("flip");
    el.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) rotate(-90deg) scale(${a.long / b.width})` },
        { transform: `translate(${dx * 0.1}px, ${dy * 0.1}px) rotate(4deg) scale(1.03)`, offset: 0.72, easing: "cubic-bezier(0.3, 0, 0.3, 1)" },
        { transform: "none" },
      ],
      { duration: 1050, easing: "cubic-bezier(0.45, 0.05, 0.3, 1)" },
    );
  }, [phase]);

  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    if (phase !== "sealed") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, p0: progress.current, moved: false };
    pack.current?.classList.add("dragging");
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = pack.current;
    if (!el || phase !== "sealed") return;
    const r = el.getBoundingClientRect();
    if (e.pointerType === "mouse") {
      el.style.setProperty("--mx", `${(((e.clientX - r.left) / r.width) * 100).toFixed(1)}%`);
      el.style.setProperty("--my", `${(((e.clientY - r.top) / r.height) * 100).toFixed(1)}%`);
    }
    const d = drag.current;
    if (!d) {
      if (e.pointerType !== "mouse" || reducedMotion()) return;
      el.style.setProperty("--rx", `${(((r.top + r.height / 2 - e.clientY) / r.height) * 14).toFixed(2)}deg`);
      el.style.setProperty("--ry", `${(((e.clientX - r.left - r.width / 2) / r.width) * 20).toFixed(2)}deg`);
      el.style.setProperty("--sx", `${(((e.clientX - r.left) / r.width) * 60 + 10).toFixed(1)}%`);
      return;
    }
    const dx = e.clientX - d.x;
    if (Math.abs(dx) > 4) d.moved = true;
    const p = Math.min(1, d.p0 + Math.max(0, dx) / (r.width * 0.9));
    if (p > progress.current) setProgress(p);
    if (progress.current >= DONE_AT) {
      drag.current = null;
      el.classList.remove("dragging");
      setProgress(1);
      finish();
    }
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    const el = pack.current;
    el?.classList.remove("dragging");
    if (!d || d.moved || !el || phase !== "sealed") return;
    el.classList.remove("nudge");
    void el.offsetWidth;
    el.classList.add("nudge");
  };
  const leave = () => {
    if (drag.current) return;
    for (const p of ["--rx", "--ry", "--sx", "--mx", "--my"]) pack.current?.style.removeProperty(p);
  };

  return createPortal(
    <div
      className={`pk is-${phase}`}
      style={{ "--gem": gem.hex } as React.CSSProperties}
      role="dialog"
      aria-modal="true"
      aria-labelledby="pk-title"
      onClick={(e) => {
        if (phase === "open" && e.target === e.currentTarget) onClose();
      }}
    >
      <button type="button" className="pk-x" aria-label="Close" onClick={onClose}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
          <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="2" />
        </svg>
      </button>

      {phase !== "open" ? (
        <div className="pk-stage">
          <span className="pk-flash" aria-hidden />
          <span className="pk-rays" aria-hidden />
          <span className="pk-glow" aria-hidden />
          <span className="pk-shards" aria-hidden>
            {SHARDS.map((s, i) => (
              <i key={i} style={s} />
            ))}
          </span>
          <div
            className="pk-pack"
            ref={pack}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            onPointerLeave={leave}
          >
            <div className="pk-tilt">
              <div className="pk-inside" ref={inside} aria-hidden>
                <Card gem={gem} />
              </div>
              <span className="pk-beam" aria-hidden />
              <div className="pk-body" style={{ clipPath: BODY }}>
                <span className="pk-paint" aria-hidden />
                <Face gem={gem} />
              </div>
              <span className="pk-leak" aria-hidden />
              <span className="pk-front" aria-hidden />
              <div className="pk-strip" style={{ clipPath: STRIP }}>
                <span className="pk-paint" aria-hidden />
                <span className="pk-tear-here mono">Tear here</span>
              </div>
            </div>
          </div>
          <span className="pk-shadow" aria-hidden />
          <p className="pk-hint" id="pk-title">
            You&apos;re on the list. Drag along the top to tear your pack open.
          </p>
          <button ref={ripButton} type="button" className="pk-rip" onClick={ripAll} disabled={phase !== "sealed"}>
            Open it for me
          </button>
        </div>
      ) : (
        <div className="pk-open">
          <span className="pk-rays still" aria-hidden />
          <p className="pk-open-kicker mono">Spot #{gem.spot} on the waitlist</p>
          <h2 className="pk-open-title" id="pk-title">
            You pulled the <em>{gem.name}</em>
          </h2>
          <Card gem={gem} ref={shown} />
          <p className="pk-open-note">We&apos;ll email you when your spot opens. Share your card and bring your friends in.</p>
          <div className="pk-open-actions">
            <a ref={shareLink} className="btn neutral cut cut-btn pk-share" href={shareHref} target="_blank" rel="noopener noreferrer">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
                <path
                  fill="currentColor"
                  d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
                />
              </svg>
              Share your card
            </a>
            <a className="btn money cut cut-btn" href={tryHref}>
              Try it now
            </a>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
