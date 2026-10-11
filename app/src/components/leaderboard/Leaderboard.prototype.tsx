"use client";

/**
 * PROTOTYPE ONLY: four takes on the Leaderboard table + Payout scale + How points work
 * (?variant=now|A|B|C|D). Throwaway: the winner gets rewritten into Leaderboard.tsx on main.
 */
import { AccountLink } from "@/components/account/AccountLink";
import { PlayerAvatar, PlayerName } from "@/components/account/Player";
import { GemaMark } from "@/components/ui";
import type { LeaderboardRow, LeaderboardView } from "@/lib/chain/leaderboard-view";
import { POINTS_DIVISOR, PRIZE_BPS, PRIZE_PLACES } from "@/lib/chain/season";
import { fmtGemas } from "@/lib/format";
import "./leaderboard.prototype.css";

export interface ProtoProps {
  data: LeaderboardView;
  pool: number;
  me: string | null;
}

const ENTRIES = [500, 1000, 2500] as const;
const prize = (pool: number, rank: number) => (rank <= PRIZE_PLACES ? Math.floor((pool * PRIZE_BPS[rank - 1]) / 10_000) : 0);
const pct = (rank: number) => (rank <= PRIZE_PLACES ? PRIZE_BPS[rank - 1] / 100 : 0);
const ord = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;
const winsFor = (points: number, entry: number) => Math.ceil(points / (entry / POINTS_DIVISOR));

function Gemas({ n, size = 14 }: { n: number; size?: number }) {
  return (
    <span className="lbp-gemas">
      <GemaMark size={size} />
      <b>{fmtGemas(n)}</b>
    </span>
  );
}

function Face({ account, size, className = "" }: { account: string; size: number; className?: string }) {
  return (
    <AccountLink account={account} decorative>
      <span className={`cut cut-btn avatar lbp-face ${className}`} style={{ width: size, height: size }}>
        <PlayerAvatar account={account} size={size} />
      </span>
    </AccountLink>
  );
}

function Name({ account, me }: { account: string; me: boolean }) {
  return (
    <span className="lbp-name">
      <AccountLink account={account}>
        <PlayerName account={account} />
      </AccountLink>
      {me && <i className="lb-you">You</i>}
    </span>
  );
}

const Fine = () => (
  <>
    A win earns points; a loss, a draw or a refund earns none. A Backed win counts for the Player who played. Ties go to whoever won first that week. A
    season with fewer than ten Players pays only the ranks it has; the rest stays in the pool.
  </>
);

/* ———————————————————— A · Podium ———————————————————— */

