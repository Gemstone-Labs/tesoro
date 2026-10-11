"use client";

/**
 * PROTOTYPE ONLY: four takes on the Account page's Match history, switchable with
 * `?variant=now|A|B|C|D`. Throwaway: the winner gets rewritten into AccountView / account.css on main.
 *
 * A Timeline: Matches grouped by day on a spine, each day with its own net and record.
 * B Banners: every Match a poster banner over the Game's art, the two Players face to face.
 * C Ledger: a stat sheet, one column per fact, the running total beside each Match.
 * D Form: the last Matches as a strip of pips with the streak, then the Matches as tiles in a grid.
 */
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { AccountLink } from "@/components/account/AccountLink";
import { PlayerAvatar, PlayerName } from "@/components/account/Player";
import { CheckIcon, GemaMark, MinusIcon, XIcon } from "@/components/ui";
import { PrototypeSwitcher, usePrototypeVariant } from "@/components/prototype/PrototypeSwitcher";
import { art } from "@/lib/art";
import { ago } from "@/lib/catalogue";
import { amountText, shortKey } from "@/lib/chain/history";
import { backingLine, runningTotal, signed, type PlayedRow } from "@/lib/chain/player-account";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import "./history.prototype.css";

const VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Timeline" },
  { key: "B", name: "Banners" },
  { key: "C", name: "Ledger" },
  { key: "D", name: "Form + tiles" },
] as const;

type Props = {
  /** The Account whose page this is. */
  self: string;
  /** Every finished Match, newest first (for the running total and the form strip). */
  rows: PlayedRow[];
  /** The rows matching the game filter. */
  shown: PlayedRow[];
  /** This page of `shown`. */
  page: PlayedRow[];
  now: number;
  showGame: boolean;
  current: ReactNode;
};

const RES = { won: { word: "Won", letter: "W", Icon: CheckIcon }, lost: { word: "Lost", letter: "L", Icon: XIcon }, draw: { word: "Draw", letter: "D", Icon: MinusIcon }, refunded: { word: "Refunded", letter: "R", Icon: MinusIcon } } as const;
const tone = (n: number) => (n > 0 ? "won" : n < 0 ? "lost" : "");
const score = (r: PlayedRow) => (r.scores ? `${fmtGemas(r.scores[0])} – ${fmtGemas(r.scores[1])}` : null);
const dayKey = (ms: number) => new Date(ms).toDateString();
const dayLabel = (ms: number, now: number) => {
  const d = new Date(ms).toDateString();
  if (d === new Date(now).toDateString()) return "Today";
  if (d === new Date(now - 864e5).toDateString()) return "Yesterday";
  return new Date(ms).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
};
const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const shortDate = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function HistoryPrototype(p: Props) {
  const v = usePrototypeVariant(VARIANTS.map((x) => x.key));
  return (
    <>
      {v === "now" && p.current}
      {v === "A" && <Timeline {...p} />}
      {v === "B" && <Banners {...p} />}
      {v === "C" && <Ledger {...p} />}
      {v === "D" && <Form {...p} />}
      <PrototypeSwitcher variants={VARIANTS} />
    </>
  );
}

