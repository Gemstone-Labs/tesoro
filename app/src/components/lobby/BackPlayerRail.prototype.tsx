"use client";

/* PROTOTYPE ONLY: five takes on the Lobby "Back a player" rail (?variant=now|A|B|C|D|E). Branch proto/back-player-rail-11-10-2026. */
import Image from "next/image";
import Link from "next/link";
import { useId, useRef, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import type { ChainRequest } from "@/lib/chain/backing";
import { backedSplit } from "@/lib/chain/ledger";
import { LEADERBOARD_BPS } from "@/lib/chain/season";
import { timeLeft } from "@/lib/chain/useBackingBoard";
import { art } from "@/lib/art";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import { Bust, ClockIcon, GemaMark, Label } from "@/components/ui";
import { AccountLink } from "@/components/account/AccountLink";
import { PlayerAvatar, usePlayerLabel } from "@/components/account/Player";
import { Rail } from "./Rail";
import "./back-player-rail.prototype.css";

export interface Item {
  r: ChainRequest;
  key: string;
  mine: boolean;
}

const pct = (r: ChainRequest) => (r.record.matches ? Math.round((r.record.wins / r.record.matches) * 100) : 0);
/** Win rate pulled toward 50% for small samples, so 3 of 3 does not outrank 34 of 52. */
const strength = (r: ChainRequest) => (r.record.wins + 1) / (r.record.matches + 2);
const byStrength = (a: Item, b: Item) => strength(b.r) - strength(a.r);

/** What the Backer gets on a win at the Offer drawer's default (Player share 40%). Test-mode fees: 2% Platform + 3% Studio + Leaderboard. */
const SHARE_BPS = 4000;
function ifWin(entry: number) {
  const s = backedSplit({ entry, platformBps: 200, studioBps: 300, leaderboardBps: LEADERBOARD_BPS, shareBps: SHARE_BPS, won: true });
  return { back: s.backerEntryBack + s.backerSurplus, gain: s.backerSurplus, player: s.playerShare, fees: s.fees };
}

function Act({ it, size, block, children }: { it: Item; size?: "sm" | "lg"; block?: boolean; children?: React.ReactNode }) {
  const name = usePlayerLabel(it.r.player);
  const cls = `cut cut-btn btn${size ? ` ${size}` : ""}${block ? " block" : ""}`;
  if (it.mine)
    return (
      <Link href={`/backing#${it.key}`} className={`${cls} neutral`}>
        Yours
      </Link>
    );
  return (
    <Link href={`/backing#${it.key}`} className={`${cls} money`} aria-label={`Offer to back ${name} in ${GAME_NAMES[it.r.game]} for ${fmtGemas(it.r.entry)} Gemas`}>
      {children ?? "Offer"}
    </Link>
  );
}

function Avatar({ it, size, className = "" }: { it: Item; size: number; className?: string }) {
  return (
    <AccountLink account={it.r.player} decorative className={`cut cut-btn avatar ${className}`}>
      <PlayerAvatar account={it.r.player} size={size * 2} />
    </AccountLink>
  );
}

function Amount({ v, size = 18 }: { v: number; size?: number }) {
  return (
    <span className="bp-amt">
      <GemaMark size={size} />
      {fmtGemas(v)}
    </span>
  );
}

/** W and L as pips (scaled down to at most `max`): a proportion, not an order. */
function Pips({ r, max = 24 }: { r: ChainRequest; max?: number }) {
  const { matches, wins } = r.record;
  if (!matches) return null;
  const n = Math.min(max, matches);
  const w = Math.round((wins / matches) * n);
  return (
    <span className="bp-pips" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <i key={i} className={i < w ? "w" : "l"} />
      ))}
    </span>
  );
}

