"use client";

import { useCallback, useEffect, useRef } from "react";

/** Own delayed feedback so a replay or route change cannot leave effects from the previous run. */
export function useTransientEffects() {
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const animations = useRef(new Map<Animation, () => void>());
  const reset = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current.clear();
    animations.current.forEach((cleanup, animation) => { animation.cancel(); cleanup(); });
    animations.current.clear();
  }, []);
  useEffect(() => reset, [reset]);
  const later = useCallback((callback: () => void, ms: number) => {
    const timer = setTimeout(() => { timers.current.delete(timer); callback(); }, ms);
    timers.current.add(timer);
  }, []);
  const animate = useCallback((element: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions, cleanup = () => {}) => {
    // Consecutive impacts replace this element's previous kick rather than accumulating transforms.
    for (const [animation, done] of animations.current) {
      if ((animation.effect as KeyframeEffect | null)?.target === element) {
        animation.cancel(); done(); animations.current.delete(animation);
      }
    }
    if (typeof element.animate !== "function") { cleanup(); return; }
    const animation = element.animate(frames, options);
    animations.current.set(animation, cleanup);
    animation.onfinish = animation.oncancel = () => { animations.current.delete(animation); cleanup(); };
  }, []);
  return { later, animate, reset };
}
