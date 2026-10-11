"use client";

/**
 * PROTOTYPE ONLY: four takes on the Account page's Matches and Backings panels, switchable with
 * `?variant=now|A|B|C|D`. Throwaway: the winner gets rewritten into AccountView / account.css on main.
 *
 * A Ring: win rate as a cut ring, games as thumb rows, Backers' won vs lost as one balance bar.
 * B Form: the record as W–L in display figures, the last Matches as pips, games as art tiles.
 * C Banners: one hero-art banner per game; Backings as the Backers themselves, each with their net.
 * D Tiles: every figure in its own labelled tile, scannable like a stat sheet.
 */
import Image from "next/image";
import { Fragment, type ReactNode } from "react";
import { PlayerAvatar, PlayerName } from "@/components/account/Player";
import { Label } from "@/components/ui";
import { PrototypeSwitcher, usePrototypeVariant } from "@/components/prototype/PrototypeSwitcher";
import { art } from "@/lib/art";
import { signed, type PlayedRow, type PlayerSummary } from "@/lib/chain/player-account";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import "./scoreboard.prototype.css";

const VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Ring" },
  { key: "B", name: "Form" },
  { key: "C", name: "Banners" },
  { key: "D", name: "Tiles" },
] as const;
type Key = (typeof VARIANTS)[number]["key"];

type Series = { row: PlayedRow; total: number }[];
type Props = { s: PlayerSummary; series: Series; current: ReactNode };

const pct = (w: number, of: number) => (of ? Math.round((w / of) * 100) : 0);
const tone = (n: number) => (n > 0 ? "won" : n < 0 ? "lost" : "");

/** Per-Backer totals from the decided backed rows (the same rows `backings` counts). */
function backersOf(series: Series) {
  const by = new Map<string, { net: number; matches: number; wins: number }>();
  for (const { row } of series) {
    if (!row.backing || row.backerDelta === null) continue;
    const b = by.get(row.backing.other) ?? { net: 0, matches: 0, wins: 0 };
    b.net += row.backerDelta;
    b.matches += 1;
    if (row.result === "won") b.wins += 1;
    by.set(row.backing.other, b);
  }
  return [...by.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.net - a.net);
}

export function ScoreboardPrototype(props: Props) {
  const v = usePrototypeVariant<Key>(VARIANTS.map((x) => x.key));
  return (
    <>
      {v === "now" && props.current}
      {v === "A" && <Ring {...props} />}
      {v === "B" && <Form {...props} />}
      {v === "C" && <Banners {...props} />}
      {v === "D" && <Tiles {...props} />}
      <PrototypeSwitcher variants={VARIANTS} />
    </>
  );
}

const NOTE = "A backed loss costs the Player nothing, so read their Gemas beside their Backers'.";

/* ——— A Ring ——— */

/** An octagon ring, filled clockwise from the top by `value` (0–1). Neutral: a win rate is not Gemas. */
function OctRing({ value, size = 112, children }: { value: number; size?: number; children: ReactNode }) {
  const c = 0.29; // chamfer as a share of the side
  const p = [
    [0.5, 0], [1 - c, 0], [1, c], [1, 1 - c], [1 - c, 1], [c, 1], [0, 1 - c], [0, c], [c, 0], [0.5, 0],
  ];
  const inset = 6;
  const d = p.map(([x, y], i) => `${i ? "L" : "M"}${inset + x * (100 - 2 * inset)} ${inset + y * (100 - 2 * inset)}`).join(" ");
  return (
    <div className="sbA-ring" style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <path d={d} className="track" pathLength={100} />
        <path d={d} className="fill" pathLength={100} strokeDasharray={`${value * 100} 100`} />
      </svg>
      <div className="sbA-ring-in">{children}</div>
    </div>
  );
}