/* ——— A Timeline ——— */
function Timeline({ page, now, showGame }: Props) {
  const days: { key: string; at: number; rows: PlayedRow[] }[] = [];
  for (const r of page) {
    const k = dayKey(r.at);
    const last = days[days.length - 1];
    if (last?.key === k) last.rows.push(r);
    else days.push({ key: k, at: r.at, rows: [r] });
  }
  return (
    <div className="hx-tl">
      {days.map((d) => {
        const net = d.rows.reduce((s, r) => s + r.delta, 0);
        const w = d.rows.filter((r) => r.result === "won").length;
        const l = d.rows.filter((r) => r.result === "lost").length;
        return (
          <section key={d.key} className="hx-day">
            <header>
              <h3>{dayLabel(d.at, now)}</h3>
              <span className="hx-day-rec tnum">
                {w}W {l}L
              </span>
              <b className={`hx-day-net ${tone(net)}`}>{signed(net)}</b>
            </header>
            <ol>
              {d.rows.map((r) => {
                const res = RES[r.result];
                const back = backingLine(r);
                return (
                  <li key={r.id} className={`hx-ev ${r.result}`}>
                    <span className="hx-node" aria-hidden="true">
                      <res.Icon />
                    </span>
                    <time className="hx-time">{clock(r.at)}</time>
                    <span className="hx-what">
                      <span className="hx-line">
                        <b>{res.word}</b>
                        {r.opp ? (
                          <>
                            <span className="hx-vs">vs</span>
                            <AccountLink account={r.opp} className="hx-opp">
                              <PlayerAvatar account={r.opp} size={24} className="hx-av" />
                              <PlayerName account={r.opp} />
                            </AccountLink>
                          </>
                        ) : (
                          <span className="hx-vs">no opponent</span>
                        )}
                      </span>
                      <small>
                        {showGame && `${GAME_NAMES[r.game]} · `}
                        {score(r) ?? `Entry ${fmtGemas(r.entry)}`}
                        {back && ` · ${back}`}
                      </small>
                    </span>
                    <b className={`hx-amt ${tone(r.delta)}`}>{r.delta === 0 ? "±0" : signed(r.delta)}</b>
                    <Link href={`/play/match/${r.id}`} className="hx-go" aria-label="See this Match">
                      <ChevronRight aria-hidden="true" />
                    </Link>
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

/* ——— B Banners ——— */
function Banners({ self, page, now }: Props) {
  return (
    <div className="hx-bn-list">
      {page.map((r) => {
        const res = RES[r.result];
        const back = backingLine(r);
        return (
          <article key={r.id} className={`cut cut-card hx-bn ${r.result}`}>
            <span className="hx-bn-art">
              <Image src={art.hero[r.game]} alt="" fill sizes="(max-width: 700px) 100vw, 900px" />
            </span>
            <Link href={`/play/match/${r.id}`} className="hx-bn-hit" aria-label={`${GAME_NAMES[r.game]} Match, ${res.word}`} />
            <div className="hx-bn-word">
              <span className="hx-bn-kick">
                {GAME_NAMES[r.game]} · {ago(r.at, now)}
              </span>
              <b>{res.word}</b>
            </div>
            <div className="hx-bn-face">
              <span className="hx-bn-seat me">
                <PlayerAvatar account={self} size={52} className="hx-bn-av" />
                {r.scores && <b className="tnum">{fmtGemas(r.scores[0])}</b>}
              </span>
              <span className="hx-bn-vs">vs</span>
              {r.opp ? (
                <AccountLink account={r.opp} className="hx-bn-seat them">
                  <PlayerAvatar account={r.opp} size={52} className="hx-bn-av" />
                  {r.scores ? <b className="tnum">{fmtGemas(r.scores[1])}</b> : <small><PlayerName account={r.opp} /></small>}
                </AccountLink>
              ) : (
                <span className="hx-bn-seat them empty">
                  <span className="hx-bn-av" />
                </span>
              )}
            </div>
            <div className="hx-bn-side">
              <span className={`cut cut-chip hx-bn-fig ${tone(r.delta) || "even"}`}>
                <res.Icon aria-hidden="true" />
                <b className="tnum">{r.delta === 0 ? amountText(r) : signed(r.delta)}</b>
              </span>
              <small>{back ?? `Entry ${fmtGemas(r.entry)}`}</small>
            </div>
          </article>
        );
      })}
    </div>
  );
}

/* ——— C Ledger ——— */
function Ledger({ rows, page, showGame }: Props) {
  const totals = new Map(runningTotal(rows).map((s) => [s.row.id, s.total]));
  const peak = Math.max(1, ...[...totals.values()].map(Math.abs));
  return (
    <div className="cut cut-card hx-lg">
      <table>
        <thead>
          <tr>
            <th scope="col">Date</th>
            {showGame && <th scope="col">Game</th>}
            <th scope="col">Opponent</th>
            <th scope="col">Result</th>
            <th scope="col" className="num">Score</th>
            <th scope="col" className="num">Entry</th>
            <th scope="col" className="num">Gemas</th>
            <th scope="col" className="num">Running total</th>
            <th scope="col"><span className="sr-only">Match</span></th>
          </tr>
        </thead>
        <tbody>
          {page.map((r) => {
            const res = RES[r.result];
            const total = totals.get(r.id);
            return (
              <tr key={r.id} className={r.result}>
                <td className="hx-lg-date">
                  {shortDate(r.at)}
                  <small>{clock(r.at)}</small>
                </td>
                {showGame && (
                  <td>
                    <span className="hx-lg-game">
                      <span className="hx-lg-thumb">
                        <Image src={art.thumb[r.game]} alt="" fill sizes="32px" />
                      </span>
                      {GAME_NAMES[r.game]}
                    </span>
                  </td>
                )}
                <td>
                  {r.opp ? (
                    <AccountLink account={r.opp} className="hx-lg-opp">
                      <PlayerAvatar account={r.opp} size={28} className="hx-av" />
                      <PlayerName account={r.opp} />
                    </AccountLink>
                  ) : (
                    <span className="hx-dim">None</span>
                  )}
                  {r.backing && <small className="hx-lg-back">Backed by {shortKey(r.backing.other)} · {r.backing.shareBps / 100}%</small>}
                </td>
                <td>
                  <span className={`hx-lg-res ${r.result}`}>
                    <res.Icon aria-hidden="true" />
                    {res.word}
                  </span>
                </td>
                <td className="num tnum">{score(r) ?? <span className="hx-dim">—</span>}</td>
                <td className="num tnum">{fmtGemas(r.entry)}</td>
                <td className={`num tnum hx-lg-amt ${tone(r.delta)}`}>{r.delta === 0 ? "±0" : signed(r.delta)}</td>
                <td className="num">
                  {total === undefined ? (
                    <span className="hx-dim">—</span>
                  ) : (
                    <span className="hx-lg-run">
                      <span className="hx-lg-bar" aria-hidden="true">
                        <i className={tone(total)} style={{ width: `${(Math.abs(total) / peak) * 100}%` }} />
                      </span>
                      <b className={`tnum ${tone(total)}`}>{signed(total)}</b>
                    </span>
                  )}
                </td>
                <td>
                  <Link href={`/play/match/${r.id}`} className="hx-go" aria-label="See this Match">
                    <ChevronRight aria-hidden="true" />
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ——— D Form + tiles ——— */
function Form({ shown, page, now, showGame }: Props) {
  const recent = shown.slice(0, 20);
  const first = recent.find((r) => r.result === "won" || r.result === "lost");
  let streak = 0;
  for (const r of recent) {
    if (r.result === "draw" || r.result === "refunded") continue;
    if (r.result !== first?.result) break;
    streak++;
  }
  const decided = recent.filter((r) => r.result === "won" || r.result === "lost");
  const w = decided.filter((r) => r.result === "won").length;
  return (
    <div className="hx-fm">
      <div className="cut cut-card hx-fm-strip">
        <div className="hx-fm-lead">
          <small>Form · last {recent.length}</small>
          <b>
            {first ? (
              <>
                <span className={first.result}>{streak}</span> {first.result === "won" ? (streak === 1 ? "win" : "wins") : streak === 1 ? "loss" : "losses"} in a row
              </>
            ) : (
              "No winner yet"
            )}
          </b>
          <small className="tnum">
            {w} of {decided.length} won
          </small>
        </div>
        <ol className="hx-fm-pips" aria-label="Most recent first">
          {recent.map((r) => (
            <li key={r.id}>
              <Link href={`/play/match/${r.id}`} className={`hx-pip ${r.result}`} title={`${RES[r.result].word} · ${GAME_NAMES[r.game]} · ${amountText(r)}`}>
                {RES[r.result].letter}
              </Link>
            </li>
          ))}
        </ol>
      </div>
      <div className="hx-fm-grid">
        {page.map((r) => {
          const res = RES[r.result];
          return (
            <Link key={r.id} href={`/play/match/${r.id}`} className={`cut cut-card hx-tile ${r.result}`}>
              <span className="hx-tile-art">
                <Image src={art.hero[r.game]} alt="" fill sizes="320px" />
                <b className="hx-tile-letter">{res.letter}</b>
                <span className="hx-tile-when">{ago(r.at, now)}</span>
              </span>
              <span className="hx-tile-body">
                <span className="hx-tile-opp">
                  {r.opp && <PlayerAvatar account={r.opp} size={28} className="hx-av" />}
                  <span>
                    <small>vs</small> {r.opp ? <PlayerName account={r.opp} /> : "No opponent"}
                  </span>
                </span>
                <small className="hx-tile-meta tnum">
                  {showGame && `${GAME_NAMES[r.game]} · `}
                  {score(r) ?? `Entry ${fmtGemas(r.entry)}`}
                </small>
                <b className={`hx-tile-amt tnum ${tone(r.delta)}`}>
                  {r.delta > 0 && <GemaMark size={18} />}
                  {amountText(r)}
                </b>
                {r.backing && <small className="hx-tile-back">Backed · {shortKey(r.backing.other)}</small>}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
