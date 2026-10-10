"use client";

import Image from "next/image";
import { AccountLink } from "@/components/account/AccountLink";
import { GemaMark, SkeletonCards } from "@/components/ui";
import { avatarFor } from "@/lib/art";
import { shortKey } from "@/lib/chain/history";
import { useLeaderboard } from "@/lib/chain/useLeaderboard";
import { fmtGemas } from "@/lib/format";
import { Rail } from "./Rail";

const days = (secs: number) => {
  const d = Math.floor(secs / 86_400);
  const h = Math.floor((secs % 86_400) / 3_600);
  return d > 0 ? `${d}d ${h}h` : `${h}h ${Math.floor((secs % 3_600) / 60)}m`;
};

/** LEADERBOARD: this week's pool and its top three, linking to the full table. Hidden if the read fails: the Lobby does not depend on it. */
export function LeaderboardTeaser() {
  const { data, error } = useLeaderboard();
  if (!data && error) return null;
  const top = data?.standings.slice(0, 3) ?? [];
  return (
    <Rail id="leaderboard" title="Leaderboard" viewAll="/leaderboard" cols={2} className="lb-teaser">
      {!data ? (
        <SkeletonCards count={1} avatar={false} label="Loading the leaderboard…" />
      ) : (
        <div className="cut cut-card lbt">
          <div className="lbt-pool">
            <span className="label">Season {data.season.number} prize pool</span>
            <b>
              <GemaMark size={26} />
              {fmtGemas(data.poolGemas)}
            </b>
            <small>{days(Math.max(0, data.season.end - data.now))} left · top ten share it</small>
          </div>
          {top.length === 0 ? (
            <p className="lbt-none">No points yet. A win in any game puts you at the top.</p>
          ) : (
            <ol className="lbt-top">
              {top.map((r) => (
                <li key={r.account}>
                  <span className="lbt-rank">{r.rank}</span>
                  <AccountLink account={r.account} decorative className="cut cut-btn avatar lbt-avatar">
                    <Image src={avatarFor(r.account)} alt="" width={40} height={40} />
                  </AccountLink>
                  <AccountLink account={r.account} className="lbt-name">
                    <b>{shortKey(r.account)}</b>
                  </AccountLink>
                  <span className="lbt-pts">{r.points} pts</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </Rail>
  );
}
