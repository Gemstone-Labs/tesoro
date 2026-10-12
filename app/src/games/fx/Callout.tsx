"use client";

import { useEffect, useRef } from "react";

export type CalloutTone = "plain" | "up" | "down" | "gem" | "warn";

/**
 * A short punchy line that scales in and fades ("Double!", "Flop", "Long 5x opened"). Sits in the
 * middle of the nearest positioned parent and ignores the pointer. Change `key` to replay it for a
 * new moment; `onDone` fires after `duration` ms so the parent can clear it. Announced politely;
 * under reduced motion it just shows for the same time. `tone="gem"` is emerald: only where Gemas move.
 */
export function Callout({ text, tone = "plain", duration = 1100, onDone, className = "" }: { text: string; tone?: CalloutTone; duration?: number; onDone?: () => void; className?: string }) {
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  const timed = !!onDone;
  useEffect(() => {
    if (!timed) return;
    const t = setTimeout(() => done.current?.(), duration);
    return () => clearTimeout(t);
  }, [text, duration, timed]);
  return (
    <div className={`fx-callout-host ${className}`} role="status" aria-live="polite" style={{ "--fx-dur": `${duration}ms` } as React.CSSProperties}>
      <span key={text} className={`cut fx-callout ${tone}`}>
        {text}
      </span>
    </div>
  );
}
