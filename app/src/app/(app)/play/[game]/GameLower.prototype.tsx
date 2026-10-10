"use client";

// PROTOTYPE (proto/game-lower-10-10-2026): the game page below the hero, 4 variants via ?variant=0|A|B|C.
// Question: how should Recent Matches, Top scores today and How to play sit together? Throwaway.
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { AccountLink } from "@/components/account/AccountLink";
import { PlayerAvatar, PlayerName } from "@/components/account/Player";
import { MatchRow } from "@/components/match/MatchRow";
import { Bust, CheckIcon, GemaMark, MinusIcon, XIcon } from "@/components/ui";
import { ago } from "@/lib/catalogue";
import { amountText, backingText, type HistoryRow } from "@/lib/chain/history";
import { fmtGemas } from "@/lib/format";
import type { GameId } from "@/lib/mock";
import { PrototypeSwitcher } from "@/components/prototype/PrototypeSwitcher";
import "./game-lower.prototype.css";

export interface LowerProps {
  game: GameId;
  name: string;
  how: string;
  steps: string[];
  history: HistoryRow[];
  scores: [string, number][];
  me: string | null;
  empty: string;
  now: number;
}

export const VARIANTS = [
  { key: "0", name: "Current" },
  { key: "A", name: "Scoreboard" },
  { key: "B", name: "Guide band" },
  { key: "C", name: "Podium" },
];

export function GameLowerPrototype({ variant, ...p }: LowerProps & { variant: string }) {
  return (
    <>
      {variant === "A" ? <VariantA {...p} /> : variant === "B" ? <VariantB {...p} /> : variant === "C" ? <VariantC {...p} /> : null}
      <PrototypeSwitcher variants={VARIANTS} />
    </>
  );
}

const RESULT = { won: { text: "Won", Icon: CheckIcon }, lost: { text: "Lost", Icon: XIcon }, draw: { text: "Draw", Icon: MinusIcon }, refunded: { text: "Refunded", Icon: MinusIcon } } as const;

function record(history: HistoryRow[]) {
  const won = history.filter((r) => r.result === "won").length;
  const lost = history.filter((r) => r.result === "lost").length;
  const net = history.reduce((s, r) => s + r.delta, 0);
  const best = history.reduce((b, r) => (r.scores && r.result === "won" ? Math.max(b, r.scores[0]) : b), 0);
  return { won, lost, net, best, played: history.length };
}