export function VariantA({ data, pool, me }: ProtoProps) {
  const rows = data.standings;
  const top = rows.slice(0, 3);
  const paid = rows.slice(3, PRIZE_PLACES);
  const rest = rows.slice(PRIZE_PLACES);
  const line = rows[PRIZE_PLACES - 1]?.points ?? 0;
  const podium = [top[1], top[0], top[2]].filter(Boolean);

  return (
    <section className="lpa" aria-labelledby="lpa-h">
      <header className="lpa-head">
        <h2 id="lpa-h" className="h-section">Season {data.season.number}</h2>
        <ul className="lpa-pts" aria-label="Points per win">
          {ENTRIES.map((e) => (
            <li key={e} className="cut cut-chip">
              <span>Win at {fmtGemas(e)}</span>
              <b>+{e / POINTS_DIVISOR}</b>
            </li>
          ))}
        </ul>
      </header>

      <ol className="lpa-podium">
        {podium.map((r) => (
          <li key={r.account} className={`cut cut-frame lpa-step r${r.rank}${me === r.account ? " me" : ""}`}>
            <span className="lpa-rank">{r.rank}</span>
            <Face account={r.account} size={r.rank === 1 ? 96 : 76} />
            <Name account={r.account} me={me === r.account} />
            <span className="lpa-stat">
              <b>{r.points}</b> points · <b>{r.wins}</b> wins
            </span>
            <span className="cut cut-chip lpa-prize">
              <Gemas n={prize(pool, r.rank)} size={16} />
              <small>{pct(r.rank)}%</small>
            </span>
          </li>
        ))}
      </ol>

      <ol className="lpa-list" start={4}>
        {paid.map((r) => (
          <li key={r.account} className={`lpa-row${me === r.account ? " me" : ""}`}>
            <span className="lpa-n">{r.rank}</span>
            <span className="lpa-who">
              <Face account={r.account} size={36} />
              <Name account={r.account} me={me === r.account} />
            </span>
            <span className="lpa-num">
              <b>{r.points}</b> pts
            </span>
            <span className="lpa-num lpa-hide">
              <b>{r.wins}</b> wins
            </span>
            <span className="lpa-share" aria-hidden="true">
              <i style={{ width: `${(pct(r.rank) / pct(1)) * 100}%` }} />
            </span>
            <span className="lpa-pay">
              <Gemas n={prize(pool, r.rank)} />
              <small>{pct(r.rank)}%</small>
            </span>
          </li>
        ))}
      </ol>

      {rest.length > 0 && (
        <>
          <p className="lpa-line">
            <span>Prize line · the top ten are paid</span>
          </p>
          <ol className="lpa-list lpa-rest">
            {rest.map((r) => (
              <li key={r.account} className={`lpa-row${me === r.account ? " me" : ""}`}>
                <span className="lpa-n">{r.rank}</span>
                <span className="lpa-who">
                  <Face account={r.account} size={36} />
                  <Name account={r.account} me={me === r.account} />
                </span>
                <span className="lpa-num">
                  <b>{r.points}</b> pts
                </span>
                <span className="lpa-num lpa-hide">
                  <b>{r.wins}</b> wins
                </span>
                <span className="lpa-gap">{line - r.points + 1} points to the line</span>
              </li>
            ))}
          </ol>
        </>
      )}
      <p className="lbp-fine">
        <Fine />
      </p>
    </section>
  );
}

/* ———————————————————— B · Your race ———————————————————— */

function Standing({ rows, pool, me, players }: { rows: LeaderboardRow[]; pool: number; me: string | null; players: number }) {
  const mine = rows.find((r) => r.account === me) ?? null;
  const target = mine ? (mine.rank > 1 ? rows[mine.rank - 2] : null) : rows[Math.min(PRIZE_PLACES, rows.length) - 1];
  const need = target ? target.points - (mine?.points ?? 0) + 1 : 0;

  return (
    <aside className="cut cut-frame lpb-card" aria-label="Your standing">
      {mine ? (
        <>
          <span className="lpb-kicker">Your standing</span>
          <div className="lpb-me">
            <b className="lpb-place">{ord(mine.rank)}</b>
            <span>
              of {players} Players
              <br />
              {mine.points} points · {mine.wins} wins
            </span>
          </div>
          <div className="lpb-now">
            <small>If the season ended now</small>
            {mine.rank <= PRIZE_PLACES ? <Gemas n={prize(pool, mine.rank)} size={22} /> : <b>Outside the prizes</b>}
          </div>
        </>
      ) : (
        <>
          <span className="lpb-kicker">{me ? "You have no points yet" : "Climb the table"}</span>
          <p className="lpb-lede">
            The prize line is at <b>{target?.points ?? 0} points</b>. Tenth place takes <Gemas n={prize(pool, PRIZE_PLACES)} />.
          </p>
        </>
      )}

      {target ? (
        <div className="lpb-calc">
          <p>
            {mine ? (
              <>
                <b>{need} points</b> to pass {ord(target.rank)} (<PlayerName account={target.account} />)
                {target.rank <= PRIZE_PLACES && (
                  <>
                    {" "}
                    for <Gemas n={prize(pool, target.rank)} />
                  </>
                )}
              </>
            ) : (
              <>
                <b>{need} points</b> to reach the top ten
              </>
            )}
          </p>
          <ul>
            {ENTRIES.slice()
              .reverse()
              .map((e) => (
                <li key={e}>
                  <span>
                    {winsFor(need, e)} {winsFor(need, e) === 1 ? "win" : "wins"} at {fmtGemas(e)}
                  </span>
                  <small>+{e / POINTS_DIVISOR} each</small>
                </li>
              ))}
          </ul>
        </div>
      ) : (
        <p className="lpb-lede">You lead the season. Every win widens the gap.</p>
      )}

      <details className="lpb-more">
        <summary>Payout scale</summary>
        <ol>
          {PRIZE_BPS.map((bps, i) => (
            <li key={i}>
              <span>{ord(i + 1)}</span>
              <span>{bps / 100}%</span>
              <Gemas n={prize(pool, i + 1)} />
            </li>
          ))}
        </ol>
        <p className="lbp-fine">
          <Fine />
        </p>
      </details>
    </aside>
  );
}

