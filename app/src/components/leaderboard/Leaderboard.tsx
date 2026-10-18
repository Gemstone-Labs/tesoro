"use client";

import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { AccountLink } from "@/components/account/AccountLink";
import { PlayerAvatar } from "@/components/account/Player";
import { Button, CountUp, GemaMark, GemaUsd } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { art } from "@/lib/art";
import { accountKeyOf } from "@/lib/chain/account-key";
import { seasonStanding, standingSummary, type LastSeason, type LeaderboardRow, type LeaderboardView, type SeasonStanding } from "@/lib/chain/leaderboard-view";
import { useLeaderboard } from "@/lib/chain/useLeaderboard";
import { usePool } from "@/lib/chain/usePool";
import { POINTS_DIVISOR, PRIZE_BPS, PRIZE_PLACES } from "@/lib/chain/season";
import { fmtGemas } from "@/lib/format";
import "./leaderboard.css";

/** Prize of rank `i` from a pool, floored as in the program. */
const prize = (pool: number, i: number) => Math.floor((pool * PRIZE_BPS[i]) / 10_000);

/** Rows per page of the season table. */
const PAGE = 15;
/** Whether the Payout scale band is shown: remembered per browser. */
const PAYOUT_KEY = "tesoro.leaderboard.payout";
const ENTRIES = [500, 1000, 2500] as const;
const SHORT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const ord = (n: number) => {
  const t = n % 100;
  return `${n}${t >= 11 && t <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;
};

const pad = (n: number) => String(n).padStart(2, "0");
function left(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  return `${d > 0 ? `${d}d ` : ""}${pad(h)}h ${pad(m)}m ${pad(s % 60)}s`;
}

/** Seconds on the server's clock, ticking: the page does not trust the visitor's clock. */
function useServerNow(serverNow: number | undefined): number | null {
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
  return now;
}

/** The weekly Leaderboard: the pool, the table, the payout scale and last week's winners. */
export function Leaderboard() {
  const { auth, snapshot } = useAccount();
  const me = snapshot?.accountKey.toBase58() ?? (auth.addresses.solana ? accountKeyOf(auth.addresses.solana) : null);
  const { data, error, retry } = useLeaderboard(me);
  const now = useServerNow(data?.now);

  return (
    <div className="lb">
      <header className="lb-head">
        <h1 className="page-title">Leaderboard</h1>
        <p>Win Matches to earn points. Every week the top ten Players share the prize pool.</p>
      </header>

      {!data ? (
        error ? (
          <div className="mh-state" role="alert">
            <p>The leaderboard couldn’t be loaded.</p>
            <Button size="sm" onClick={retry}>Try again</Button>
          </div>
        ) : (
          <LoadingSkeleton />
        )
      ) : (
        <Loaded data={data} me={me} now={now} stale={error} />
      )}
    </div>
  );
}

/** Loading: the page in outline (the pool banner, the season heading, the table with its real column heads), not a stack of bars. */
function LoadingSkeleton() {
  return (
    <>
      <span className="sr-only" role="status">
        Loading the leaderboard…
      </span>
      <div className="cut cut-frame lb-hero skel" aria-hidden="true">
        <div className="lb-hero-art">
          <span className="lb-skel-chest" />
        </div>
        <div className="lb-hero-copy">
          <span className="skel-line lb-skel-kicker" />
          <span className="skel-line lb-skel-fig" />
          <span className="skel-line lg lb-skel-title" />
          <span className="skel-line lb-skel-text" />
          <span className="lb-hero-chips">
            <span className="lb-skel-chip" />
            <span className="lb-skel-chip short" />
          </span>
        </div>
      </div>
      <section className="lb-season" aria-hidden="true">
        <header className="lb-sec-head lb-season-head">
          <span className="skel-line lb-skel-h" />
        </header>
        <table className="lb-table lb-skel-table">
          <thead>
            <tr>
              <th className="lb-c-rank">#</th>
              <th>Player</th>
              <th className="lb-c-num lb-c-opt">Wins</th>
              <th className="lb-c-num">Points</th>
              <th className="lb-c-num lb-c-opt">Share</th>
              <th className="lb-c-num">Prize</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 10 }, (_, i) => (
              <tr key={i}>
                <td className="lb-c-rank">
                  <span className="skel-line" />
                </td>
                <td>
                  <span className="lb-who">
                    <span className="cut cut-btn avatar lb-avatar skel-av" />
                    <span className="skel-line" style={{ width: `${[52, 44, 60, 48, 40][i % 5]}%` }} />
                  </span>
                </td>
                <td className="lb-c-num lb-c-opt">
                  <span className="skel-line" />
                </td>
                <td className="lb-c-num">
                  <span className="skel-line" />
                </td>
                <td className="lb-c-num lb-c-opt">
                  <span className="skel-line" />
                </td>
                <td className="lb-c-num">
                  <span className="skel-line" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

/** The pool as a banner: the figure huge on the left, the cut-out chest over turning light on the right. */
function Hero({ data, pool, remaining, standing }: { data: LeaderboardView; pool: number; remaining: number | null; standing: SeasonStanding | null }) {
  const faces = data.standings.slice(0, 5);
  return (
    <section className="cut cut-frame lb-hero" aria-label="This season">
      <div className="lb-hero-art" aria-hidden="true">
        <div className="lb-hero-rays" />
        <Image className="lb-hero-chest" src={art.poolChestCut} alt="" width={420} height={420} priority />
      </div>
      <div className="lb-hero-copy">
        <span className="lb-hero-kicker">
          Season {data.season.number} · ends in{" "}
          <b className="mono" aria-live="off">{remaining === null ? "—" : left(remaining)}</b>
        </span>
        <b className="pool-fig lb-hero-fig">
          <CountUp value={pool} duration={1200} />
        </b>
        <span className="lb-hero-title">
          Gemas in the Leaderboard Pool{pool > 0 && <> <GemaUsd value={pool} /></>}
        </span>
        <p>
          {data.feeBps > 0 ? `${data.feeBps / 100}% of every Pot goes in, from every Game.` : "The pool opens with the next upgrade."} The top{" "}
          {PRIZE_PLACES} share it every Monday.
        </p>
        <div className="lb-hero-chips">
          <span className="lb-hero-chip">
            {faces.length > 0 && (
              <span className="lb-hero-faces" aria-hidden="true">
                {faces.map((r) => (
                  <PlayerAvatar key={r.account} account={r.account} size={28} />
                ))}
              </span>
            )}
            <b>{data.players}</b> {data.players === 1 ? "Player" : "Players"} with points
          </span>
          {pool > 0 && (
            <span className="lb-hero-chip">
              1st takes <GemaMark size={14} /> <b>{fmtGemas(prize(pool, 0))}</b> <GemaUsd value={prize(pool, 0)} />
            </span>
          )}
          {standing && (
            <span className="lb-hero-chip lb-hero-you">
              <b>You</b> {standingSummary(standing, data.players, ENTRIES[0] / POINTS_DIVISOR)}
            </span>
          )}
        </div>
        <Button variant="money" href="/play">Play now</Button>
      </div>
    </section>
  );
}

function Loaded({ data, me, now, stale }: { data: LeaderboardView; me: string | null; now: number | null; stale: boolean }) {
  const remaining = now === null ? null : data.season.end - now;
  const pool = usePool() ?? data.poolGemas;
  const standing = me ? seasonStanding(data, me) : null;

  return (
    <>
      {data.settling !== null && (
        <div className="lb-paying" role="status">
          <span className="lb-paying-gem" aria-hidden="true">
            <GemaMark size={16} />
          </span>
          <span>
            <b>Season {data.settling} is paying out</b>
            <span className="lb-paying-sub"> · Season {data.season.number} is on, every win counts</span>
          </span>
        </div>
      )}
      <Hero data={data} pool={pool} remaining={remaining} standing={standing} />

      <Season data={data} pool={pool} me={me} />

      {data.last && <Last last={data.last} me={me} />}

      {stale && <p className="note">Couldn’t refresh; showing what was last loaded.</p>}
      <p className="note">Test mode · Gemas come from simulated yield and have no real value.</p>
    </>
  );
}

function Person({ account }: { account: string }) {
  return (
    <>
      <AccountLink account={account} decorative>
        <span className="cut cut-btn avatar lb-avatar">
          <PlayerAvatar account={account} size={48} />
        </span>
      </AccountLink>
      <AccountLink account={account} className="lb-name" />
    </>
  );
}

/** One line for the closed Payout scale: the top three prizes and what a win is worth. */
function payoutSummary(pool: number): string {
  const wins = `${ENTRIES.map((e) => `+${e / POINTS_DIVISOR}`).join(" / ")} per win`;
  if (pool <= 0) return wins;
  return `1st ${SHORT.format(prize(pool, 0))} · 2nd ${SHORT.format(prize(pool, 1))} · 3rd ${SHORT.format(prize(pool, 2))} · ${wins}`;
}

function readPayout(): boolean {
  try {
    return localStorage.getItem(PAYOUT_KEY) === "on";
  } catch {
    return false;
  }
}

/** This season's table, 15 ranks a page, under the Payout scale band (which the visitor can hide). */
function Season({ data, pool, me }: { data: LeaderboardView; pool: number; me: string | null }) {
  const rows = data.standings;
  // Mounted only once the leaderboard has loaded in the browser, so reading storage here cannot mismatch a server render.
  const [payout, setPayout] = useState(readPayout);
  const [page, setPage] = useState(0);
  const head = useRef<HTMLElement>(null);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const p = Math.min(page, pages - 1);
  const shown = rows.slice(p * PAGE, (p + 1) * PAGE);
  const paid = shown.filter((r) => r.rank <= PRIZE_PLACES);
  const chasing = shown.filter((r) => r.rank > PRIZE_PLACES);
  const line = rows[PRIZE_PLACES - 1]?.points;
  const mine = rows.find((r) => r.account === me);
  const myPage = mine ? Math.floor((mine.rank - 1) / PAGE) : null;

  const toggle = () => {
    setPayout(!payout);
    try {
      localStorage.setItem(PAYOUT_KEY, payout ? "off" : "on");
    } catch {}
  };
  const go = (n: number) => {
    setPage(n);
    const el = head.current;
    if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: "start" });
  };

  return (
    <section className="lb-season" aria-labelledby="lb-table-h">
      <header className="lb-sec-head lb-season-head" ref={head}>
        <h2 id="lb-table-h" className="h-section">Season {data.season.number}</h2>
        <div className="lb-season-tools">
          {mine && myPage !== null && myPage !== p && (
            <Button size="sm" onClick={() => go(myPage)}>
              You’re {ord(mine.rank)}
            </Button>
          )}
          <Button size="sm" aria-expanded={payout} aria-controls="lb-payout" onClick={toggle} icon={<ChevronDown className="lb-chev" size={16} aria-hidden="true" />}>
            Payout scale
          </Button>
        </div>
        {!payout && <p className="lb-pay-sum">{payoutSummary(pool)}</p>}
      </header>

      {payout && <Payout pool={pool} />}

      {rows.length === 0 ? (
        <div className="cut cut-card lb-empty">
          <b>No points yet this season.</b>
          <p>The first win puts you at the top. A won Match earns one point for every {POINTS_DIVISOR} Gemas of entry.</p>
        </div>
      ) : (
        <>
          <table className="lb-table">
            <thead>
              <tr>
                <th className="lb-c-rank" scope="col"><span aria-hidden="true">#</span><span className="sr-only">Rank</span></th>
                <th scope="col">Player</th>
                <th className="lb-c-num lb-c-opt" scope="col">Wins</th>
                <th className="lb-c-num" scope="col">Points</th>
                <th className="lb-c-num lb-c-opt" scope="col">Share</th>
                <th className="lb-c-num" scope="col">Prize</th>
              </tr>
            </thead>
            {paid.length > 0 && (
              <tbody>
                <tr className="lb-group">
                  <th colSpan={6} scope="colgroup">In the prizes</th>
                </tr>
                {paid.map((r) => (
                  <Row key={r.account} r={r} pool={pool} me={me === r.account} />
                ))}
              </tbody>
            )}
            {chasing.length > 0 && (
              <tbody>
                <tr className="lb-group">
                  <th colSpan={6} scope="colgroup">Chasing{line !== undefined && ` · ${line + 1} points gets you in`}</th>
                </tr>
                {chasing.map((r) => (
                  <Row key={r.account} r={r} pool={pool} me={me === r.account} />
                ))}
              </tbody>
            )}
          </table>
          {pages > 1 && <Pager page={p} pages={pages} total={rows.length} go={go} />}
        </>
      )}
    </section>
  );
}

function Row({ r, pool, me }: { r: LeaderboardRow; pool: number; me: boolean }) {
  const paid = r.rank <= PRIZE_PLACES;
  return (
    <tr className={me ? "me" : undefined} aria-current={me ? "true" : undefined}>
      <td className="lb-c-rank">{r.rank}</td>
      <td>
        <span className="lb-who">
          <AccountLink account={r.account} decorative>
            <span className="cut cut-btn avatar lb-avatar">
              <PlayerAvatar account={r.account} size={32} />
            </span>
          </AccountLink>
          <AccountLink account={r.account} className="lb-name" />
          {me && <i className="lb-you">You</i>}
        </span>
      </td>
      <td className="lb-c-num lb-c-opt">{r.wins}</td>
      <td className="lb-c-num lb-c-pts">{r.points}</td>
      <td className="lb-c-num lb-c-opt">{paid ? `${PRIZE_BPS[r.rank - 1] / 100}%` : "—"}</td>
      <td className="lb-c-num">
        {paid ? (
          <span className="lb-prize">
            <GemaMark size={14} />
            <b>{fmtGemas(prize(pool, r.rank - 1))}</b>
            <GemaUsd value={prize(pool, r.rank - 1)} />
          </span>
        ) : (
          <span className="lb-dim">—</span>
        )}
      </td>
    </tr>
  );
}

function Pager({ page, pages, total, go }: { page: number; pages: number; total: number; go: (n: number) => void }) {
  return (
    <nav className="lb-pager" aria-label="Table pages">
      <span className="lb-pager-range">
        Ranks {page * PAGE + 1}–{Math.min(total, (page + 1) * PAGE)} of {total}
      </span>
      <span className="lb-pager-btns">
        <button type="button" className="cut cut-btn btn neutral sm" onClick={() => go(page - 1)} disabled={page === 0} aria-label="Previous page">
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        {Array.from({ length: pages }, (_, i) => (
          <button
            key={i}
            type="button"
            className="cut cut-btn btn neutral sm lb-page"
            onClick={() => go(i)}
            aria-current={i === page ? "page" : undefined}
            aria-label={`Page ${i + 1}`}
          >
            {i + 1}
          </button>
        ))}
        <button type="button" className="cut cut-btn btn neutral sm" onClick={() => go(page + 1)} disabled={page === pages - 1} aria-label="Next page">
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </span>
    </nav>
  );
}

/** How the pool is split (a column per paid rank) and what a win is worth. */
function Payout({ pool }: { pool: number }) {
  return (
    <div id="lb-payout" className="cut cut-card lb-payout">
      <div className="lb-chart">
        <h3 className="pa-h">Payout scale</h3>
        <ol>
          {PRIZE_BPS.map((bps, i) => (
            <li key={i}>
              <span className="lb-col" style={{ height: `${(bps / PRIZE_BPS[0]) * 100}%` }}>
                <small>{bps / 100}%</small>
              </span>
              <b>{i + 1}</b>
              <span className="lb-col-amt">
                <span className="lb-col-full">{fmtGemas(prize(pool, i))}</span>
                <span className="lb-col-short" aria-hidden="true">{SHORT.format(prize(pool, i))}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>
      <div className="lb-rules">
        <h3 className="pa-h">Points per win</h3>
        <dl>
          {ENTRIES.map((e) => (
            <div key={e}>
              <dt>{fmtGemas(e)} entry</dt>
              <dd>+{e / POINTS_DIVISOR}</dd>
            </div>
          ))}
        </dl>
        <p>
          The same in every Game. A loss, a draw or a refund earns none. When a Backer funds the entry, the Player who played gets the points. Ties go to
          whoever won first that week. A season with fewer than ten Players pays only the ranks it has; the rest stays in the pool.
        </p>
      </div>
    </div>
  );
}

function Last({ last, me }: { last: LastSeason; me: string | null }) {
  return (
    <section className="lb-last" aria-labelledby="lb-last-h">
      <header className="lb-sec-head">
        <h2 id="lb-last-h" className="h-section">Season {last.number} winners</h2>
        <span className="lb-last-pool">
          Pool <GemaMark size={16} /> <b>{fmtGemas(last.poolGemas)}</b>
        </span>
      </header>
      {last.winners.length === 0 ? (
        <p className="note">Nobody won a Match that season; the pool carried over.</p>
      ) : (
        <ol className="lb-rows">
          {last.winners.map((w) => (
            <li key={w.account} className={`cut cut-card lb-row paid${me === w.account ? " me" : ""}`}>
              <span className="lb-rank" aria-label={`Rank ${w.rank}`}>{w.rank}</span>
              <span className="lb-who">
                <Person account={w.account} />
                {me === w.account && <i className="lb-you">You</i>}
              </span>
              <span className="lb-num">
                <b>{w.points}</b>
                <small>points</small>
              </span>
              <span className="lb-num lb-wins" />
              <span className="lb-prize">
                <GemaMark size={16} />
                <b>{fmtGemas(w.gemas)}</b>
                {!w.paid && <small>paying</small>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
