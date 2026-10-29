"use client";

import { ChevronLeft, ChevronRight, Info } from "lucide-react";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AccountLink } from "@/components/account/AccountLink";
import { PlayerAvatar } from "@/components/account/Player";
import { Ink } from "@/components/ui/Ink";
import { Button, CountUp, GemaMark, GemaUsd, Sheet } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { ENTRY_SIZES } from "@/lib/cluster-settings";
import { art } from "@/lib/art";
import { accountKeyOf } from "@/lib/chain/account-key";
import { lastRankNote, type LastSeason, type LeaderboardRow, type LeaderboardView } from "@/lib/chain/leaderboard-view";
import { useLeaderboard } from "@/lib/chain/useLeaderboard";
import { usePool } from "@/lib/chain/usePool";
import { POINTS_DIVISOR, PRIZE_BPS, PRIZE_PLACES } from "@/lib/chain/season";
import { PAGE_SIZE, PODIUM, pageCount, pageFromParam, pageItems, pageOfRank, pageRows, paramForPage, rankRange } from "@/lib/chain/leaderboard-paging";
import { fmtGemas } from "@/lib/format";
import "./leaderboard.css";

/** Prize of rank `i` from a pool, floored as in the program. */
const prize = (pool: number, i: number) => Math.floor((pool * PRIZE_BPS[i]) / 10_000);

const ENTRIES = ENTRY_SIZES;
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
  return d > 0 ? `${d}d ${pad(h)}h ${pad(m)}m` : `${pad(h)}h ${pad(m)}m ${pad(s % 60)}s`;
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
      <h1 className="page-title title-desk">Leaderboard</h1>

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

