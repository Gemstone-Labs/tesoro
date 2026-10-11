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

// Three-quarter view in a 48 box: front faces run x 5–33, the side recedes to x 43 (4 up per 10 across).
const SILHOUETTE = "5,42 5,19 8,14 18,10 40,10 43,15 43,37 33,42 31,44 7,44";
const RIVETS = [[12.5, 41], [25.5, 41], [12.5, 29.6], [25.5, 29.6]];

/** The chest: gold, cut like everything else, a Gema for its lock. `pop` lifts the lid and throws Gemas out. */
export function Chest({ size = 34, pop = 0 }: { size?: number; pop?: number }) {
  const id = useId().replace(/:/g, "");
  const url = (name: string) => `url(#${id}-${name})`;
  return (
    <svg className="chest" width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-front`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffcf5e" />
          <stop offset=".5" stopColor="#efaa2e" />
          <stop offset=".51" stopColor="#d58d1e" />
          <stop offset="1" stopColor="#a8650f" />
        </linearGradient>
        <linearGradient id={`${id}-side`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#c27c18" />
          <stop offset="1" stopColor="#7a4307" />
        </linearGradient>
        <linearGradient id={`${id}-top`} x1="0" y1="1" x2=".4" y2="0">
          <stop offset="0" stopColor="#ffe08a" />
          <stop offset="1" stopColor="#fff6d8" />
        </linearGradient>
        <linearGradient id={`${id}-band`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#7a4307" />
          <stop offset=".45" stopColor="#c98a2a" />
          <stop offset=".55" stopColor="#8f520c" />
          <stop offset="1" stopColor="#5e3305" />
        </linearGradient>
        <linearGradient id={`${id}-mouth`} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#fff8dc" />
          <stop offset="1" stopColor="#ffc548" />
        </linearGradient>
        <radialGradient id={`${id}-glow`}>
          <stop offset="0" stopColor="#fff8d6" />
          <stop offset=".45" stopColor="#ffd46a" stopOpacity=".75" />
          <stop offset="1" stopColor="#ffb52e" stopOpacity="0" />
        </radialGradient>
        <clipPath id={`${id}-shape`}>
          <polygon points={SILHOUETTE} />
        </clipPath>
      </defs>

      <ellipse className="chest-glow" cx="24" cy="20" rx="23" ry="13" fill={url("glow")} />

      <g key={`burst-${pop}`} className={pop ? "chest-burst" : "chest-burst idle"} transform="translate(23 21)">
        {[0, 1, 2].map((i) => (
          <polygon key={i} points={SHARD} fill="url(#gema-face)" />
        ))}
      </g>

      <polygon points={SILHOUETTE} fill="#2e1903" stroke="#2e1903" strokeWidth="1.6" strokeLinejoin="round" />

      {/* body: front, side, the rim, two bands */}
      <polygon points="5,25 33,25 33,42 31,44 7,44 5,42" fill={url("front")} />
      <polygon points="33,25 43,21 43,37 33,42" fill={url("side")} />
      <polygon points="5,25 33,25 33,27.6 5,27.6" fill="#ffe08a" />
      <polygon points="33,25 43,21 43,23.6 33,27.6" fill="#b8741a" />
      <polygon points="11,25 14,25 14,44 11,44" fill={url("band")} />
      <polygon points="24,25 27,25 27,44 24,44" fill={url("band")} />

      {/* the open mouth: hidden under the lid until it lifts */}
      <polygon className="chest-mouth" points="5,25 33,25 43,21 15,21" fill={url("mouth")} />

      <g key={`lid-${pop}`} className={pop ? "chest-lid pop" : "chest-lid"}>
        <polygon points="5,25 5,19 33,19 33,25" fill={url("front")} />
        <polygon points="5,19 8,14 30,14 33,19" fill="#ffd66a" />
        <polygon points="8,14 18,10 40,10 30,14" fill={url("top")} />
        <polygon points="33,25 33,19 30,14 40,10 43,15 43,21" fill={url("side")} />
        <polygon points="30,14 40,10 43,15 33,19" fill="#d9952a" />
        <polygon points="11,25 11,19 14,19 14,25" fill={url("band")} />
        <polygon points="24,25 24,19 27,19 27,25" fill={url("band")} />
        <polygon points="11,19 12,14 15,14 14,19" fill="#a86812" />
        <polygon points="24,19 25,14 28,14 27,19" fill="#a86812" />
        <polygon points="12,14 22,10 25,10 15,14" fill="#c98a2a" />
        <polygon points="25,14 35,10 38,10 28,14" fill="#c98a2a" />
        <polyline points="5,19 8,14 18,10 40,10" fill="none" stroke="#fff8e0" strokeOpacity=".7" strokeWidth=".7" />
        <polyline points="5,25 33,25 43,21" fill="none" stroke="#3d2203" strokeWidth="1.1" />
      </g>

      <g clipPath={url("shape")}>
        <polygon className="chest-shine" points="0,48 7,48 25,0 18,0" fill="#fff" />
      </g>

      {RIVETS.map(([x, y]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r=".8" fill="#ffe7a8" />
      ))}

      <polygon points="17.2,22 20.8,22 22.5,23.7 22.5,28.3 20.8,30 17.2,30 15.5,28.3 15.5,23.7" fill="#3d2203" />
      <polygon points="17.6,22.8 20.4,22.8 21.7,24.1 21.7,27.9 20.4,29.2 17.6,29.2 16.3,27.9 16.3,24.1" fill="url(#gema-face)" />
      <polygon points="18.2,24.2 19.8,24.2 20.4,24.8 20.4,27.2 19.8,27.8 18.2,27.8 17.6,27.2 17.6,24.8" fill="url(#gema-table)" />
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
