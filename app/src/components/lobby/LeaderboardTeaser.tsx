"use client";

import { ArrowRight } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { PlayerAvatar } from "@/components/account/Player";
import { CountUp } from "@/components/ui";
import { art } from "@/lib/art";
import { shortKey } from "@/lib/chain/history";
import { poolIsQuiet } from "@/lib/chain/leaderboard-view";
import { useLeaderboard } from "@/lib/chain/useLeaderboard";
import { left, useSeasonRemaining } from "@/lib/chain/useSeasonRemaining";
import { usePool } from "@/lib/chain/usePool";
import { Rail } from "./Rail";

/** LEADERBOARD: the Leaderboard hero in miniature, the Pool figure left, the chest over turning light right, the top three as chips. The whole card opens the Leaderboard. Hidden if the read fails: the Lobby does not depend on it. */
export function LeaderboardTeaser() {
  const { data, error } = useLeaderboard();
  const live = usePool();
  const remaining = useSeasonRemaining(data?.now, data?.season.end);
  if (!data && error) return null;
  const pool = live ?? data?.poolGemas ?? 0;
  const quiet = poolIsQuiet(pool);
  const top = data?.standings.slice(0, 3) ?? [];
  return (
    <Rail id="leaderboard" title="Leaderboard" cols={2} className="lb-teaser">
      {!data ? (
        <TeaserSkeleton />
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
            {!quiet && (
              <>
                <b className="pool-fig lbt-fig">
                  <CountUp value={pool} duration={1200} />
                </b>
                <span className="lbt-title">Gemas in the Leaderboard Pool</span>
              </>
            )}
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

/** Loading: the teaser in outline (season line, Pool figure, title, top three, chest), not a row of bars. */
function TeaserSkeleton() {
  return (
    <>
      <span className="sr-only" role="status">
        Loading the leaderboard…
      </span>
      <div className="cut cut-card lbt skel" aria-hidden="true">
        <div className="lbt-art">
          <span className="lbt-skel-chest" />
        </div>
        <div className="lbt-copy">
          <span className="skel-line lbt-skel-kicker" />
          <span className="skel-line lbt-skel-fig" />
          <span className="skel-line lg lbt-skel-title" />
          <span className="lbt-top">
            {[0, 1, 2].map((i) => (
              <span key={i} className="lbt-skel-chip" />
            ))}
          </span>
          <span className="skel-line lbt-skel-cta" />
        </div>
      </div>
    </>
  );
}