/* ——— A · Spotlight: the strongest Request as a wide feature, the rest on a bench beside it ——— */
export function RailA({ items }: { items: Item[] }) {
  const [lead, ...rest] = [...items].sort(byStrength);
  if (!lead) return null;
  const { r } = lead;
  const win = ifWin(r.entry);
  return (
    <Rail id="back-a-player" title="Back a player" viewAll="/backing" cols={3} className="bpa">
      <article className="cut cut-frame bpa-lead">
        <Image className="bpa-art" src={art.hero[r.game]} alt="" fill sizes="(min-width: 1100px) 760px, 100vw" />
        <div className="bpa-lead-body">
          <Label>Strongest record asking now</Label>
          <div className="bpa-who">
            <Avatar it={lead} size={104} className="bpa-avatar" />
            <div>
              <strong>
                <AccountLink account={r.player} />
              </strong>
              <span className="bpa-meta">
                {GAME_NAMES[r.game]} · <ClockIcon width={13} height={13} /> {timeLeft(r.expiresAt)}
              </span>
            </div>
          </div>
          <div className="bpa-rec">
            <b>{pct(r)}%</b>
            <div>
              <span>
                won {r.record.wins} of {r.record.matches} Matches
              </span>
              <Pips r={r} max={32} />
            </div>
          </div>
          <footer className="bpa-deal">
            <div>
              <span>Back them for</span>
              <Amount v={r.entry} size={22} />
            </div>
            <div>
              <span>If they win, you get</span>
              <Amount v={win.back} size={22} />
            </div>
            <Act it={lead} size="lg">
              Offer
            </Act>
          </footer>
        </div>
      </article>
      <div className="bpa-bench">
        <Label>Also asking</Label>
        {rest.slice(0, 4).map((it) => (
          <div key={it.key} className="cut cut-card bpa-row">
            <Avatar it={it} size={48} className="bpa-row-avatar" />
            <div className="bpa-row-who">
              <strong>
                <AccountLink account={it.r.player} />
              </strong>
              <span>
                {GAME_NAMES[it.r.game]} · <Amount v={it.r.entry} size={13} />
              </span>
            </div>
            <span className="bpa-row-pct">{it.r.record.matches ? `${pct(it.r)}%` : "New"}</span>
            <Act it={it} size="sm" />
          </div>
        ))}
      </div>
    </Rail>
  );
}

/* ——— B · Scouting ledger: one framed table, sortable, more Requests at a glance ——— */
type Sort = "record" | "ask" | "ending";
const SORTS: [Sort, string][] = [
  ["record", "Best record"],
  ["ask", "Biggest ask"],
  ["ending", "Ending soon"],
];
export function RailB({ items }: { items: Item[] }) {
  const [sort, setSort] = useState<Sort>("record");
  const rows = [...items].sort(sort === "record" ? byStrength : sort === "ask" ? (a, b) => b.r.entry - a.r.entry : (a, b) => a.r.expiresAt - b.r.expiresAt).slice(0, 6);
  return (
    <Rail
      id="back-a-player"
      title="Back a player"
      viewAll="/backing"
      cols={3}
      className="bpb"
      aside={
        <div className="bpb-sort" role="group" aria-label="Sort Requests">
          {SORTS.map(([k, l]) => (
            <button key={k} type="button" className={`cut cut-chip bpb-sort-b${sort === k ? " on" : ""}`} aria-pressed={sort === k} onClick={() => setSort(k)}>
              {l}
            </button>
          ))}
        </div>
      }
    >
      <div className="cut cut-frame bpb-table" role="table" aria-label="Players asking to be backed">
        <div className="bpb-row bpb-head" role="row">
          <span role="columnheader">Player</span>
          <span role="columnheader">Game</span>
          <span role="columnheader">Record</span>
          <span role="columnheader">Asks for</span>
          <span role="columnheader">Ends</span>
          <span role="columnheader" className="sr-only">
            Offer
          </span>
        </div>
        {rows.map((it) => {
          const p = pct(it.r);
          return (
            <div key={it.key} className="bpb-row" role="row">
              <span className="bpb-who" role="cell">
                <Avatar it={it} size={44} className="bpb-avatar" />
                <strong>
                  <AccountLink account={it.r.player} />
                </strong>
              </span>
              <span className="bpb-game" role="cell">
                <span className="cut cut-chip bpb-thumb">
                  <Image src={art.hero[it.r.game]} alt="" fill sizes="56px" />
                </span>
                {GAME_NAMES[it.r.game]}
              </span>
              <span className="bpb-rec" role="cell">
                {it.r.record.matches ? (
                  <>
                    <b>{p}%</b>
                    <span className="bpb-bar" aria-hidden="true">
                      <i style={{ width: `${p}%` }} />
                    </span>
                    <small>
                      {it.r.record.wins}–{it.r.record.matches - it.r.record.wins}
                    </small>
                  </>
                ) : (
                  <small className="bpb-new">New Player</small>
                )}
              </span>
              <span className="bpb-ask" role="cell">
                <Amount v={it.r.entry} size={18} />
              </span>
              <span className="bpb-ends mono" role="cell">
                {timeLeft(it.r.expiresAt).replace(" left", "")}
              </span>
              <span className="bpb-act" role="cell">
                <Act it={it} size="sm" />
              </span>
            </div>
          );
        })}
      </div>
    </Rail>
  );
}

