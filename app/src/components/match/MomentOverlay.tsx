"use client";

import { useEffect, useState } from "react";
import { Bust, GemaMark, type BustName } from "@/components/ui";
import { fmtGemas } from "@/lib/format";

const SHOW_MS = 3000;

/** Faceted emerald shards behind the bust. Decorative. */
function Burst() {
  const shards = Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * Math.PI * 2;
    const w = 0.08 + (i % 3) * 0.03;
    const r = 250 + (i % 4) * 40;
    const p = (ang: number) => `${300 + Math.cos(ang) * r},${300 + Math.sin(ang) * r}`;
    return <polygon key={i} points={`300,300 ${p(a - w)} ${p(a + w)}`} fill="url(#mo-ray)" opacity={0.6 - (i % 3) * 0.14} />;
  });
  const sparks = [[110, 150], [500, 120], [540, 330], [90, 380], [430, 520], [170, 500], [300, 40]];
  return (
    <svg className="mo-burst" viewBox="0 0 600 600" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="mo-ray" cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#63f7d3" stopOpacity=".6" />
          <stop offset="1" stopColor="#0cbc8c" stopOpacity="0" />
        </radialGradient>
      </defs>
      {shards}
      {sparks.map(([x, y], i) => (
        <polygon key={i} points={`${x},${y - 8} ${x + 5},${y} ${x},${y + 8} ${x - 5},${y}`} fill="#8ff5cf" opacity={0.85} />
      ))}
    </svg>
  );
}

/**
 * A short celebration over the result: the bust and the Gema burst for ~3 s, or until clicked. The
 * result underneath has no character. Shown once per `momentKey` per browser tab.
 */
export function MomentOverlay({ bust, title, amount, momentKey }: { bust: BustName; title: string; amount: number; momentKey?: string }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const k = momentKey ? `tesoro-moment:${momentKey}` : null;
    try {
      if (k && sessionStorage.getItem(k)) return;
      if (k) sessionStorage.setItem(k, "1");
    } catch {
      // no storage: it shows once per page load
    }
    const open = setTimeout(() => setShow(true), 0);
    const close = setTimeout(() => setShow(false), SHOW_MS);
    return () => {
      clearTimeout(open);
      clearTimeout(close);
    };
  }, [momentKey]);

  if (!show) return null;
  return (
    <div className="mo" role="status" aria-label={`${title}. ${fmtGemas(amount)} Gemas. Click to dismiss.`} onClick={() => setShow(false)}>
      <div className="mo-stage">
        <Burst />
        <Bust name={bust} width={bust === "duoWin" ? 520 : 300} className="mo-bust" priority />
      </div>
      <div className="mo-text">
        <b>{title}</b>
        <span>
          <GemaMark size={30} /> +{fmtGemas(amount)} Gemas
        </span>
      </div>
    </div>
  );
}
