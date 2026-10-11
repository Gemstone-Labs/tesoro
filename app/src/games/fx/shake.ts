import { prefersReducedMotion } from "./reduced-motion";

/**
 * Jolt an element (the board on a big clear). `strength` 0..1: 0.3 a nudge, 1 a slam. Uses the Web
 * Animations API, so no React state; no-op under reduced motion. `shake(boardEl, 0.6)`.
 */
export function shake(el: HTMLElement | null, strength = 0.5): void {
  if (!el || prefersReducedMotion() || typeof el.animate !== "function") return;
  const s = Math.max(0, Math.min(1, strength));
  const px = 2 + s * 9;
  const deg = 0.2 + s * 1.2;
  el.animate(
    [
      { transform: "translate(0, 0) rotate(0)" },
      { transform: `translate(${-px}px, ${px * 0.4}px) rotate(${-deg}deg)`, offset: 0.15 },
      { transform: `translate(${px * 0.85}px, ${-px * 0.5}px) rotate(${deg * 0.8}deg)`, offset: 0.35 },
      { transform: `translate(${-px * 0.5}px, ${px * 0.25}px) rotate(${-deg * 0.5}deg)`, offset: 0.55 },
      { transform: `translate(${px * 0.25}px, 0) rotate(${deg * 0.2}deg)`, offset: 0.78 },
      { transform: "translate(0, 0) rotate(0)" },
    ],
    { duration: 260 + s * 260, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)" },
  );
}