/* ——— C · Trading cards: portrait cards on a scrolling shelf, the Player's animal as the face, an explainer card first ——— */
export function RailC({ items, pnl = "spark" }: { items: Item[]; pnl?: PnlStyle }) {
  const track = useRef<HTMLDivElement>(null);
  const nudge = (d: number) => track.current?.scrollBy({ left: d * 300, behavior: "smooth" });
  return (
    <Rail
      id="back-a-player"
      title="Back a player"
      viewAll="/backing"
      cols={3}
      className="bpc"
      aside={
        <div className="bpc-arrows">
          <button type="button" className="cut cut-btn btn neutral sm" aria-label="Scroll left" onClick={() => nudge(-1)}>
            <ArrowLeft />
          </button>
          <button type="button" className="cut cut-btn btn neutral sm" aria-label="Scroll right" onClick={() => nudge(1)}>
            <ArrowRight />
          </button>
        </div>
      }
    >
      <div className="bpc-shelf" ref={track}>
        <div className="cut cut-card bpc-intro">
          <h3>Fund a Player’s entry. Share what they win.</h3>
          <ol>
            <li>Pick a Player by their record</li>
            <li>Offer to pay their entry</li>
            <li>They win: your entry back, plus your share</li>
          </ol>
          <Link href="/backing" className="cut cut-btn btn neutral sm">
            Post a Request
          </Link>
          <Bust name="herBacking" width={190} className="bpc-intro-bust" />
        </div>
        {[...items].sort(byStrength).map((it) => {
          const p = pct(it.r);
          return (
            <article key={it.key} className="cut cut-card bpc-card" data-game={it.r.game}>
              <div className="bpc-face">
                <Image className="bpc-art" src={art.hero[it.r.game]} alt="" fill sizes="280px" />
                <span className="bpc-game">{GAME_NAMES[it.r.game]}</span>
                <span className="bpc-time mono">
                  <ClockIcon width={12} height={12} />
                  {timeLeft(it.r.expiresAt).replace(" left", "")}
                </span>
                <Avatar it={it} size={132} className="bpc-avatar" />
              </div>
              <div className="bpc-body">
                <strong>
                  <AccountLink account={it.r.player} />
                </strong>
                {it.r.record.matches ? (
                  <dl className="bpc-stats">
                    <div>
                      <dd>{p}%</dd>
                      <dt>Won</dt>
                    </div>
                    <div>
                      <dd>{it.r.record.wins}</dd>
                      <dt>W</dt>
                    </div>
                    <div>
                      <dd>{it.r.record.matches - it.r.record.wins}</dd>
                      <dt>L</dt>
                    </div>
                  </dl>
                ) : null}
                {it.r.record.matches ? <Pnl r={it.r} style={pnl} /> : (
                  <p className="bpc-new">New Player · no settled Matches yet</p>
                )}
                <Act it={it} block>
                  Back for <GemaMark size={16} /> {fmtGemas(it.r.entry)}
                </Act>
              </div>
            </article>
          );
        })}
      </div>
    </Rail>
  );
}

