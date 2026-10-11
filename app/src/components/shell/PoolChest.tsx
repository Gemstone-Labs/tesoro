"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { CountUp } from "@/components/ui";
import { usePool } from "@/lib/chain/usePool";
import { fmtGemas } from "@/lib/format";

const POP_MS = 1600;
const compact = (n: number) => (n < 10_000 ? fmtGemas(n) : SHORT.format(n));
const SHORT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const SHARD = "-2.5,-4 2.5,-4 4,-2.5 4,2.5 2.5,4 -2.5,4 -4,2.5 -4,-2.5";

/** The chest: gold, cut like everything else, a Gema for its lock. `pop` lifts the lid and throws Gemas out. */
export function Chest({ size = 34, pop = 0 }: { size?: number; pop?: number }) {
  const id = useId().replace(/:/g, "");
  const shape = `${id}-shape`;
  return (
    <svg className="chest" width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-body`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffd774" />
          <stop offset=".42" stopColor="#f2b23a" />
          <stop offset=".43" stopColor="#d48b1d" />
          <stop offset="1" stopColor="#9a5a0e" />
        </linearGradient>
        <linearGradient id={`${id}-lid`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff2c2" />
          <stop offset=".34" stopColor="#f9cb55" />
          <stop offset=".35" stopColor="#e7a52c" />
          <stop offset="1" stopColor="#b8741a" />
        </linearGradient>
        <linearGradient id={`${id}-band`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#a8650f" />
          <stop offset="1" stopColor="#6e3d06" />
        </linearGradient>
        <radialGradient id={`${id}-glow`}>
          <stop offset="0" stopColor="#fff8d6" />
          <stop offset=".45" stopColor="#ffd46a" stopOpacity=".75" />
          <stop offset="1" stopColor="#ffb52e" stopOpacity="0" />
        </radialGradient>
        <clipPath id={shape}>
          <polygon points="7,24 7,17 11,11 37,11 41,17 41,39 37,43 11,43 7,39" />
        </clipPath>
      </defs>

      <ellipse className="chest-glow" cx="24" cy="22" rx="22" ry="12" fill={`url(#${id}-glow)`} />

      <g key={`burst-${pop}`} className={pop ? "chest-burst" : "chest-burst idle"} transform="translate(24 22)">
        {[0, 1, 2].map((i) => (
          <polygon key={i} points={SHARD} fill="url(#gema-face)" />
        ))}
      </g>

      <polygon points="7,24 41,24 41,39 37,43 11,43 7,39" fill={`url(#${id}-body)`} />
      <rect x="13" y="24" width="4" height="19" fill={`url(#${id}-band)`} />
      <rect x="31" y="24" width="4" height="19" fill={`url(#${id}-band)`} />
      <rect x="7" y="24" width="34" height="2.2" fill="#6e3d06" opacity=".55" />

      <rect className="chest-mouth" x="8" y="22" width="32" height="3" fill="#fff4c8" />
      <g key={`lid-${pop}`} className={pop ? "chest-lid pop" : "chest-lid"}>
        <polygon points="7,24 7,17 11,11 37,11 41,17 41,24" fill={`url(#${id}-lid)`} />
        <polygon points="11,11 37,11 39.4,14.5 8.6,14.5" fill="#fff8de" opacity=".55" />
        <rect x="13" y="11" width="4" height="13" fill={`url(#${id}-band)`} />
        <rect x="31" y="11" width="4" height="13" fill={`url(#${id}-band)`} />
      </g>

      <g clipPath={`url(#${shape})`}>
        <polygon className="chest-shine" points="0,48 8,48 26,0 18,0" fill="#fff" />
      </g>

      <polygon points="21,21 27,21 29,23 29,28 27,30 21,30 19,28 19,23" fill="#5a3205" />
      <polygon points="21.6,22 26.4,22 28,23.6 28,27.4 26.4,29 21.6,29 20,27.4 20,23.6" fill="url(#gema-face)" />
      <polygon points="22.6,23.6 25.4,23.6 26.4,24.6 26.4,26.4 25.4,27.4 22.6,27.4 21.6,26.4 21.6,24.6" fill="url(#gema-table)" />
    </svg>
  );
}

/** Top bar: the Leaderboard Pool beside the balance, live. Opens with a burst whenever it grows. */
export function PoolChest() {
  const pool = usePool();
  const [pop, setPop] = useState(0);
  const last = useRef<number | null>(null);

  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const before = last.current;
    last.current = pool;
    if (pool == null || before == null || pool <= before) return;
    const start = setTimeout(() => setPop((n) => n + 1), 0);
    clearTimeout(settle.current);
    settle.current = setTimeout(() => setPop(0), POP_MS);
    return () => clearTimeout(start);
  }, [pool]);
  useEffect(() => () => clearTimeout(settle.current), []);

  if (pool == null) return null;
  return (
    <Link
      href="/leaderboard"
      className={`cut cut-card pchest${pop ? " pop" : ""}`}
      aria-label={`Leaderboard Pool: ${fmtGemas(pool)} Gemas, open Leaderboard`}
      title="Leaderboard Pool · the top ten share it when the Season ends"
    >
      <Chest pop={pop} />
      <b className="pc-full">
        <CountUp value={pool} duration={1200} />
      </b>
      <b className="pc-short">
        <CountUp value={pool} duration={1200} format={compact} />
      </b>
      <span>Pool</span>
    </Link>
  );
}