function Ring({ s, series }: Props) {
  const { record, backings } = s;
  const backers = backersOf(series);
  const max = Math.max(backings.won, backings.lost, 1);
  return (
    <>
      <section className="cut cut-card pa-panel sbA" aria-label="Matches">
        <Label>Matches</Label>
        <div className="sbA-head">
          <OctRing value={record.matches ? record.wins / record.matches : 0}>
            <b>{pct(record.wins, record.matches)}%</b>
            <small>won</small>
          </OctRing>
          <dl className="sbA-wl">
            <div><dt>Won</dt><dd>{record.wins}</dd></div>
            <div><dt>Lost</dt><dd>{record.matches - record.wins}</dd></div>
            <p>of {record.matches} with a winner</p>
          </dl>
        </div>
        <ul className="sbA-games">
          {s.byGame.map((g) => (
            <li key={g.game}>
              <Image className="cut cut-btn sbA-thumb" src={art.thumb[g.game]} alt="" width={40} height={40} />
              <span className="sbA-gname">
                <b>{GAME_NAMES[g.game]}</b>
                <i className="sbA-mini" aria-hidden="true"><i style={{ width: `${pct(g.wins, g.matches)}%` }} /></i>
              </span>
              <span className="sbA-gfig">{g.wins}<small>/{g.matches}</small></span>
            </li>
          ))}
        </ul>
        <div className="sbA-chips">
          {s.bestScore !== null && <span className="cut cut-chip sbA-chip">Best Block Puzzle score <b>{fmtGemas(s.bestScore)}</b></span>}
          {s.undecided > 0 && <span className="cut cut-chip sbA-chip quiet">{s.undecided} draws and refunds, not counted</span>}
        </div>
      </section>

      <section className="cut cut-card pa-panel sbA" aria-label="Backings">
        <Label>Backings</Label>
        {backings.matches === 0 ? (
          <p className="pa-p">No Match with a winner was played under a Backing yet.</p>
        ) : (
          <>
            <div className="sbA-bhead">
              <b className="pa-fig">{backings.wins} of {backings.matches} won</b>
              <span className="sbA-ahead" aria-label={`${backings.ahead} of ${backings.backers} Backers ahead`}>
                {backers.map((b) => <i key={b.key} className={b.net > 0 ? "on" : ""} />)}
                <small>{backings.ahead} of {backings.backers} Backers ahead</small>
              </span>
            </div>
            <div className="sbA-bal" aria-hidden="true">
              <span className="lost"><i style={{ width: `${(backings.lost / max) * 100}%` }} /></span>
              <span className="won"><i style={{ width: `${(backings.won / max) * 100}%` }} /></span>
            </div>
            <dl className="sbA-ballegend">
              <div><dt>Backers lost</dt><dd className="lost">{signed(-backings.lost)}</dd></div>
              <div className="net"><dt>Backers&apos; net</dt><dd className={tone(backings.net)}>{signed(backings.net)}</dd></div>
              <div><dt>Backers won</dt><dd className="won">{signed(backings.won)}</dd></div>
            </dl>
            <p className="note">{NOTE}</p>
          </>
        )}
      </section>
    </>
  );
}

/* ——— B Form ——— */

function Pips({ rows, n = 12, backer = false }: { rows: PlayedRow[]; n?: number; backer?: boolean }) {
  const last = rows.slice(-n);
  return (
    <ol className="sbB-pips" aria-label={`Last ${last.length}, oldest first`}>
      {last.map((r) => {
        const d = backer ? (r.backerDelta ?? 0) : r.delta;
        return (
          <li key={r.id} className={r.result} title={`${GAME_NAMES[r.game]} · ${r.result} · ${signed(d)}`}>
            <span className="cut">{r.result === "won" ? "W" : "L"}</span>
            {backer && <small className={tone(d)}>{signed(d)}</small>}
          </li>
        );
      })}
    </ol>
  );
}

function Form({ s, series }: Props) {
  const { record, backings } = s;
  const rows = series.map((x) => x.row);
  const backed = rows.filter((r) => r.backing && r.backerDelta !== null);
  return (
    <>
      <section className="cut cut-card pa-panel sbB" aria-label="Matches">
        <div className="sbB-top">
          <Label>Matches</Label>
          <span className="sbB-rate">{pct(record.wins, record.matches)}% won</span>
        </div>
        <b className="sbB-wl">
          {record.wins}<span>–</span>{record.matches - record.wins}
        </b>
        <p className="sbB-cap">Won – lost, of {record.matches} Matches with a winner</p>
        <div className="sbB-form">
          <small>Form</small>
          <Pips rows={rows} />
          <small className="sbB-latest">latest</small>
        </div>
        <div className="sbB-tiles">
          {s.byGame.map((g) => (
            <div key={g.game} className="cut cut-card sbB-tile">
              <Image src={art.hero[g.game]} alt="" fill sizes="240px" className="sbB-art" />
              <span className="sbB-tname">{GAME_NAMES[g.game]}</span>
              <b>{g.wins}–{g.matches - g.wins}</b>
              {g.game === "block-puzzle" && s.bestScore !== null && <small>Best score {fmtGemas(s.bestScore)}</small>}
            </div>
          ))}
        </div>
        {s.undecided > 0 && <p className="sbB-foot">+ {s.undecided} draws and refunds, not counted</p>}
      </section>

      <section className="cut cut-card pa-panel sbB" aria-label="Backings">
        <div className="sbB-top">
          <Label>Backings</Label>
          {backings.matches > 0 && <span className="sbB-rate">{backings.ahead} of {backings.backers} Backers ahead</span>}
        </div>
        {backings.matches === 0 ? (
          <p className="pa-p">No Match with a winner was played under a Backing yet.</p>
        ) : (
          <>
            <b className="sbB-wl sm">
              {backings.wins}<span>–</span>{backings.matches - backings.wins}
            </b>
            <Pips rows={backed} n={8} backer />
            <dl className="sbB-three">
              <div><dt>Backers won</dt><dd className="won">{signed(backings.won)}</dd></div>
              <div><dt>Backers lost</dt><dd className="lost">{signed(-backings.lost)}</dd></div>
              <div><dt>Net</dt><dd className={tone(backings.net)}>{signed(backings.net)}</dd></div>
            </dl>
            <p className="note">{NOTE}</p>
          </>
        )}
      </section>
    </>
  );
}