export function VariantB({ data, pool, me }: ProtoProps) {
  const rows = data.standings;
  const lead = rows[0]?.points || 1;
  return (
    <div className="lpb">
      <section aria-labelledby="lpb-h">
        <header className="lb-sec-head">
          <h2 id="lpb-h" className="h-section">Season {data.season.number}</h2>
        </header>
        <ol className="lpb-race">
          {rows.map((r) => (
            <li key={r.account} className={`lpb-lane${me === r.account ? " me" : ""}${r.rank > PRIZE_PLACES ? " out" : ""}`}>
              <span className="lpb-n">{r.rank}</span>
              <Face account={r.account} size={40} />
              <span className="lpb-track">
                <span className="lpb-label">
                  <Name account={r.account} me={me === r.account} />
                  <small>{r.wins} wins</small>
                </span>
                <span className="lpb-bar" aria-hidden="true">
                  <i style={{ width: `${(r.points / lead) * 100}%` }} />
                </span>
              </span>
              <b className="lpb-pts">
                {r.points}
                <small>pts</small>
              </b>
              <span className="lpb-pay">{r.rank <= PRIZE_PLACES ? <Gemas n={prize(pool, r.rank)} /> : null}</span>
              {r.rank === PRIZE_PLACES && rows.length > PRIZE_PLACES && <span className="lpb-cut">Prize line</span>}
            </li>
          ))}
        </ol>
      </section>
      <Standing rows={rows} pool={pool} me={me} players={data.players} />
    </div>
  );
}

/* ———————————————————— C · Ledger ———————————————————— */

export function VariantC({ data, pool, me }: ProtoProps) {
  const rows = data.standings;
  const paid = rows.filter((r) => r.rank <= PRIZE_PLACES);
  const rest = rows.filter((r) => r.rank > PRIZE_PLACES);
  const Tr = ({ r }: { r: LeaderboardRow }) => (
    <tr className={me === r.account ? "me" : undefined} aria-current={me === r.account ? "true" : undefined}>
      <td className="lpc-rank">{r.rank}</td>
      <td>
        <span className="lpc-who">
          <Face account={r.account} size={30} />
          <Name account={r.account} me={me === r.account} />
        </span>
      </td>
      <td className="lpc-r lpc-hide">{r.wins}</td>
      <td className="lpc-r lpc-strong">{r.points}</td>
      <td className="lpc-r lpc-hide">{r.rank <= PRIZE_PLACES ? `${pct(r.rank)}%` : "—"}</td>
      <td className="lpc-r">{r.rank <= PRIZE_PLACES ? <Gemas n={prize(pool, r.rank)} /> : <span className="lpc-dim">—</span>}</td>
    </tr>
  );

  return (
    <section className="lpc" aria-labelledby="lpc-h">
      <div className="cut cut-card lpc-band">
        <div className="lpc-chart">
          <h3 className="pa-h">Payout scale</h3>
          <ol>
            {PRIZE_BPS.map((bps, i) => (
              <li key={i}>
                <span className="lpc-col" style={{ height: `${(bps / PRIZE_BPS[0]) * 100}%` }}>
                  <small>{bps / 100}%</small>
                </span>
                <b>{i + 1}</b>
                <span className="lpc-amt">{fmtGemas(prize(pool, i + 1))}</span>
              </li>
            ))}
          </ol>
        </div>
        <div className="lpc-rules">
          <h3 className="pa-h">Points per win</h3>
          <dl>
            {ENTRIES.map((e) => (
              <div key={e}>
                <dt>{fmtGemas(e)} entry</dt>
                <dd>+{e / POINTS_DIVISOR}</dd>
              </div>
            ))}
          </dl>
          <p className="lbp-fine">
            <Fine />
          </p>
        </div>
      </div>

      <header className="lb-sec-head">
        <h2 id="lpc-h" className="h-section">Season {data.season.number}</h2>
        <span className="lpc-meta">{data.players} Players with points</span>
      </header>
      <table className="lpc-table">
        <thead>
          <tr>
            <th className="lpc-rank">#</th>
            <th>Player</th>
            <th className="lpc-r lpc-hide">Wins</th>
            <th className="lpc-r">Points</th>
            <th className="lpc-r lpc-hide">Share</th>
            <th className="lpc-r">Prize</th>
          </tr>
        </thead>
        <tbody>
          <tr className="lpc-group">
            <th colSpan={6}>In the prizes</th>
          </tr>
          {paid.map((r) => (
            <Tr key={r.account} r={r} />
          ))}
        </tbody>
        {rest.length > 0 && (
          <tbody>
            <tr className="lpc-group">
              <th colSpan={6}>Chasing · {rows[PRIZE_PLACES - 1].points + 1} points gets you in</th>
            </tr>
            {rest.map((r) => (
              <Tr key={r.account} r={r} />
            ))}
          </tbody>
        )}
      </table>
    </section>
  );
}

