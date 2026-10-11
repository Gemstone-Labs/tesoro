"use client";

/* PROTOTYPE ONLY: four takes on the Lobby Leaderboard card (?variant=now|A|B|C|D). Throwaway: the pick gets rewritten into LeaderboardTeaser.tsx. */
import { ArrowRight } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AccountLink } from "@/components/account/AccountLink";
import { PlayerAvatar } from "@/components/account/Player";
import { Button, CountUp, GemaMark } from "@/components/ui";
import { art } from "@/lib/art";
import { shortKey } from "@/lib/chain/history";
import type { LeaderboardRow, LeaderboardView } from "@/lib/chain/leaderboard-view";
import { POINTS_DIVISOR, PRIZE_BPS, PRIZE_PLACES } from "@/lib/chain/season";
import { fmtGemas } from "@/lib/format";
import "./leaderboard-teaser.prototype.css";

export interface TeaserProps {
  data: LeaderboardView;
  pool: number;
  /** Signed-in Account key, if any. */
  me: string | null;
}

const prize = (pool: number, i: number) => Math.floor((pool * (PRIZE_BPS[i] ?? 0)) / 10_000);
const pad = (n: number) => String(n).padStart(2, "0");
const ord = (n: number) => {
  const t = n % 100;
  return `${n}${t >= 11 && t <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;
};
function parts(secs: number | null) {
  const s = Math.max(0, Math.floor(secs ?? 0));
  return { d: Math.floor(s / 86_400), h: Math.floor((s % 86_400) / 3_600), m: Math.floor((s % 3_600) / 60), s: s % 60 };
}
const leftShort = (secs: number | null) => {
  if (secs === null) return "—";
  const t = parts(secs);
  return t.d > 0 ? `${t.d}d ${pad(t.h)}h ${pad(t.m)}m` : `${pad(t.h)}h ${pad(t.m)}m ${pad(t.s)}s`;
};

/** Seconds left in the season on the server's clock, ticking. */
function useRemaining(data: LeaderboardView): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const offset = data.now - Date.now() / 1000;
    const tick = () => setNow(Date.now() / 1000 + offset);
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [data.now]);
  return now === null ? null : data.season.end - now;
}

function Name({ account, className }: { account: string; className?: string }) {
  return (
    <AccountLink account={account} className={className}>
      <b>{shortKey(account)}</b>
    </AccountLink>
  );
}

function SeeAll({ children = "See the table" }: { children?: string }) {
  return (
    <Link href="/leaderboard" className="lbp-see">
      {children} <ArrowRight aria-hidden="true" />
    </Link>
  );
}

/* ——— A · Podium: the top three stand on stepped plinths, each with what they'd take now ——— */
export function TeaserA({ data, pool, me }: TeaserProps) {
  const remaining = useRemaining(data);
  const order = [1, 0, 2]; // 2nd, 1st, 3rd
  const mine = me ? data.standings.find((r) => r.account === me) : undefined;
  return (
    <div className="cut cut-card lbp-a">
      <header className="lbp-a-head">
        <span className="lbp-kicker">
          Season {data.season.number} · ends in <b className="mono">{leftShort(remaining)}</b>
        </span>
        <span className="lbp-a-pool">
          <Image src={art.poolChestCut} alt="" width={44} height={44} />
          <b className="pool-fig">
            <CountUp value={pool} duration={1200} />
          </b>
          <small>in the Pool</small>
        </span>
      </header>
      <ol className="lbp-a-podium">
        {order.map((i) => {
          const r: LeaderboardRow | undefined = data.standings[i];
          return (
            <li key={i} className={`lbp-a-step s${i + 1}`}>
              <div className="lbp-a-who">
                {r ? (
                  <>
                    <AccountLink account={r.account} decorative className="lbp-a-av">
                      <PlayerAvatar account={r.account} size={i === 0 ? 96 : 72} />
                    </AccountLink>
                    <Name account={r.account} className="lbp-a-name" />
                    <span className="lbp-a-pts">{r.points} pts</span>
                  </>
                ) : (
                  <>
                    <span className="lbp-a-av empty" aria-hidden="true" />
                    <span className="lbp-a-name open">Open seat</span>
                    <span className="lbp-a-pts">Win to take it</span>
                  </>
                )}
              </div>
              <div className="lbp-a-plinth">
                <span className="lbp-a-rank">{i + 1}</span>
                <span className="lbp-a-prize">
                  <GemaMark size={14} /> {fmtGemas(prize(pool, i))}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
      <footer className="lbp-a-foot">
        <span>
          {mine ? (
            <>
              You’re <b>{ord(mine.rank)}</b> with {mine.points} pts ·{" "}
            </>
          ) : null}
          4th to {PRIZE_PLACES}th share the other {fmtGemas(pool - prize(pool, 0) - prize(pool, 1) - prize(pool, 2))}
        </span>
        <SeeAll />
      </footer>
    </div>
  );
}

/* ——— B · Vault banner: the Leaderboard hero in miniature, figure left, chest over rays right ——— */
export function TeaserB({ data, pool }: TeaserProps) {
  const remaining = useRemaining(data);
  const top = data.standings.slice(0, 3);
  return (
    <Link href="/leaderboard" className="cut cut-card lbp-b" aria-label={`Leaderboard: ${fmtGemas(pool)} Gemas in the Pool`}>
      <div className="lbp-b-art" aria-hidden="true">
        <div className="lbp-b-rays" />
        <Image className="lbp-b-chest" src={art.poolChestCut} alt="" width={300} height={300} />
      </div>
      <div className="lbp-b-copy">
        <span className="lbp-kicker">
          Season {data.season.number} · ends in <b className="mono">{leftShort(remaining)}</b>
        </span>
        <b className="pool-fig lbp-b-fig">
          <CountUp value={pool} duration={1200} />
        </b>
        <span className="lbp-b-title">Gemas in the Leaderboard Pool</span>
        {top.length > 0 ? (
          <ol className="lbp-b-top">
            {top.map((r) => (
              <li key={r.account} className="lbp-chip">
                <span className="lbp-b-medal">{r.rank}</span>
                <PlayerAvatar account={r.account} size={26} />
                <b>{shortKey(r.account)}</b>
                <span>{r.points} pts</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="lbp-none">No points yet. A win in any game puts you at the top.</p>
        )}
        <span className="lbp-b-cta">
          See the season <ArrowRight aria-hidden="true" />
        </span>
      </div>
    </Link>
  );
}

/* ——— C · Your race: where you stand, who's just ahead, what your spot is worth ——— */
export function TeaserC({ data, pool, me }: TeaserProps) {
  const remaining = useRemaining(data);
  const mine = me ? data.standings.find((r) => r.account === me) : undefined;
  const cut = data.standings[PRIZE_PLACES - 1];
  const ahead = mine && mine.rank > 1 ? data.standings[mine.rank - 2] : undefined;
  // A 1,000-Gema win is worth this many points.
  const perWin = 1000 / POINTS_DIVISOR;
  const neighbours = mine
    ? data.standings.slice(Math.max(0, mine.rank - 2), mine.rank + 1)
    : data.standings.slice(0, 3);
  const top = data.standings[0];
  const span = Math.max(1, top?.points ?? 1);

  return (
    <div className="cut cut-card lbp-c">
      <div className="lbp-c-you">
        <span className="lbp-kicker">{mine ? "Your spot this season" : "Get on the board"}</span>
        {mine ? (
          <>
            <div className="lbp-c-rankline">
              <b className="lbp-c-rank">{ord(mine.rank)}</b>
              <span className="lbp-c-of">of {data.players}</span>
            </div>
            <p className="lbp-c-worth">
              {mine.rank <= PRIZE_PLACES ? (
                <>
                  Worth <GemaMark size={16} /> <b className="pool-fig">{fmtGemas(prize(pool, mine.rank - 1))}</b> if the season ended now
                </>
              ) : (
                <>
                  {cut ? cut.points - mine.points + 1 : 0} pts to reach the top {PRIZE_PLACES}
                </>
              )}
            </p>
            {ahead && (
              <p className="lbp-c-gap">
                <b>{ahead.points - mine.points + 1} pts</b> to pass {ord(ahead.rank)}, about {Math.ceil((ahead.points - mine.points + 1) / perWin)}{" "}
                {Math.ceil((ahead.points - mine.points + 1) / perWin) === 1 ? "win" : "wins"} at 1,000
              </p>
            )}
          </>
        ) : (
          <>
            <b className="lbp-c-rank">{cut ? `${cut.points} pts` : "Any win"}</b>
            <p className="lbp-c-worth">{cut ? `gets you into the top ${PRIZE_PLACES} right now` : "puts you at the top"}</p>
            <p className="lbp-c-gap">A win at 1,000 Gemas is {perWin} pts.</p>
          </>
        )}
        <div className="lbp-c-actions">
          <Button variant="money" href="/play">Play to climb</Button>
          <SeeAll>Full table</SeeAll>
        </div>
      </div>

      <ol className="lbp-c-race" aria-label="Standings near you">
        {neighbours.map((r) => (
          <li key={r.account} className={r.account === me ? "me" : undefined}>
            <span className="lbp-c-n">{r.rank}</span>
            <AccountLink account={r.account} decorative className="lbp-c-av">
              <PlayerAvatar account={r.account} size={36} />
            </AccountLink>
            <div className="lbp-c-bar">
              <span className="lbp-c-name">{r.account === me ? "You" : shortKey(r.account)}</span>
              <i style={{ width: `${Math.max(6, (r.points / span) * 100)}%` }} />
            </div>
            <span className="lbp-c-pts">{r.points}</span>
          </li>
        ))}
      </ol>

      <div className="lbp-c-pool">
        <Image src={art.poolChestCut} alt="" width={96} height={96} />
        <b className="pool-fig">
          <CountUp value={pool} duration={1200} />
        </b>
        <small>
          <span>Gemas in the Pool</span>
          <span>ends in {leftShort(remaining)}</span>
        </small>
      </div>
    </div>
  );
}

/* ——— D · Prize ladder: all ten paid places as columns, sized by their share, with who holds each now ——— */
export function TeaserD({ data, pool, me }: TeaserProps) {
  const remaining = useRemaining(data);
  const t = parts(remaining);
  const clock: [string, number][] = [["d", t.d], ["h", t.h], ["m", t.m], ["s", t.s]];
  const max = PRIZE_BPS[0];
  return (
    <div className="cut cut-card lbp-d">
      <header className="lbp-d-head">
        <div className="lbp-d-pool">
          <span className="lbp-kicker">Season {data.season.number} · Leaderboard Pool</span>
          <b className="pool-fig">
            <CountUp value={pool} duration={1200} />
          </b>
        </div>
        <div className="lbp-d-clock" aria-label="Time left">
          {clock.map(([u, n]) => (
            <span key={u} className="lbp-d-tile">
              <b className="mono">{remaining === null ? "--" : pad(n)}</b>
              <small>{u}</small>
            </span>
          ))}
        </div>
        <SeeAll />
      </header>
      <ol className="lbp-d-ladder">
        {PRIZE_BPS.map((bps, i) => {
          const r = data.standings[i];
          return (
            <li key={i} className={`${i === 0 ? "first" : ""} ${r && r.account === me ? "me" : ""}`}>
              <span className="lbp-d-amt">
                <GemaMark size={12} /> {fmtGemas(prize(pool, i))}
              </span>
              <span className="lbp-d-col" style={{ height: `${Math.round((bps / max) * 100)}%`, animationDelay: `${i * 50}ms` }}>
                <span className="lbp-d-n">{i + 1}</span>
              </span>
              <span className="lbp-d-holder">
                {r ? (
                  <>
                    <AccountLink account={r.account} decorative className="lbp-d-av">
                      <PlayerAvatar account={r.account} size={34} />
                    </AccountLink>
                    <small>{r.account === me ? "You" : `${r.points} pts`}</small>
                  </>
                ) : (
                  <>
                    <span className="lbp-d-av empty" aria-hidden="true" />
                    <small>Open</small>
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
