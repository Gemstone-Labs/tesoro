"use client";

/* PROTOTYPE ONLY: five takes on the Leaderboard hero (?variant=now|A|B|C|D|E). */
import Image from "next/image";
import { CountUp, GemaMark, Label } from "@/components/ui";
import { art, avatarFor } from "@/lib/art";
import { shortKey } from "@/lib/chain/history";
import type { LeaderboardView } from "@/lib/chain/leaderboard-view";
import { PRIZE_BPS, PRIZE_PLACES } from "@/lib/chain/season";
import { fmtGemas } from "@/lib/format";
import "./leaderboard-hero.prototype.css";

export interface HeroProps {
  data: LeaderboardView;
  pool: number;
  /** Seconds left in the season, null until the server clock is known. */
  remaining: number | null;
  /** Server now, unix seconds. */
  now: number | null;
}

const prize = (pool: number, i: number) => Math.floor((pool * PRIZE_BPS[i]) / 10_000);
const pad = (n: number) => String(n).padStart(2, "0");
function parts(secs: number | null) {
  const s = Math.max(0, Math.floor(secs ?? 0));
  return { d: Math.floor(s / 86_400), h: Math.floor((s % 86_400) / 3_600), m: Math.floor((s % 3_600) / 60), s: s % 60 };
}
const feeLine = (bps: number) => (bps > 0 ? `${bps / 100}% of every Pot goes in, from every Game.` : "The pool opens with the next upgrade.");
const NOTE = "Seasons run Monday to Monday, UTC. Prizes are paid in Gemas, with the Sources they came from, shortly after a season ends.";

/* ——— A · Treasure poster: centred, chest on top, the countdown as four cut tiles ——— */
export function HeroA({ data, pool, remaining }: HeroProps) {
  const t = parts(remaining);
  const units: [string, number][] = [["days", t.d], ["hrs", t.h], ["min", t.m], ["sec", t.s]];
  return (
    <section className="cut cut-frame lbx-a" aria-label="This season">
      <div className="lbx-a-rays" aria-hidden="true" />
      <Image className="pool-art lbx-a-chest" src={art.poolChest} alt="" width={240} height={240} priority />
      <Label>Season {data.season.number} · Leaderboard Pool</Label>
      <b className="pool-fig lbx-a-fig">
        <CountUp value={pool} duration={1200} />
      </b>
      <p className="lbx-a-fee">{feeLine(data.feeBps)}</p>
      <div className="lbx-a-clock" aria-label="Time left">
        {units.map(([u, n]) => (
          <span key={u} className="cut cut-btn lbx-a-tile">
            <b className="mono">{remaining === null ? "--" : pad(n)}</b>
            <small>{u}</small>
          </span>
        ))}
      </div>
      <p className="lbx-a-foot">
        <b>{data.players}</b> Players with points · Top {PRIZE_PLACES} share the pool · Monday to Monday, UTC
      </p>
    </section>
  );
}

/* ——— B · Season track: the week as a track Mon → Mon, a gold marker at now ——— */
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function HeroB({ data, pool, remaining, now }: HeroProps) {
  const { start, end } = data.season;
  const p = now === null ? 0 : Math.min(1, Math.max(0, (now - start) / (end - start)));
  const days = Array.from({ length: 8 }, (_, i) => DAY[new Date((start + i * 86_400) * 1000).getUTCDay()]);
  const t = parts(remaining);
  return (
    <section className="cut cut-frame lbx-b" aria-label="This season">
      <div className="lbx-b-pool">
        <Image className="pool-art lbx-b-chest" src={art.poolChest} alt="" width={200} height={200} priority />
        <div className="lbx-b-text">
          <Label>Leaderboard Pool</Label>
          <b className="pool-fig lbx-b-fig">
            <CountUp value={pool} duration={1200} />
          </b>
          <small>{feeLine(data.feeBps)}</small>
        </div>
      </div>
      <div className="lbx-b-season">
        <div className="lbx-b-row">
          <span className="lbx-b-num">Season {data.season.number}</span>
          <span className="lbx-b-ends">
            ends in <b className="mono">{remaining === null ? "—" : `${t.d}d ${pad(t.h)}h ${pad(t.m)}m`}</b>
          </span>
        </div>
        <div className="lbx-b-track" role="img" aria-label={`${Math.round(p * 100)}% of the season gone`}>
          <i className="lbx-b-fill" style={{ width: `${p * 100}%` }} />
          {days.map((d, i) => (
            <span key={i} className="lbx-b-tick" style={{ left: `${(i / 7) * 100}%` }}>
              <small>{d}</small>
            </span>
          ))}
          <span className="lbx-b-now" style={{ left: `${p * 100}%` }}>
            <GemaMark size={18} />
          </span>
        </div>
        <p className="lbx-b-foot">
          <b>{data.players}</b> Players with points. Prizes are paid in Gemas, with the Sources they came from, shortly after the season ends.
        </p>
      </div>
    </section>
  );
}