/* ——— C Banners ——— */

function Banners({ s, series }: Props) {
  const { record, backings } = s;
  const backers = backersOf(series);
  return (
    <>
      <section className="cut cut-card pa-panel sbC" aria-label="Matches">
        <div className="sbC-top">
          <Label>Matches</Label>
          <span><b>{record.wins} of {record.matches}</b> won · {pct(record.wins, record.matches)}%</span>
        </div>
        <ul className="sbC-list">
          {s.byGame.map((g) => (
            <li key={g.game} className="cut cut-card sbC-banner">
              <Image src={art.hero[g.game]} alt="" fill sizes="420px" className="sbC-art" />
              <span className="sbC-body">
                <small>{g.wins} of {g.matches} won</small>
                <b>{GAME_NAMES[g.game]}</b>
                {g.game === "block-puzzle" && s.bestScore !== null && <em>Best score {fmtGemas(s.bestScore)}</em>}
              </span>
              <span className="sbC-pct">{pct(g.wins, g.matches)}<small>%</small></span>
              <i className="sbC-bar" aria-hidden="true"><i style={{ width: `${pct(g.wins, g.matches)}%` }} /></i>
            </li>
          ))}
        </ul>
        {s.undecided > 0 && <p className="sbC-foot">{s.undecided} draws and refunds, not counted</p>}
      </section>

      <section className="cut cut-card pa-panel sbC" aria-label="Backings">
        <div className="sbC-top">
          <Label>Backings</Label>
          {backings.matches > 0 && <span><b>{backings.wins} of {backings.matches}</b> won</span>}
        </div>
        {backings.matches === 0 ? (
          <p className="pa-p">No Match with a winner was played under a Backing yet.</p>
        ) : (
          <>
            <ul className="sbC-backers">
              {backers.map((b) => (
                <li key={b.key}>
                  <PlayerAvatar account={b.key} size={36} className="cut cut-btn sbC-av" />
                  <span>
                    <PlayerName account={b.key} />
                    <small>{b.matches} {b.matches === 1 ? "Backing" : "Backings"} · {b.wins} won</small>
                  </span>
                  <b className={tone(b.net)}>{signed(b.net)}</b>
                </li>
              ))}
            </ul>
            <div className="sbC-total">
              <span>Backers&apos; net · {backings.ahead} of {backings.backers} ahead</span>
              <b className={tone(backings.net)}>{signed(backings.net)}</b>
            </div>
            <p className="note">{NOTE}</p>
          </>
        )}
      </section>
    </>
  );
}

/* ——— D Tiles ——— */

function Tile({ label, children, sub, wide }: { label: string; children: ReactNode; sub?: ReactNode; wide?: boolean }) {
  return (
    <div className={`cut cut-chip sbD-tile${wide ? " wide" : ""}`}>
      <small>{label}</small>
      <b>{children}</b>
      {sub && <span>{sub}</span>}
    </div>
  );
}

function Tiles({ s }: Props) {
  const { record, backings } = s;
  return (
    <>
      <section className="cut cut-card pa-panel sbD" aria-label="Matches">
        <Label>Matches</Label>
        <div className="sbD-grid">
          <Tile label="Win rate" sub={<i className="sbD-bar"><i style={{ width: `${pct(record.wins, record.matches)}%` }} /></i>}>
            {pct(record.wins, record.matches)}%
          </Tile>
          <Tile label="Won – lost" sub={`of ${record.matches}`}>{record.wins}–{record.matches - record.wins}</Tile>
          {s.byGame.map((g) => (
            <Tile key={g.game} label={GAME_NAMES[g.game]} sub={`${pct(g.wins, g.matches)}% won`}>
              {g.wins}–{g.matches - g.wins}
            </Tile>
          ))}
          {s.bestScore !== null && <Tile label="Best score" sub="Block Puzzle">{fmtGemas(s.bestScore)}</Tile>}
          {s.undecided > 0 && <Tile label="Draws, refunds" sub="not counted">{s.undecided}</Tile>}
        </div>
      </section>

      <section className="cut cut-card pa-panel sbD" aria-label="Backings">
        <Label>Backings</Label>
        {backings.matches === 0 ? (
          <p className="pa-p">No Match with a winner was played under a Backing yet.</p>
        ) : (
          <>
            <div className="sbD-grid">
              <Tile label="Backed Matches" sub={`${pct(backings.wins, backings.matches)}% won`}>{backings.wins} of {backings.matches}</Tile>
              <Tile label="Backers ahead">{backings.ahead} of {backings.backers}</Tile>
              <Tile label="Backers' net" wide sub={<Fragment><span className="won">{signed(backings.won)}</span> won · <span className="lost">{signed(-backings.lost)}</span> lost</Fragment>}>
                <span className={tone(backings.net)}>{signed(backings.net)}</span>
              </Tile>
            </div>
            <p className="note">{NOTE}</p>
          </>
        )}
      </section>
    </>
  );
}