/* P&L: the Player's Gemas won minus lost over their decided Matches (the Account page's figure), three ways. */
export type PnlStyle = "spark" | "split" | "figures" | "dots";
const signedG = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmtGemas(Math.abs(n))}`;
function Pnl({ r, style }: { r: ChainRequest; style: PnlStyle }) {
  const d = r.record.deltas ?? [];
  const won = d.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const lost = d.filter((x) => x < 0).reduce((a, b) => a - b, 0);
  const net = won - lost;
  const tone = net > 0 ? "up" : net < 0 ? "down" : "";
  const head = (
    <div className="bpc-pnl-head">
      <span>P&amp;L</span>
      <b className={tone}>
        <GemaMark size={16} />
        {signedG(net)}
      </b>
    </div>
  );
  if (style === "dots") return <Pips r={r} max={20} />;
  if (style === "spark")
    return (
      <div className="bpc-pnl spark">
        {head}
        <Spark deltas={d} />
      </div>
    );
  if (style === "split") {
    const total = won + lost || 1;
    return (
      <div className="bpc-pnl bar">
        {head}
        <span className="bpc-split" aria-hidden="true">
          <i className="down" style={{ width: `${(lost / total) * 100}%` }} />
          <i className="up" style={{ width: `${(won / total) * 100}%` }} />
        </span>
        <span className="bpc-split-legend">
          <span>Lost {fmtGemas(lost)}</span>
          <span>Won {fmtGemas(won)}</span>
        </span>
      </div>
    );
  }
  return (
    <dl className="bpc-pnl figures">
      <div>
        <dd className="up">{fmtGemas(won)}</dd>
        <dt>Won</dt>
      </div>
      <div>
        <dd className="down">{fmtGemas(lost)}</dd>
        <dt>Lost</dt>
      </div>
      <div>
        <dd className={tone}>{signedG(net)}</dd>
        <dt>P&amp;L</dt>
      </div>
    </dl>
  );
}

/** Running total as a step line: emerald above zero, red below. */
function Spark({ deltas }: { deltas: number[] }) {
  const totals = deltas.reduce<number[]>((acc, x) => [...acc, (acc.at(-1) ?? 0) + x], []);
  const hi = Math.max(0, ...totals);
  const lo = Math.min(0, ...totals);
  const span = hi - lo || 1;
  const n = totals.length || 1;
  const W = 240;
  const H = 44;
  const x = (i: number) => ((i + 1) / n) * W;
  const y = (v: number) => 2 + ((hi - v) / span) * (H - 4);
  const zero = y(0);
  const line = `M0,${zero}` + totals.map((v, i) => ` H${x(i)} V${y(v)}`).join("");
  const id = useId().replace(/[^\w-]/g, "");
  return (
    <svg className="bpc-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <clipPath id={`${id}u`}>
          <rect x="0" y="0" width={W} height={zero} />
        </clipPath>
        <clipPath id={`${id}d`}>
          <rect x="0" y={zero} width={W} height={H - zero} />
        </clipPath>
      </defs>
      <line x1="0" x2={W} y1={zero} y2={zero} className="zero" />
      <g clipPath={`url(#${id}u)`}>
        <path d={`${line} V${zero} Z`} className="area up" />
        <path d={line} className="ln up" />
      </g>
      <g clipPath={`url(#${id}d)`}>
        <path d={`${line} V${zero} Z`} className="area down" />
        <path d={line} className="ln down" />
      </g>
    </svg>
  );
}