/** Loading: the page in outline, built from the loaded page's own blocks and classes (Pool band, podium, one page of rows). */
export function LoadingSkeleton() {
  return (
    <>
      <span className="sr-only" role="status">
        Loading the leaderboard…
      </span>
      <div className="lb-band-wrap" aria-hidden="true">
        <div className="cut cut-card lb-band skel">
          <span className="lb-band-art">
            <span className="lb-skel-chest" />
          </span>
          <span className="lb-band-pool">
            <b className="pool-fig lb-band-fig">
              <Ink>000</Ink>
            </b>
            <Ink className="lb-skel-usd">≈ $0.00</Ink>
          </span>
          <span className="lb-band-season">
            <b>
              <Ink>Season 0</Ink>
            </b>
            <Ink className="lb-skel-clock">00d 00h 00m</Ink>
          </span>
          <span className="lb-info-btn" />
        </div>
      </div>
      <section className="lb-season lb-skel-season" aria-hidden="true">
        <ol className="lb-podium">
          {[1, 2, 3].map((rank) => (
            <li key={rank} className={`cut cut-card lb-place p${rank}`}>
              <span className="lb-place-rank">
                <Ink>0</Ink>
              </span>
              <span className="cut cut-btn avatar lb-place-avatar skel-av" />
              <span className="lb-name">
                <Ink>Player</Ink>
              </span>
              <span className="lb-pts">
                <Ink>00 pts</Ink>
              </span>
              <span className="lb-prize">
                <span className="lb-prize-line">
                  <Ink>000</Ink>
                </span>
                <Ink className="lb-skel-usd">≈ $0.00</Ink>
              </span>
            </li>
          ))}
        </ol>
        <ol className="lb-rows lb-skel-rows">
          {Array.from({ length: PAGE_SIZE }, (_, i) => (
            <li key={i} className="cut cut-card lb-row">
              <span className="lb-rank">
                <Ink>0</Ink>
              </span>
              <span className="lb-who">
                <span className="cut cut-btn avatar lb-avatar skel-av" />
                <span className="lb-name">
                  <Ink>Player name</Ink>
                </span>
              </span>
              <span className="lb-pts">
                <Ink>00 pts</Ink>
              </span>
              <span className="lb-prize">
                <span className="lb-prize-line">
                  <Ink>000</Ink>
                </span>
                <Ink className="lb-skel-usd">≈ $0.00</Ink>
              </span>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

/** The Pool as one slim gold band: chest, figure, the Season's countdown and an ⓘ that holds how it works and the payout scale. */
function PoolBand({ data, pool, remaining }: { data: LeaderboardView; pool: number; remaining: number | null }) {
  const [info, setInfo] = useState(false);
  return (
    <section className="lb-band-wrap" aria-label="This season">
      <div className="cut cut-card lb-band">
        <span className="lb-band-art" aria-hidden="true">
          <span className="lb-hero-rays" />
          <Image className="lb-band-chest lb-hero-chest" src={art.poolChestCut} alt="" width={160} height={160} priority />
        </span>
        <span className="lb-band-pool">
          <b className="pool-fig lb-band-fig">
            <CountUp value={pool} duration={1200} />
          </b>
          {pool > 0 && <GemaUsd value={pool} />}
        </span>
        <span className="lb-band-season">
          <b>Season {data.season.number}</b>
          <span className="mono" aria-live="off" aria-label="Ends in">
            {remaining === null ? "—" : left(remaining)}
          </span>
        </span>
        <button type="button" className="lb-info-btn" aria-haspopup="dialog" aria-label="How the Pool works" onClick={() => setInfo(true)}>
          <Info aria-hidden="true" />
        </button>
      </div>
      <Sheet open={info} onClose={() => setInfo(false)} title="How the Pool works" className="lb-info-sheet">
        <div className="lb-info">
          <p>
            Win Matches to earn points.{" "}
            {data.feeBps > 0 ? `${data.feeBps / 100}% of every Pot goes into the Pool, from every Game.` : "The Pool opens with the next upgrade."} The top{" "}
            {PRIZE_PLACES} share it every Monday.
          </p>
          <Payout pool={pool} />
        </div>
      </Sheet>
    </section>
  );
}

function Loaded({ data, me, now, stale }: { data: LeaderboardView; me: string | null; now: number | null; stale: boolean }) {
  const remaining = now === null ? null : data.season.end - now;
  const pool = usePool() ?? data.poolGemas;

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
      <PoolBand data={data} pool={pool} remaining={remaining} />

      <Season data={data} pool={pool} me={me} />

      {data.last && <Last last={data.last} me={me} now={now ?? data.now} />}

      {stale && <p className="note">Couldn’t refresh; showing what was last loaded.</p>}
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

/** This season: the top three on a podium, then the rest as compact rows, 10 a page (`?page=2` in the URL). Your own row stays pinned above the nav while it is out of view. */
function Season({ data, pool, me }: { data: LeaderboardView; pool: number; me: string | null }) {
  const rows = data.standings;
  const podium = rows.slice(0, PODIUM);
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const top = useRef<HTMLElement>(null);
  const pages = pageCount(rows.length);
  const p = pageFromParam(search.get("page"), pages);
  const shown = pageRows(rows, p);
  const mine = rows.find((r) => r.account === me);
  const myPage = mine ? pageOfRank(mine.rank) : null;
  const setPage = (n: number) => {
    const q = new URLSearchParams(search.toString());
    const v = paramForPage(n);
    if (v) q.set("page", v);
    else q.delete("page");
    const qs = q.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  const myRow = useRef<HTMLLIElement>(null);
  const [mineInView, setMineInView] = useState(false);
  useEffect(() => {
    const el = myRow.current;
    if (!el) return setMineInView(false);
    const io = new IntersectionObserver(([e]) => setMineInView(e.isIntersecting), { rootMargin: "0px 0px -80px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [p, mine?.rank]);

  const go = (n: number) => {
    setPage(n);
    const el = top.current;
    if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: "start" });
  };
  const showMine = () => {
    if (myPage === null) return;
    setPage(myPage);
    requestAnimationFrame(() => myRow.current?.scrollIntoView({ block: "center", behavior: "smooth" }));
  };

  if (rows.length === 0) {
    return (
      <div className="cut cut-card lb-empty">
        <b>No points yet this season.</b>
        <p>The first win puts you at the top. A won Match earns one point for every {POINTS_DIVISOR} Gemas of entry.</p>
      </div>
    );
  }

  return (
    <section className="lb-season" aria-label={`Season ${data.season.number} ranks`} ref={top}>
      <ol className="lb-podium">
        {podium.map((r) => (
          <Place key={r.account} r={r} pool={pool} me={me === r.account} />
        ))}
      </ol>
      {shown.length > 0 && (
        <ol className="lb-rows" start={rankRange(p, rows.length).from}>
          {shown.map((r) => (
            <Row key={r.account} r={r} pool={pool} me={me === r.account} rowRef={me === r.account ? myRow : undefined} />
          ))}
        </ol>
      )}
      {pages > 1 && <Pager page={p} pages={pages} ranked={rows.length} go={go} />}
      {mine && mine.rank > PODIUM && !mineInView && (
        <button type="button" className="cut cut-card lb-row lb-pin me" onClick={showMine} aria-label={`You're ${ord(mine.rank)} with ${mine.points} points. Show your row`}>
          <span className="lb-rank">{mine.rank}</span>
          <span className="lb-who">
            <span className="cut cut-btn avatar lb-avatar">
              <PlayerAvatar account={mine.account} size={40} />
            </span>
            <i className="lb-you">You</i>
          </span>
          <span className="lb-pts">
            <b>{mine.points}</b> pts
          </span>
          <Prize r={mine} pool={pool} />
        </button>
      )}
    </section>
  );
}

/** The Gemas a rank wins, with ≈$; a dash outside the paid places. */
function Prize({ r, pool }: { r: LeaderboardRow; pool: number }) {
  if (r.rank > PRIZE_PLACES) return <span className="lb-prize lb-dim">—</span>;
  const gemas = prize(pool, r.rank - 1);
  return (
    <span className="lb-prize">
      <span className="lb-prize-line">
        <GemaMark size={14} />
        <b>{fmtGemas(gemas)}</b>
      </span>
      <GemaUsd value={gemas} />
    </span>
  );
}

/** A podium place: 1st in the middle and raised, outlined gold, silver and bronze. */
function Place({ r, pool, me }: { r: LeaderboardRow; pool: number; me: boolean }) {
  return (
    <li className={`cut cut-card lb-place p${r.rank}${me ? " me" : ""}`} aria-current={me ? "true" : undefined}>
      <span className="lb-place-rank" aria-label={`Rank ${r.rank}`}>{r.rank}</span>
      <AccountLink account={r.account} decorative>
        <span className="cut cut-btn avatar lb-place-avatar">
          <PlayerAvatar account={r.account} size={64} />
        </span>
      </AccountLink>
      <AccountLink account={r.account} className="lb-name" />
      {me && <i className="lb-you">You</i>}
      <span className="lb-pts">
        <b>{r.points}</b> pts
      </span>
      <Prize r={r} pool={pool} />
    </li>
  );
}

function Row({ r, pool, me, rowRef }: { r: LeaderboardRow; pool: number; me: boolean; rowRef?: React.Ref<HTMLLIElement> }) {
  const paid = r.rank <= PRIZE_PLACES;
  return (
    <li ref={rowRef} className={`cut cut-card lb-row${paid ? " paid" : ""}${me ? " me" : ""}${r.rank === PRIZE_PLACES + 1 ? " first-out" : ""}`} aria-current={me ? "true" : undefined}>
      <span className="lb-rank" aria-label={`Rank ${r.rank}`}>{r.rank}</span>
      <span className="lb-who">
        <Person account={r.account} />
        {me && <i className="lb-you">You</i>}
      </span>
      <span className="lb-pts">
        <b>{r.points}</b> pts
      </span>
      <Prize r={r} pool={pool} />
    </li>
  );
}

function Pager({ page, pages, ranked, go }: { page: number; pages: number; ranked: number; go: (n: number) => void }) {
  const { from, to } = rankRange(page, ranked);
  return (
    <nav className="lb-pager" aria-label="Table pages">
      <span className="lb-pager-range">
        Ranks {from}–{to} of {ranked}
      </span>
      <span className="lb-pager-btns">
        <button type="button" className="cut cut-btn btn neutral sm" onClick={() => go(page - 1)} disabled={page === 0} aria-label="Previous page">
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        {pageItems(page, pages).map((i, k) =>
          i === null ? (
            <span key={`gap${k}`} className="lb-page-gap" aria-hidden="true">…</span>
          ) : (
            <button key={i} type="button" className="cut cut-btn btn neutral sm lb-page" onClick={() => go(i)} aria-current={i === page ? "page" : undefined} aria-label={`Page ${i + 1}`}>
              {i + 1}
            </button>
          ),
        )}
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

const fmtPayoutDate = (secs: number) =>
  new Date(secs * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" });
/** The short form for a table cell: "Oct 28". The full time is in the cell's title. */
export const fmtPayoutDay = (secs: number) => new Date(secs * 1000).toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function Last({ last, me, now }: { last: LastSeason; me: string | null; now: number }) {
  return (
    <section className="lb-last" aria-labelledby="lb-last-h">
      <header className="lb-sec-head">
        <h2 id="lb-last-h" className="lb-last-h">Season {last.number} winners</h2>
        <span className="lb-last-pool">
          Pool <GemaMark size={14} /> <b>{fmtGemas(last.poolGemas)}</b> <GemaUsd value={last.poolGemas} />
        </span>
      </header>
      {last.winners.length === 0 ? (
        <p className="note">Nobody won a Match that season; the pool carried over.</p>
      ) : (
        <table className="lb-table">
          <thead>
            <tr>
              <th className="lb-c-rank" scope="col"><span aria-hidden="true">#</span><span className="sr-only">Rank</span></th>
              <th scope="col">Player</th>
              <th className="lb-c-num" scope="col">Points</th>
              <th className="lb-c-num" scope="col">Prize</th>
            </tr>
          </thead>
          <tbody>
            {last.winners.map((w) => {
              const note = lastRankNote(w, last.payoutAt, now);
              const mine = me === w.account;
              return (
                <tr key={w.account} className={mine ? "me" : undefined} aria-current={mine ? "true" : undefined}>
                  <td className="lb-c-rank">{w.rank}</td>
                  <td>
                    <span className="lb-who">
                      <AccountLink account={w.account} decorative>
                        <span className="cut cut-btn avatar lb-avatar">
                          <PlayerAvatar account={w.account} size={32} />
                        </span>
                      </AccountLink>
                      <AccountLink account={w.account} className="lb-name" />
                      {mine && <i className="lb-you">You</i>}
                    </span>
                  </td>
                  <td className="lb-c-num lb-c-pts">{w.points}</td>
                  <td className="lb-c-num">
                    <span className="lb-prize">
                      <GemaMark size={14} />
                      <b>{fmtGemas(w.gemas)}</b>
                      <GemaUsd value={w.gemas} />
                      {note.kind === "voided" && <small>not paid</small>}
                      {note.kind === "paying" && <small title={note.payoutAt ? `Paying out ${fmtPayoutDate(note.payoutAt)}` : undefined}>{note.payoutAt ? `Pays ${fmtPayoutDay(note.payoutAt)}` : "Paying"}</small>}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
