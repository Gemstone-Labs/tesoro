"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { AccountLink } from "@/components/account/AccountLink";
import { Button, GemaMark, Label, SkeletonCards } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { avatarFor } from "@/lib/art";
import { accountKeyOf } from "@/lib/chain/account-key";
import { shortKey } from "@/lib/chain/history";
import type { LastSeason, LeaderboardRow, LeaderboardView } from "@/lib/chain/leaderboard-view";
import { useLeaderboard } from "@/lib/chain/useLeaderboard";
import { POINTS_DIVISOR, PRIZE_BPS, PRIZE_PLACES } from "@/lib/chain/season";
import { fmtGemas } from "@/lib/format";
import "./leaderboard.css";

/** Prize of rank `i` from a pool, floored as in the program. */
const prize = (pool: number, i: number) => Math.floor((pool * PRIZE_BPS[i]) / 10_000);

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
  const { data, error, retry } = useLeaderboard();
  const { auth, snapshot } = useAccount();
  const me = snapshot?.accountKey.toBase58() ?? (auth.addresses.solana ? accountKeyOf(auth.addresses.solana) : null);
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
          <div className="lb-skel">
            <SkeletonCards count={4} avatar={false} label="Loading the leaderboard…" />
          </div>
        )
      ) : (
        <Loaded data={data} me={me} now={now} stale={error} />
      )}
    </div>
  );
}

function Loaded({ data, me, now, stale }: { data: LeaderboardView; me: string | null; now: number | null; stale: boolean }) {
  const mine = useMemo(() => data.standings.find((r) => r.account === me) ?? null, [data.standings, me]);
  const remaining = now === null ? null : data.season.end - now;

  return (
    <>
      <section className="cut cut-frame lb-hero" aria-label="This season">
        <div className="lb-pool">
          <Label>Prize pool</Label>
          <b className="lb-pool-fig">
            <GemaMark size={40} />
            {fmtGemas(data.poolGemas)}
          </b>
          <small>
            {data.feeBps > 0
              ? `${data.feeBps / 100}% of every Pot goes in, from every Game.`
              : "The pool opens with the next upgrade."}
          </small>
        </div>
        <dl className="lb-facts">
          <div>
            <dt>Season</dt>
            <dd>{data.season.number}</dd>
          </div>
          <div>
            <dt>Time left</dt>
            <dd className="mono" aria-live="off">{remaining === null ? "—" : left(remaining)}</dd>
          </div>
          <div>
            <dt>Players with points</dt>
            <dd>{data.players}</dd>
          </div>
        </dl>
        <p className="lb-hero-note">
          Seasons run Monday to Monday, UTC. Prizes are paid in Gemas, with the Sources they came from, shortly after a season ends.
        </p>
      </section>

      {data.settling !== null && (
        <p className="note" role="status">
          Season {data.settling} has ended and its prizes are being paid.
        </p>
      )}

      <div className="lb-grid">
        <section className="lb-table" aria-labelledby="lb-table-h">
          <header className="lb-sec-head">
            <h2 id="lb-table-h" className="h-section">Season {data.season.number}</h2>
          </header>
          {data.standings.length === 0 ? (
            <div className="cut cut-card lb-empty">
              <b>No points yet this season.</b>
              <p>The first win puts you at the top. A won Match earns one point for every {POINTS_DIVISOR} Gemas of entry.</p>
              <Button variant="money" href="/play">Play now</Button>
            </div>
          ) : (
            <ol className="lb-rows">
              {data.standings.map((r) => (
                <Row key={r.account} r={r} pool={data.poolGemas} me={me === r.account} />
              ))}
            </ol>
          )}
          {me && !mine && data.standings.length > 0 && (
            <p className="note">
              {data.players > data.standings.length ? "You’re not in the top of the table yet." : "You have no points this season yet."} Win a Match to climb.
            </p>
          )}
        </section>

        <aside className="lb-side">
          <Scale pool={data.poolGemas} />
          <Points />
        </aside>
      </div>

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
          <Image src={avatarFor(account)} alt="" width={48} height={48} />
        </span>
      </AccountLink>
      <AccountLink account={account} className="lb-name">
        <b>{shortKey(account)}</b>
      </AccountLink>
    </>
  );
}

function Row({ r, pool, me }: { r: LeaderboardRow; pool: number; me: boolean }) {
  const paid = r.rank <= PRIZE_PLACES ? prize(pool, r.rank - 1) : 0;
  return (
    <li className={`cut cut-card lb-row${me ? " me" : ""}${r.rank <= PRIZE_PLACES ? " paid" : ""}`} aria-current={me ? "true" : undefined}>
      <span className="lb-rank" aria-label={`Rank ${r.rank}`}>{r.rank}</span>
      <span className="lb-who">
        <Person account={r.account} />
        {me && <i className="lb-you">You</i>}
      </span>
      <span className="lb-num">
        <b>{r.points}</b>
        <small>points</small>
      </span>
      <span className="lb-num lb-wins">
        <b>{r.wins}</b>
        <small>{r.wins === 1 ? "win" : "wins"}</small>
      </span>
      <span className="lb-prize">
        {paid > 0 ? (
          <>
            <GemaMark size={16} />
            <b>{fmtGemas(paid)}</b>
          </>
        ) : null}
      </span>
    </li>
  );
}

function Scale({ pool }: { pool: number }) {
  return (
    <section className="cut cut-card lb-card" aria-labelledby="lb-scale-h">
      <h2 id="lb-scale-h" className="pa-h">Payout scale</h2>
      <p>The pool is split between the top ten on a sliding scale.</p>
      <ol className="lb-scale">
        {PRIZE_BPS.map((bps, i) => (
          <li key={i}>
            <span className="lb-scale-rank">{i + 1}</span>
            <span className="lb-scale-bar" aria-hidden="true">
              <i style={{ width: `${(bps / PRIZE_BPS[0]) * 100}%` }} />
            </span>
            <span className="lb-scale-pct">{bps / 100}%</span>
            <span className="lb-scale-amt">
              <GemaMark size={14} />
              {fmtGemas(prize(pool, i))}
            </span>
          </li>
        ))}
      </ol>
      <small>A season with fewer than ten Players pays only the ranks it has; the rest stays in the pool for the next one.</small>
    </section>
  );
}

function Points() {
  return (
    <section className="cut cut-card lb-card" aria-labelledby="lb-pts-h">
      <h2 id="lb-pts-h" className="pa-h">How points work</h2>
      <ul className="lb-pts">
        {[500, 1000, 2500].map((e) => (
          <li key={e}>
            <span>{fmtGemas(e)} entry</span>
            <b>+{e / POINTS_DIVISOR} points</b>
          </li>
        ))}
      </ul>
      <small>
        The same in every Game. A win earns points; a loss, a draw or a refund earns none. When a Backer funds the entry, the Player who played gets the
        points. Ties go to whoever won first that week.
      </small>
    </section>
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
