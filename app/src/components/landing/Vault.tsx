"use client";

import { Lock, LockOpen } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

const SEGMENTS = 10;
const STILL = 6;

/**
 * A Position as a vault: the raw crystal held in its clasp, yield rising out of it into the Debt meter,
 * and the clasp opening when Debt reaches zero. Loops while in view; a still state under reduced motion.
 */
export function Vault({ locked, open }: { locked: ReactNode; open: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const [step, setStep] = useState(STILL);

  useEffect(() => {
    const el = ref.current;
    if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const io = new IntersectionObserver(([e]) => {
      clearInterval(timer);
      if (e.isIntersecting) timer = setInterval(() => setStep((s) => (s + 1) % (SEGMENTS + 5)), 520);
    });
    io.observe(el);
    return () => (io.disconnect(), clearInterval(timer));
  }, []);

  const repaid = Math.min(step, SEGMENTS);
  const unlocked = repaid === SEGMENTS;
  return (
    <figure ref={ref} className="lp-vault cut cut-frame" data-unlocked={unlocked} aria-label="A Position: the Principal stays locked while its yield repays the Debt; at zero Debt the Position unlocks.">
      <div className="lp-vault-head mono">
        <span>Position</span>
        <span className="lp-vault-state" aria-hidden>
          {unlocked ? <LockOpen /> : <Lock />} {unlocked ? "Unlocked" : "Locked"}
        </span>
      </div>
      <div className="lp-vault-art" aria-hidden>
        {locked}
        {open}
        <span className="lp-vault-rise">
          {Array.from({ length: 7 }, (_, i) => (
            <i key={i} style={{ ["--i" as string]: i }} />
          ))}
        </span>
      </div>
      <div className="lp-vault-row">
        <span className="label">Principal</span>
        <span className="lp-vault-tag mono">never played</span>
      </div>
      <div className="lp-vault-row">
        <span className="label">Debt repaid by yield</span>
        <span className="lp-meter" aria-hidden>
          {Array.from({ length: SEGMENTS }, (_, i) => (
            <i key={i} className={i < repaid ? "on" : undefined} />
          ))}
        </span>
      </div>
    </figure>
  );
}