/* ——— D · Deal desk: pick a Player from the list, the deal for that Request is worked out beside it ——— */
export function RailD({ items }: { items: Item[] }) {
  const list = [...items].sort(byStrength).slice(0, 5);
  const [sel, setSel] = useState(list[0]?.key);
  const it = list.find((x) => x.key === sel) ?? list[0];
  if (!it) return null;
  const win = ifWin(it.r.entry);
  const pot = it.r.entry * 2;
  const seg = (v: number) => `${(v / pot) * 100}%`;
  return (
    <Rail id="back-a-player" title="Back a player" viewAll="/backing" cols={3} className="bpd">
      <div className="cut cut-frame bpd-desk">
        <div className="bpd-pick" role="radiogroup" aria-label="Players asking to be backed">
          {list.map((x) => (
            <button
              key={x.key}
              type="button"
              role="radio"
              aria-checked={x.key === it.key}
              className={`cut cut-card bpd-opt${x.key === it.key ? " on" : ""}`}
              onClick={() => setSel(x.key)}
            >
              <span className="cut cut-btn avatar bpd-opt-avatar">
                <PlayerAvatar account={x.r.player} size={88} />
              </span>
              <span className="bpd-opt-who">
                <OptName account={x.r.player} />
                <small>
                  {GAME_NAMES[x.r.game]} · {x.r.record.matches ? `${x.r.record.wins}–${x.r.record.matches - x.r.record.wins}` : "New"}
                </small>
              </span>
              <span className="bpd-opt-pct">{x.r.record.matches ? `${pct(x.r)}%` : "—"}</span>
              <span className="bpd-opt-ask">
                <Amount v={x.r.entry} size={14} />
              </span>
            </button>
          ))}
        </div>
        <div className="bpd-deal">
          <div className="bpd-deal-art">
            <Image src={art.hero[it.r.game]} alt="" fill sizes="(min-width: 1100px) 640px, 100vw" />
          </div>
          <div className="bpd-deal-head">
            <Avatar it={it} size={72} className="bpd-avatar" />
            <div>
              <Label>The deal</Label>
              <strong>
                Back <AccountLink account={it.r.player} /> in {GAME_NAMES[it.r.game]}
              </strong>
              <span className="bpd-time">
                <ClockIcon width={13} height={13} /> {timeLeft(it.r.expiresAt)}
              </span>
            </div>
          </div>
          <div className="bpd-figs">
            <div>
              <span>You put in</span>
              <Amount v={it.r.entry} size={24} />
            </div>
            <div className="win">
              <span>They win: you get</span>
              <Amount v={win.back} size={24} />
            </div>
            <div className="lose">
              <span>They lose</span>
              <b>−{fmtGemas(it.r.entry)}</b>
            </div>
          </div>
          <div className="bpd-split" aria-label="How a winning Pot splits">
            <span className="back" style={{ width: seg(win.back - win.gain) }}>
              <i>Your entry back</i>
            </span>
            <span className="yours" style={{ width: seg(win.gain) }}>
              <i>Your share</i>
            </span>
            <span className="theirs" style={{ width: seg(win.player) }}>
              <i>Player</i>
            </span>
            <span className="fees" style={{ width: seg(win.fees) }} />
          </div>
          <p className="bpd-note">At a 60/40 split in your favour; you set the split in your Offer.</p>
          <Act it={it} size="lg">
            Offer <GemaMark size={18} /> {fmtGemas(it.r.entry)}
          </Act>
        </div>
      </div>
    </Rail>
  );
}
function OptName({ account }: { account: string }) {
  return <strong>{usePlayerLabel(account)}</strong>;
}

/* ——— E · Payoff tickets: each card leads with the money (in → back), the record is the fine print ——— */
export function RailE({ items }: { items: Item[] }) {
  return (
    <Rail id="back-a-player" title="Back a player" viewAll="/backing" cols={3} className="bpe">
      {[...items]
        .sort(byStrength)
        .slice(0, 3)
        .map((it) => {
          const win = ifWin(it.r.entry);
          return (
            <article key={it.key} className="cut cut-card bpe-ticket">
              <header className="bpe-top">
                <Avatar it={it} size={44} className="bpe-avatar" />
                <div>
                  <strong>
                    <AccountLink account={it.r.player} />
                  </strong>
                  <span>
                    {GAME_NAMES[it.r.game]} · {timeLeft(it.r.expiresAt)}
                  </span>
                </div>
                <span className="cut cut-chip bpe-thumb">
                  <Image src={art.hero[it.r.game]} alt="" fill sizes="96px" />
                </span>
              </header>
              <div className="bpe-pay">
                <div>
                  <span>You put in</span>
                  <b>
                    <GemaMark size={22} />
                    {fmtGemas(it.r.entry)}
                  </b>
                </div>
                <ArrowRight className="bpe-arrow" aria-hidden="true" />
                <div className="win">
                  <span>If they win</span>
                  <b>
                    <GemaMark size={22} />
                    {fmtGemas(win.back)}
                  </b>
                </div>
              </div>
              <div className="bpe-proof">
                {it.r.record.matches ? (
                  <>
                    <span>
                      Won <b>{it.r.record.wins}</b> of {it.r.record.matches} · {pct(it.r)}%
                    </span>
                    <Pips r={it.r} />
                  </>
                ) : (
                  <span>New Player · no settled Matches yet</span>
                )}
              </div>
              <footer className="bpe-foot">
                <Act it={it} block>
                  Offer
                </Act>
                <small>60/40 split shown; you set it in the Offer. If they lose, you lose the entry.</small>
              </footer>
            </article>
          );
        })}
    </Rail>
  );
}
