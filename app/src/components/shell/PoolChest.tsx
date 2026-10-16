"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { CountUp } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { accountKeyOf } from "@/lib/chain/account-key";
import { seasonStanding, type SeasonStanding } from "@/lib/chain/leaderboard-view";
import { useLeaderboard } from "@/lib/chain/useLeaderboard";
import { usePool } from "@/lib/chain/usePool";
import { fmtGemas } from "@/lib/format";
import "./season-plate.css";

const POP_MS = 1600;
const compact = (n: number) => (n < 10_000 ? fmtGemas(n) : SHORT.format(n));
const SHORT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const SHARD = "-2.5,-4 2.5,-4 4,-2.5 4,2.5 2.5,4 -2.5,4 -4,2.5 -4,-2.5";

// Drawn front-on like the Gema mark: an outer cut, a lighter table inset, cut lines joining their corners.
const SILHOUETTE = "6,38 6,18 11,12 37,12 42,18 42,38 39,41 9,41";
const RIVETS = [[13.5, 27.5], [34.5, 27.5], [13.5, 37.5], [34.5, 37.5]];

/** The chest: gold, cut like the Gema mark, a Gema for its lock. `pop` lifts the lid and throws Gemas out. */
export function Chest({ size = 34, pop = 0 }: { size?: number; pop?: number }) {
  const id = useId().replace(/:/g, "");
  const url = (name: string) => `url(#${id}-${name})`;
  return (
    <svg className="chest" width={size} height={size} viewBox="0 2.5 48 48" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-face`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffe08a" />
          <stop offset=".5" stopColor="#efaa2e" />
          <stop offset="1" stopColor="#9a5a0e" />
        </linearGradient>
        <linearGradient id={`${id}-table`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff4cc" />
          <stop offset="1" stopColor="#f7c04a" />
        </linearGradient>
        <linearGradient id={`${id}-band`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#8f520c" />
          <stop offset=".5" stopColor="#c98a2a" />
          <stop offset="1" stopColor="#6e3d06" />
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

      <ellipse className="chest-glow" cx="24" cy="22" rx="22" ry="12" fill={url("glow")} />

      <g key={`burst-${pop}`} className={pop ? "chest-burst" : "chest-burst idle"} transform="translate(24 22)">
        {[0, 1, 2].map((i) => (
          <polygon key={i} points={SHARD} fill="url(#gema-face)" />
        ))}
      </g>

      <polygon points={SILHOUETTE} fill="#2e1903" stroke="#2e1903" strokeWidth="1.4" strokeLinejoin="round" />

      {/* body */}
      <polygon points="6,24 42,24 42,38 39,41 9,41 6,38" fill={url("face")} />
      <polygon points="10,27 38,27 38,36 36,38 12,38 10,36" fill={url("table")} opacity=".55" />
      <path d="M6 38 10 36M42 38 38 36M9 41 12 38M39 41 36 38" stroke="#5e3305" strokeOpacity=".5" strokeWidth=".7" />
      <rect x="12" y="24" width="3" height="17" fill={url("band")} />
      <rect x="33" y="24" width="3" height="17" fill={url("band")} />

      {/* the open mouth: hidden under the lid until it lifts */}
      <rect className="chest-mouth" x="7" y="21" width="34" height="3" fill="#fff4c8" />

      <g key={`lid-${pop}`} className={pop ? "chest-lid pop" : "chest-lid"}>
        <polygon points="6,24 6,18 11,12 37,12 42,18 42,24" fill={url("face")} />
        <polygon points="12.5,15 35.5,15 38.5,18.6 38.5,21.5 9.5,21.5 9.5,18.6" fill={url("table")} />
        <path d="M6 18 9.5 18.6M11 12 12.5 15M37 12 35.5 15M42 18 38.5 18.6M6 24 9.5 21.5M42 24 38.5 21.5" stroke="#5e3305" strokeOpacity=".5" strokeWidth=".7" />
        <rect x="12" y="12" width="3" height="12" fill={url("band")} />
        <rect x="33" y="12" width="3" height="12" fill={url("band")} />
        <line x1="6" y1="24" x2="42" y2="24" stroke="#3d2203" strokeWidth="1.2" />
      </g>

      <g clipPath={url("shape")}>
        <polygon className="chest-shine" points="0,48 7,48 25,0 18,0" fill="#fff" />
      </g>

      {RIVETS.map(([x, y]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r=".8" fill="#ffe7a8" />
      ))}

      {/* the lock is the Gema mark itself, on a dark plate */}
      <polygon points="20.5,19.5 27.5,19.5 30,22 30,28 27.5,30.5 20.5,30.5 18,28 18,22" fill="#3d2203" />
      <g transform="translate(18.75 20.25) scale(.4375)">
        <polygon points="7,3 17,3 22,8 22,16 17,21 7,21 2,16 2,8" fill="url(#gema-face)" />
        <polygon points="9,7 15,7 18,10 18,14 15,17 9,17 6,14 6,10" fill="url(#gema-table)" />
        <path d="M7 3 9 7M17 3 15 7M22 8 18 10M22 16 18 14M17 21 15 17M7 21 9 17M2 16 6 14M2 8 6 10" stroke="#063D2C" strokeOpacity=".45" strokeWidth="1" fill="none" />
      </g>
    </svg>
  );
}

const ordinal = (n: number) => {
  const v = n % 100;
  return `${n}${["th", "st", "nd", "rd"][(v - 20) % 10] || ["th", "st", "nd", "rd"][v] || "th"}`;
};
const pts = (n: number) => `${n} ${n === 1 ? "pt" : "pts"}`;

/** The next step up, in one short line. */
function nextStep(s: SeasonStanding) {
  if (s.rank === null) return null;
  if (s.toPrizes > 0) return `${pts(s.toPrizes)} to the prizes`;
  if (s.toNext === null) return "Top of the board";
  return `${pts(s.toNext)} to ${ordinal(s.rank - 1)}`;
}

/**
 * Top bar: the Season plate. The Leaderboard Pool (gold, live, opens with a burst whenever it grows) and, signed in,
 * the Player's own rank and Season points beside it in steel. One link to the Leaderboard.
 */
export function PoolChest() {
  const pool = usePool();
  const { auth, snapshot } = useAccount();
  const me = auth.status === "signed-in" ? (snapshot?.accountKey.toBase58() ?? (auth.addresses.solana ? accountKeyOf(auth.addresses.solana) : null)) : null;
  const { data, forMe, error } = useLeaderboard(me);
  const standing = me && forMe && data && data.feeBps > 0 ? seasonStanding(data, me) : null;
  // Signed in (or not known yet) and your standing not read for you yet: its place waits as a placeholder.
  const youPending = !standing && !error && data?.feeBps !== 0 && (auth.status === "loading" || (auth.status === "signed-in" && !forMe));
  const [pop, setPop] = useState(0);
  const last = useRef<number | null>(null);

  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const before = last.current;
    last.current = pool ?? null;
    if (pool == null || before == null || pool <= before) return;
    const start = setTimeout(() => setPop((n) => n + 1), 0);
    clearTimeout(settle.current);
    settle.current = setTimeout(() => setPop(0), POP_MS);
    return () => clearTimeout(start);
  }, [pool]);
  useEffect(() => () => clearTimeout(settle.current), []);

  if (pool === undefined) return <PlateSkeleton you={youPending} />;
  if (pool === null) return null;
  const you = standing
    ? standing.rank === null
      ? " You have no Season points yet."
      : ` You're ${ordinal(standing.rank)} with ${pts(standing.points)}.`
    : "";
  return (
    <Link
      href="/leaderboard"
      className={`cut cut-card pchest${pop ? " pop" : ""}`}
      aria-label={`Leaderboard Pool: ${fmtGemas(pool)} Gemas.${you} Open Leaderboard`}
      title="Leaderboard Pool · the top ten share it when the Season ends"
    >
      <Chest pop={pop} />
      <div className="pc-pool">
        <b className="pc-full">
          <CountUp value={pool} duration={1200} />
        </b>
        <b className="pc-short">
          <CountUp value={pool} duration={1200} format={compact} />
        </b>
        <span>Pool{data && ` · Season ${data.season.number}`}</span>
      </div>
      {youPending && <YouSkeleton />}
      {standing && standing.points > 0 && (
        <div className={`pc-you${standing.rank === null ? " none" : ""}`}>
          <div className={`pc-rank${standing.rank !== null && standing.rank >= 10 ? " wide" : ""}`}>
            {standing.rank === null ? "–" : <><small>#</small>{standing.rank}</>}
          </div>
          <div className="pc-you-txt">
            <strong><CountUp value={standing.points} /> <small>pts</small></strong>
            {standing.rank !== null && <small>{nextStep(standing)}</small>}
          </div>
        </div>
      )}
    </Link>
  );
}

/** Your rank and points while they load. Divs, not spans: the phone plate hides its spans. */
function YouSkeleton() {
  return (
    <div className="pc-you pc-you-skel" aria-hidden="true">
      <div className="pc-rank skel" />
      <div className="pc-you-txt">
        <div className="skel-line lg" style={{ width: 52 }} />
        <div className="skel-line" style={{ width: 76 }} />
      </div>
    </div>
  );
}

/** The plate while the Pool is read. */
function PlateSkeleton({ you }: { you: boolean }) {
  return (
    <div className="cut cut-card pchest skel" aria-hidden="true">
      <div className="pc-chest-skel" />
      <div className="pc-pool">
        <div className="skel-line lg" style={{ width: 78 }} />
        <div className="skel-line pc-skel-label" style={{ width: 92 }} />
      </div>
      {you && <YouSkeleton />}
    </div>
  );
}