/* ———————————————————— D · Prize ladder ———————————————————— */

export function VariantD({ data, pool, me }: ProtoProps) {
  const rows = data.standings;
  const paid = rows.filter((r) => r.rank <= PRIZE_PLACES);
  const rest = rows.filter((r) => r.rank > PRIZE_PLACES);
  return (
    <div className="lpd">
      <section aria-labelledby="lpd-h">
        <header className="lb-sec-head">
          <h2 id="lpd-h" className="h-section">Season {data.season.number}</h2>
        </header>
        <ol className="lpd-ladder">
          {paid.map((r) => {
            const s = PRIZE_BPS[r.rank - 1] / PRIZE_BPS[0];
            return (
              <li
                key={r.account}
                className={`cut cut-card lpd-rung${me === r.account ? " me" : ""}`}
                style={{ "--s": s } as React.CSSProperties}
              >
                <span className="lpd-rank">{r.rank}</span>
                <Face account={r.account} size={Math.round(36 + 44 * s)} />
                <span className="lpd-who">
                  <Name account={r.account} me={me === r.account} />
                  <small>
                    {r.points} points · {r.wins} wins
                  </small>
                </span>
                <span className="lpd-pay">
                  <Gemas n={prize(pool, r.rank)} size={Math.round(14 + 8 * s)} />
                  <small>{pct(r.rank)}% of the pool</small>
                </span>
              </li>
            );
          })}
        </ol>
        {rest.length > 0 && (
          <>
            <h3 className="lpd-sub">Below the prize line</h3>
            <ol className="lpd-rest">
              {rest.map((r) => (
                <li key={r.account} className={`cut cut-chip${me === r.account ? " me" : ""}`}>
                  <span className="lpd-rest-n">{r.rank}</span>
                  <Face account={r.account} size={28} />
                  <Name account={r.account} me={me === r.account} />
                  <b>{r.points}</b>
                </li>
              ))}
            </ol>
          </>
        )}
      </section>

      <aside className="cut cut-card lb-card lpd-rules" aria-label="Rules">
        <h2 className="pa-h">How the season pays</h2>
        <ol className="lpd-steps">
          <li>
            <b>Win a Match</b>
            <span>
              {ENTRIES.map((e) => `+${e / POINTS_DIVISOR} at ${fmtGemas(e)}`).join(" · ")}
            </span>
          </li>
          <li>
            <b>Climb the ladder</b>
            <span>Most points by Monday 00:00 UTC. Ties go to whoever won first.</span>
          </li>
          <li>
            <b>Top ten split the pool</b>
            <span>From 25% for first to 4% for ninth and tenth. Unpaid ranks roll over.</span>
          </li>
        </ol>
        <small>A loss, a draw or a refund earns no points. A Backed win counts for the Player who played.</small>
      </aside>
    </div>
  );
}