function signed(n: number) {
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmtGemas(Math.abs(n))}`;
}

function SeeAll({ p }: { p: LowerProps }) {
  if (p.history.length === 0) return null;
  return (
    <Link href={`/matches?game=${p.game}`} className="gl-all">
      See all {p.history.length} <ArrowRight aria-hidden="true" />
    </Link>
  );
}

/** One Match as a ruled line, no thumbnail (every row is the same Game here). */
function Line({ r, now }: { r: HistoryRow; now: number }) {
  const res = RESULT[r.result];
  const note = backingText(r);
  return (
    <Link href={`/play/match/${r.id}`} className="gl-line">
      <span className={`gl-res ${r.result}`}>
        <res.Icon aria-hidden="true" /> {res.text}
      </span>
      <span className="gl-who">
        {r.opp && <PlayerAvatar className="gl-av" account={r.opp} size={36} />}
        <span>
          <b>{r.opp ? <PlayerName account={r.opp} /> : "No opponent"}</b>
          <small>
            {r.scores ? `${r.scores[0]} – ${r.scores[1]} · ` : ""}
            {ago(r.at, now)}
            {note ? ` · ${note}` : ""}
          </small>
        </span>
      </span>
      <b className={`gl-amt${r.delta > 0 ? " won" : ""}`}>
        {r.delta > 0 && <GemaMark size={18} />}
        {amountText(r)}
      </b>
    </Link>
  );
}
function Steps({ steps, className = "" }: { steps: string[]; className?: string }) {
  return (
    <ol className={`gl-steps ${className}`}>
      {steps.map((s, i) => (
        <li key={s}>
          <span className="gl-num">{i + 1}</span>
          <span>{s}</span>
        </li>
      ))}
    </ol>
  );
}

function Board({ p, limit = 5 }: { p: LowerProps; limit?: number }) {
  return (
    <ol className="gl-board">
      {p.scores.slice(0, limit).map(([key, score], i) => (
        <li key={key} className={key === p.me ? "me" : undefined}>
          <b className="gl-rank">{i + 1}</b>
          <AccountLink account={key} decorative>
            <PlayerAvatar className="gl-av" account={key} size={36} />
          </AccountLink>
          <AccountLink account={key} className="gl-name" />
          {key === p.me && <span className="gl-you">You</span>}
          <b className="gl-score">{score}</b>
        </li>
      ))}
    </ol>
  );
}

/* ——— A: Scoreboard. Your record on top of a ruled list | leaderboard + short steps. No character. ——— */
function VariantA(p: LowerProps) {
  const rec = record(p.history);
  return (
    <div className="gl-a">
      <section className="cut cut-card gl-card" aria-labelledby="gla-you">
        <header className="gl-head">
          <h2 id="gla-you" className="h-section">Your {p.name}</h2>
          <SeeAll p={p} />
        </header>
        {rec.played > 0 && (
          <dl className="gl-stats">
            <div>
              <dt>Record</dt>
              <dd>
                {rec.won}–{rec.lost}
              </dd>
            </div>
            <div>
              <dt>Gemas</dt>
              <dd className={rec.net > 0 ? "won" : undefined}>{signed(rec.net)}</dd>
            </div>
            {p.game === "block-puzzle" && (
              <div>
                <dt>Best score</dt>
                <dd>{rec.best || "–"}</dd>
              </div>
            )}
          </dl>
        )}
        {p.history.length === 0 ? (
          <p className="meta">{p.empty}</p>
        ) : (
          <div className="gl-lines">
            {p.history.slice(0, 5).map((r) => (
              <Line key={r.id} r={r} now={p.now} />
            ))}
          </div>
        )}
      </section>
      <div className="gl-side">
        {p.scores.length > 0 && (
          <section className="cut cut-card gl-card" aria-labelledby="gla-top">
            <header className="gl-head">
              <h2 id="gla-top" className="gl-h3">Top scores today</h2>
              <span className="meta">Last 24 hours</span>
            </header>
            <Board p={p} />
          </section>
        )}
        <section className="cut cut-card gl-card" aria-labelledby="gla-how">
          <header className="gl-head">
            <h2 id="gla-how" className="gl-h3">How to play</h2>
          </header>
          <b className="gl-tag">{p.how}</b>
          <Steps steps={p.steps} />
        </section>
      </div>
    </div>
  );
}

/* ——— B: Guide band. How to play spans the page with the character and three step cards; lists below. ——— */
function VariantB(p: LowerProps) {
  return (
    <div className="gl-b">
      <section className="cut cut-card gl-band" aria-labelledby="glb-how">
        <Bust name="himExplain" width={220} className="gl-band-bust" />
        <div className="gl-band-copy">
          <h2 id="glb-how" className="h-section">How to play</h2>
          <b>{p.how}</b>
        </div>
        <ol className="gl-band-steps">
          {p.steps.map((s, i) => (
            <li key={s} className="cut cut-chip">
              <span className="gl-big">{i + 1}</span>
              <span>{s}</span>
            </li>
          ))}
        </ol>
      </section>
      <div className="gl-b-grid">
        <section className="gl-plain" aria-labelledby="glb-recent">
          <header className="gl-head">
            <h2 id="glb-recent" className="h-section">Recent Matches</h2>
            <SeeAll p={p} />
          </header>
          {p.history.length === 0 ? (
            <p className="meta">{p.empty}</p>
          ) : (
            <div className="mh-list">
              {p.history.slice(0, 3).map((r) => (
                <MatchRow key={r.id} r={r} now={p.now} />
              ))}
            </div>
          )}
        </section>
        {p.scores.length > 0 && (
          <section className="gl-plain" aria-labelledby="glb-top">
            <header className="gl-head">
              <h2 id="glb-top" className="h-section">Top today</h2>
            </header>
            <div className="cut cut-card gl-card tight">
              <Board p={p} />
            </div>
            <p className="note">Best winning score per Player in the last 24 hours.</p>
          </section>
        )}
      </div>
    </div>
  );
}

/* ——— C: Podium. Three quick facts, then today's top three as a podium beside your record; Matches last. ——— */
function VariantC(p: LowerProps) {
  const rec = record(p.history);
  const [first, second, third] = p.scores;
  const podium = ([[second, 2], [first, 1], [third, 3]] as const).filter(([s]) => s);
  const rate = rec.won + rec.lost > 0 ? Math.round((rec.won / (rec.won + rec.lost)) * 100) : null;
  const myRank = p.me ? p.scores.findIndex(([k]) => k === p.me) : -1;
  return (
    <div className="gl-c">
      <Steps steps={p.steps} className="gl-facts" />
      <div className={`gl-c-grid${first ? "" : " solo"}`}>
        {first ? (
          <section className="cut cut-card gl-card gl-podium-card" aria-labelledby="glc-top">
            <header className="gl-head">
              <h2 id="glc-top" className="h-section">Top today</h2>
              <span className="meta">{myRank >= 0 ? `You are #${myRank + 1}` : "Win a Match to get on the board"}</span>
            </header>
            <div className="gl-podium" style={{ gridTemplateColumns: `repeat(${podium.length}, minmax(0, 200px))` }}>
              {podium.map(([s, rank]) => (
                <div key={s![0]} className={`gl-step s${rank}`}>
                  <AccountLink account={s![0]} decorative>
                    <PlayerAvatar className="gl-pav" account={s![0]} size={{ 1: 84, 2: 64, 3: 56 }[rank]} />
                  </AccountLink>
                  <AccountLink account={s![0]} className="gl-name" />
                  <b className="gl-score">{s![1]}</b>
                  <span className="cut cut-chip gl-block">{rank}</span>
                </div>
              ))}
            </div>
            {p.scores.length > 3 && <Board p={{ ...p, scores: p.scores.slice(3) }} />}
          </section>
        ) : null}
        <section className="cut cut-card gl-card" aria-labelledby="glc-you">
          <header className="gl-head">
            <h2 id="glc-you" className="h-section">You</h2>
            <SeeAll p={p} />
          </header>
          {rec.played > 0 ? (
            <>
              <div className="gl-rec">
                <span className="gl-rate">{rate !== null ? `${rate}%` : "–"}</span>
                <span className="meta">
                  won · {rec.won}–{rec.lost} in {rec.played} Matches
                </span>
              </div>
              <div className="gl-bar" aria-hidden="true">
                <i style={{ width: `${rate ?? 0}%` }} />
              </div>
              <div className="gl-lines">
                {p.history.slice(0, 4).map((r) => (
                  <Line key={r.id} r={r} now={p.now} />
                ))}
              </div>
            </>
          ) : (
            <p className="meta">{p.empty}</p>
          )}
        </section>
      </div>
    </div>
  );
}
