"use client";

import { ArrowRight } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { PlayerAvatar } from "@/components/account/Player";
import { CountUp, SkeletonCards } from "@/components/ui";
import { art } from "@/lib/art";
import { shortKey } from "@/lib/chain/history";
import { useLeaderboard } from "@/lib/chain/useLeaderboard";
import { usePool } from "@/lib/chain/usePool";
import { Rail } from "./Rail";

const pad = (n: number) => String(n).padStart(2, "0");
function left(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  return d > 0 ? `${d}d ${pad(h)}h ${pad(m)}m` : `${pad(h)}h ${pad(m)}m ${pad(s % 60)}s`;
}

/** Seconds until `end` on the server's clock (`serverNow`), ticking; null until mounted. */
function useRemaining(serverNow: number | undefined, end: number | undefined): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (serverNow === undefined) return;
    const offset = serverNow - Date.now() / 1000;
    const tick = () => setNow(Date.now() / 1000 + offset);
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [serverNow]);
  return now === null || end === undefined ? null : end - now;
}

/** LEADERBOARD: the Leaderboard hero in miniature, the Pool figure left, the chest over turning light right, the top three as chips. The whole card opens the Leaderboard. Hidden if the read fails: the Lobby does not depend on it. */
export function LeaderboardTeaser() {
  const { data, error } = useLeaderboard();
  const live = usePool();
  const remaining = useRemaining(data?.now, data?.season.end);
  if (!data && error) return null;
  const top = data?.standings.slice(0, 3) ?? [];
  return (
    <Rail id="leaderboard" title="Leaderboard" cols={2} className="lb-teaser">
      {!data ? (
        <SkeletonCards count={1} avatar={false} label="Loading the leaderboard…" />
      ) : (
        <Link href="/leaderboard" className="cut cut-card lbt">
          <div className="lbt-art" aria-hidden="true">
            <div className="lbt-rays" />
            <Image className="lbt-chest" src={art.poolChestCut} alt="" width={300} height={300} />
          </div>
          <div className="lbt-copy">
            <span className="lbt-kicker">
              Season {data.season.number} · ends in <b className="mono">{remaining === null ? "—" : left(remaining)}</b>
            </span>
            <b className="pool-fig lbt-fig">
              <CountUp value={live ?? data.poolGemas} duration={1200} />
            </b>
            <span className="lbt-title">Gemas in the Leaderboard Pool</span>
            {top.length === 0 ? (
              <p className="lbt-none">No points yet. A win in any game puts you at the top.</p>
            ) : (
              <ol className="lbt-top">
                {top.map((r) => (
                  <li key={r.account}>
                    <span className="lbt-rank">{r.rank}</span>
                    <PlayerAvatar account={r.account} size={26} />
                    <b>{shortKey(r.account)}</b>
                    <span>{r.points} pts</span>
                  </li>
                ))}
              </ol>
            )}
            <span className="lbt-cta">
              See the season <ArrowRight aria-hidden="true" />
            </span>
          </div>
        </Link>
      )}
    </Rail>
  );
}