/* ——— C · Prize steps: what 1st, 2nd and 3rd would take home right now, the leaders on the steps ——— */
export function HeroC({ data, pool, remaining }: HeroProps) {
  const t = parts(remaining);
  const order = [1, 0, 2];
  return (
    <section className="cut cut-frame lbx-c" aria-label="This season">
      <div className="lbx-c-pool">
        <Image className="pool-art lbx-c-chest" src={art.poolChest} alt="" width={180} height={180} priority />
        <div className="lbx-c-text">
          <Label>Leaderboard Pool</Label>
          <b className="pool-fig lbx-c-fig">
            <CountUp value={pool} duration={1200} />
          </b>
          <small>{feeLine(data.feeBps)}</small>
        </div>
      </div>
      <ol className="lbx-c-steps" aria-label="Prizes if the season ended now">
        {order.map((i) => {
          const who = data.standings[i];
          return (
            <li key={i} className={`lbx-c-step s${i + 1}`}>
              <span className="cut cut-btn avatar lbx-c-av">
                {who ? <Image src={avatarFor(who.account)} alt="" width={48} height={48} /> : <i>?</i>}
              </span>
              <small className="lbx-c-who">{who ? shortKey(who.account) : "Open"}</small>
              <span className="lbx-c-block">
                <b className="lbx-c-rank">{i + 1}</b>
                <span className="lbx-c-prize">
                  <GemaMark size={14} />
                  {fmtGemas(prize(pool, i))}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
      <dl className="lbx-c-strip">
        <div><dt>Season</dt><dd>{data.season.number}</dd></div>
        <div><dt>Time left</dt><dd className="mono">{remaining === null ? "—" : `${t.d}d ${pad(t.h)}h ${pad(t.m)}m`}</dd></div>
        <div><dt>Players with points</dt><dd>{data.players}</dd></div>
        <div><dt>Paid places</dt><dd>Top {PRIZE_PLACES}</dd></div>
      </dl>
      <p className="lbx-c-note">{NOTE}</p>
    </section>
  );
}

/* ——— D · Vault banner: the chest large on the right with turning light, figure huge on the left ——— */
export function HeroD({ data, pool, remaining }: HeroProps) {
  const t = parts(remaining);
  const faces = data.standings.slice(0, 5);
  return (
    <section className="cut cut-frame lbx-d" aria-label="This season">
      <div className="lbx-d-art" aria-hidden="true">
        <div className="lbx-d-rays" />
        <Image className="pool-art lbx-d-chest" src={art.poolChest} alt="" width={420} height={420} priority />
      </div>
      <div className="lbx-d-copy">
        <span className="lbx-d-kicker">
          Season {data.season.number} · ends in <b className="mono">{remaining === null ? "—" : `${t.d}d ${pad(t.h)}h ${pad(t.m)}m ${pad(t.s)}s`}</b>
        </span>
        <b className="pool-fig lbx-d-fig">
          <CountUp value={pool} duration={1200} />
        </b>
        <span className="lbx-d-title">Gemas in the Leaderboard Pool</span>
        <p>{feeLine(data.feeBps)} The top {PRIZE_PLACES} share it every Monday.</p>
        <div className="lbx-d-chips">
          <span className="lbx-d-chip">
            <span className="lbx-d-faces" aria-hidden="true">
              {faces.map((r) => (
                <Image key={r.account} src={avatarFor(r.account)} alt="" width={28} height={28} />
              ))}
            </span>
            <b>{data.players}</b> Players with points
          </span>
          <span className="lbx-d-chip">
            1st takes <GemaMark size={14} /> <b>{fmtGemas(prize(pool, 0))}</b>
          </span>
        </div>
      </div>
    </section>
  );
}

/* ——— E · Compact strip: one slim row, the table moves up; the rules sit behind a disclosure ——— */
export function HeroE({ data, pool, remaining }: HeroProps) {
  const t = parts(remaining);
  return (
    <section className="cut cut-frame lbx-e" aria-label="This season">
      <Image className="pool-art lbx-e-chest" src={art.poolChest} alt="" width={120} height={120} priority />
      <div className="lbx-e-pool">
        <Label>Leaderboard Pool</Label>
        <b className="pool-fig lbx-e-fig">
          <CountUp value={pool} duration={1200} />
        </b>
      </div>
      <dl className="lbx-e-facts">
        <div><dt>Season</dt><dd>{data.season.number}</dd></div>
        <div><dt>Time left</dt><dd className="mono">{remaining === null ? "—" : `${t.d}d ${pad(t.h)}h ${pad(t.m)}m`}</dd></div>
        <div><dt>Players</dt><dd>{data.players}</dd></div>
        <div><dt>1st prize</dt><dd className="lbx-e-first"><GemaMark size={16} />{fmtGemas(prize(pool, 0))}</dd></div>
      </dl>
      <details className="lbx-e-more">
        <summary>How the pool works</summary>
        <p>{feeLine(data.feeBps)} {NOTE}</p>
      </details>
    </section>
  );
}
