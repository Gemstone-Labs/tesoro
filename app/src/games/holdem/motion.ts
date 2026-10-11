import { prefersReducedMotion } from "../fx";

/** Slides `el` from where `from` is on screen to where it sits now (a card leaving the deck, a chip changing seat). */
export function flyFrom(el: HTMLElement, from: { x: number; y: number }, opts: { delay?: number; duration?: number; spin?: number; scale?: number } = {}) {
  if (prefersReducedMotion() || typeof el.animate !== "function") return;
  const r = el.getBoundingClientRect();
  const dx = from.x - (r.left + r.width / 2);
  const dy = from.y - (r.top + r.height / 2);
  el.animate(
    [
      { transform: `translate(${dx}px, ${dy}px) rotate(${opts.spin ?? -24}deg) scale(${opts.scale ?? 0.55})`, opacity: 0.2 },
      { opacity: 1, offset: 0.25 },
      { transform: "translate(0, 0) rotate(0deg) scale(1)", opacity: 1 },
    ],
    { duration: opts.duration ?? 440, delay: opts.delay ?? 0, easing: "cubic-bezier(0.18, 0.8, 0.25, 1)", fill: "backwards" },
  );
}

export const centre = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
