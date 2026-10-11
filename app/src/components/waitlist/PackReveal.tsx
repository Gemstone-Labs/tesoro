"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TesoroMark } from "@/components/brand";
import { art } from "@/lib/art";
import type { SpotGem } from "@/lib/waitlist-spot";
import { CARD, SpotCard, type CardFonts, type CardVariant } from "./SpotCard";

/** Where the pack tears, as a share of its height. */
const TEAR = 19;
const TEETH = 22;
const FONTS: CardFonts = { display: "var(--f-display)", sans: "var(--f-body)" };
/** How long the burst plays before the card settles in the modal. */
const BURST_MS = 1250;

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
function Card({ gem, variant }: { gem: SpotGem; variant: CardVariant }) {
  const box = useRef<HTMLDivElement>(null);
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
    <div className="pk-card" ref={box} onPointerMove={tilt} onPointerLeave={rest}>
      <div className="pk-card-in" style={{ height: CARD.height * k }}>
        <div style={{ position: "absolute", left: 0, top: 0, transform: `scale(${k})`, transformOrigin: "0 0" }}>
          <SpotCard gem={gem} src={art.avatars[gem.avatar - 1]} variant={variant} fonts={FONTS} />
        </div>
        <span className="pk-card-sheen" aria-hidden />
      </div>
    </div>
  );
}

type Phase = "sealed" | "torn" | "open";

/**
 * The waitlist reward: a sealed pack in the middle of the screen. Drag across its top (or tap it, or
 * press Rip it open) to tear it; the strip flies off, the gem's light bursts out in rays and shards,
 * and the card settles in a modal with Share and Try it now. Reduced motion opens straight to the card.
 */
export function PackReveal({
  gem,
  variant,
  shareHref,
  tryHref,
  sealed = true,
  onClose,
}: {
  gem: SpotGem;
  variant: CardVariant;
  shareHref: string;
  tryHref: string;
  sealed?: boolean;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>(() => (sealed && !reducedMotion() ? "sealed" : "open"));
  const pack = useRef<HTMLDivElement>(null);
  const ripButton = useRef<HTMLButtonElement>(null);
  const shareLink = useRef<HTMLAnchorElement>(null);
  const drag = useRef<{ x: number; moved: boolean } | null>(null);
  const progress = useRef(0);
  const timers = useRef<number[]>([]);

  const setProgress = (p: number) => {
    progress.current = p;
    pack.current?.style.setProperty("--p", p.toFixed(3));
  };

  const finish = useCallback(() => {
    setPhase("torn");
    timers.current.push(window.setTimeout(() => setPhase("open"), BURST_MS));
  }, []);

  const rip = useCallback(() => {
    if (phase !== "sealed") return;
    const from = progress.current;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 380);
      setProgress(from + (1 - from) * (1 - (1 - k) ** 3));
      if (k < 1) requestAnimationFrame(step);
      else finish();
    };
    requestAnimationFrame(step);
  }, [phase, finish]);

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
    if (phase === "open") shareLink.current?.focus({ preventScroll: true });
  }, [phase]);

  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    if (phase !== "sealed") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, moved: false };
    pack.current?.classList.add("dragging");
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = pack.current;
    if (!el || phase !== "sealed") return;
    if (!drag.current) {
      if (e.pointerType !== "mouse" || reducedMotion()) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty("--rx", `${(((r.top + r.height / 2 - e.clientY) / r.height) * 14).toFixed(2)}deg`);
      el.style.setProperty("--ry", `${(((e.clientX - r.left - r.width / 2) / r.width) * 20).toFixed(2)}deg`);
      el.style.setProperty("--sx", `${(((e.clientX - r.left) / r.width) * 60 + 10).toFixed(1)}%`);
      return;
    }
    const dx = Math.abs(e.clientX - drag.current.x);
    if (dx > 6) drag.current.moved = true;
    setProgress(Math.min(1, dx / (el.offsetWidth * 0.85)));
    if (progress.current >= 1) {
      drag.current = null;
      el.classList.remove("dragging");
      finish();
    }
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    pack.current?.classList.remove("dragging");
    if (!d || phase !== "sealed") return;
    if (!d.moved || progress.current > 0.45) rip();
    else setProgress(0);
  };
  const leave = () => {
    if (drag.current) return;
    for (const p of ["--rx", "--ry", "--sx"]) pack.current?.style.removeProperty(p);
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
          <div className="pk-pack" ref={pack} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={leave}>
            <div className="pk-tilt">
              <div className="pk-rising" aria-hidden>
                <Card gem={gem} variant={variant} />
              </div>
              <span className="pk-beam" aria-hidden />
              <div className="pk-body" style={{ clipPath: BODY }}>
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
              </div>
              <span className="pk-leak" aria-hidden />
              <div className="pk-strip" style={{ clipPath: STRIP }}>
                <span className="pk-tear-here mono">Tear here</span>
              </div>
            </div>
          </div>
          <span className="pk-shadow" aria-hidden />
          <p className="pk-hint" id="pk-title">
            You&apos;re on the list. Swipe across the top to open your pack.
          </p>
          <button ref={ripButton} type="button" className="pk-rip" onClick={rip} disabled={phase !== "sealed"}>
            Rip it open
          </button>
        </div>
      ) : (
        <div className="pk-open">
          <span className="pk-rays still" aria-hidden />
          <p className="pk-open-kicker mono">Spot #{gem.spot} on the waitlist</p>
          <h2 className="pk-open-title" id="pk-title">
            You pulled the <em>{gem.name}</em>
          </h2>
          <Card gem={gem} variant={variant} />
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
