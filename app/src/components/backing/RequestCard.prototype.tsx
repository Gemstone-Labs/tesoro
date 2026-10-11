"use client";

/**
 * PROTOTYPE ONLY: four takes on the Backing board's Request card, all grown from the Lobby's Player
 * card (BackPlayerRail): the Player's animal over the Game's art, record, P&L. `?variant=now|A|B|C|D`.
 * Throwaway: the winner gets rewritten into RequestCard.tsx.
 */
import Image from "next/image";
import type { ReactNode } from "react";
import type { ChainRequest } from "@/lib/chain/backing";
import { timeLeft } from "@/lib/chain/useBackingBoard";
import { signed } from "@/lib/chain/player-account";
import { art } from "@/lib/art";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import { ClockIcon, GemaMark } from "@/components/ui";
import { AccountLink } from "@/components/account/AccountLink";
import { PlayerAvatar, usePlayerLabel } from "@/components/account/Player";
import { Pnl } from "@/components/lobby/BackPlayerRail";
import "./request-card.prototype.css";

export const RQ_VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Poster" },
  { key: "B", name: "Portrait strip" },
  { key: "C", name: "Form guide" },
  { key: "D", name: "Ticket" },
] as const;
export type RqVariant = (typeof RQ_VARIANTS)[number]["key"];

interface Props {
  r: ChainRequest;
  action: ReactNode;
  nowMs?: number;
  selected?: boolean;
  id?: string;
}

export function RequestCardVariant({ variant, ...p }: Props & { variant: Exclude<RqVariant, "now"> }) {
  const View = { A: Poster, B: Strip, C: Form, D: Ticket }[variant];
  return <View {...p} />;
}

function useCard(p: Props) {
  const name = usePlayerLabel(p.r.player);
  const { matches, wins } = p.r.record;
  const pct = matches ? Math.round((wins / matches) * 100) : 0;
  const left = timeLeft(p.r.expiresAt, p.nowMs);
  return { name, matches, wins, losses: matches - wins, pct, left, game: GAME_NAMES[p.r.game] };
}

const shell = (p: Props, v: string, name: string, game: string) => ({
  id: p.id,
  className: `cut cut-card rqp rqp-${v}${p.selected ? " selected" : ""}`,
  "aria-label": `${name}, ${game}`,
});

function Time({ left }: { left: string }) {
  return (
    <span className="rqp-time mono" aria-label={left}>
      <ClockIcon width={12} height={12} />
      {left.replace(" left", "")}
    </span>
  );
}

function Ask({ entry, label = "Asks for" }: { entry: number; label?: string }) {
  return (
    <div className="rqp-ask">
      <span>{label}</span>
      <b>
        <GemaMark size={20} />
        {fmtGemas(entry)}
      </b>
    </div>
  );
}

function Avatar({ player, className }: { player: string; className: string }) {
  return (
    <AccountLink account={player} decorative className={`cut cut-btn avatar ${className}`}>
      <PlayerAvatar account={player} size={264} />
    </AccountLink>
  );
}

/** A: the Lobby card at board width. Big animal centred over the art, name, record, P&L, ask + Offer. */
function Poster(p: Props) {
  const c = useCard(p);
  return (
    <article {...shell(p, "A", c.name, c.game)}>
      <div className="rqp-face">
        <Image className="rqp-art" src={art.hero[p.r.game]} alt="" fill sizes="440px" />
        <span className="rqp-game">{c.game}</span>
        <Time left={c.left} />
        <Avatar player={p.r.player} className="rqp-a-avatar" />
      </div>
      <div className="rqp-a-body">
        <strong className="rqp-name">
          <AccountLink account={p.r.player} />
        </strong>
        {c.matches ? (
          <>
            <dl className="rqp-stats">
              <div>
                <dt>Won</dt>
                <dd>{c.pct}%</dd>
              </div>
              <div>
                <dt>W</dt>
                <dd>{c.wins}</dd>
              </div>
              <div>
                <dt>L</dt>
                <dd>{c.losses}</dd>
              </div>
            </dl>
            <Pnl deltas={p.r.pnl} />
          </>
        ) : (
          <p className="rqp-new">New Player · no settled Matches yet</p>
        )}
        <footer className="rqp-foot">
          <Ask entry={p.r.entry} />
          {p.action}
        </footer>
      </div>
    </article>
  );
}

/** B: the animal as a tall portrait down the left edge over the Game art; everything else stacked beside it. */
function Strip(p: Props) {
  const c = useCard(p);
  return (
    <article {...shell(p, "B", c.name, c.game)}>
      <div className="rqp-b-side">
        <Image className="rqp-art" src={art.hero[p.r.game]} alt="" fill sizes="160px" />
        <AccountLink account={p.r.player} decorative className="rqp-b-face">
          <PlayerAvatar account={p.r.player} size={264} />
        </AccountLink>
      </div>
      <div className="rqp-b-main">
        <div className="rqp-b-head">
          <span className="rqp-b-game">{c.game}</span>
          <Time left={c.left} />
        </div>
        <strong className="rqp-name">
          <AccountLink account={p.r.player} />
        </strong>
        {c.matches ? (
          <>
            <div className="rqp-b-rec">
              <b>{c.pct}%</b>
              <span>
                won · {c.wins}–{c.losses}
              </span>
            </div>
            <Pnl deltas={p.r.pnl} />
          </>
        ) : (
          <p className="rqp-new">New Player · no settled Matches yet</p>
        )}
        <footer className="rqp-foot">
          <Ask entry={p.r.entry} />
        </footer>
        {p.action}
      </div>
    </article>
  );
}

/** C: art across the whole card; the record told as form, the last ten Matches as W / L pips. */
function Form(p: Props) {
  const c = useCard(p);
  const last = p.r.pnl.slice(-10);
  const net = p.r.pnl.reduce((a, d) => a + d, 0);
  return (
    <article {...shell(p, "C", c.name, c.game)}>
      <Image className="rqp-art rqp-c-bg" src={art.hero[p.r.game]} alt="" fill sizes="440px" />
      <div className="rqp-c-top">
        <span className="rqp-game">{c.game}</span>
        <Time left={c.left} />
      </div>
      <div className="rqp-c-who">
        <Avatar player={p.r.player} className="rqp-c-avatar" />
        <div>
          <strong className="rqp-name">
            <AccountLink account={p.r.player} />
          </strong>
          {c.matches ? (
            <span className="rqp-c-line">
              {c.pct}% won · {c.matches} {c.matches === 1 ? "Match" : "Matches"}
            </span>
          ) : (
            <span className="rqp-c-line">New Player</span>
          )}
        </div>
      </div>
      <div className="rqp-c-panel">
        {c.matches ? (
          <>
            <div className="rqp-c-row">
              <span className="rqp-k">Last {last.length}</span>
              <span className={`rqp-c-net ${net > 0 ? "up" : net < 0 ? "down" : ""}`}>
                <GemaMark size={14} />
                {signed(net)}
              </span>
            </div>
            <ol className="rqp-pips" aria-label={`Last ${last.length} Matches`}>
              {last.map((d, i) => (
                <li key={i} className={d > 0 ? "w" : "l"}>
                  {d > 0 ? "W" : "L"}
                </li>
              ))}
              {Array.from({ length: 10 - last.length }, (_, i) => (
                <li key={`e${i}`} className="e" aria-hidden="true" />
              ))}
            </ol>
          </>
        ) : (
          <p className="rqp-new">No settled Matches yet. An early Backer sets the price.</p>
        )}
        <footer className="rqp-foot">
          <Ask entry={p.r.entry} />
          {p.action}
        </footer>
      </div>
    </article>
  );
}

/** D: a ticket. Face on top, P&L as the headline, the ask on a torn stub. */
function Ticket(p: Props) {
  const c = useCard(p);
  return (
    <article {...shell(p, "D", c.name, c.game)}>
      <div className="rqp-d-face">
        <Image className="rqp-art" src={art.hero[p.r.game]} alt="" fill sizes="440px" />
        <Avatar player={p.r.player} className="rqp-d-avatar" />
        <div className="rqp-d-id">
          <span className="rqp-game">{c.game}</span>
          <strong className="rqp-name">
            <AccountLink account={p.r.player} />
          </strong>
        </div>
        <Time left={c.left} />
      </div>
      <div className="rqp-d-body">
        {c.matches ? (
          <>
            <Pnl deltas={p.r.pnl} />
            <dl className="rqp-d-chips">
              <div>
                <dt>Won</dt>
                <dd>{c.pct}%</dd>
              </div>
              <div>
                <dt>W – L</dt>
                <dd>
                  {c.wins}–{c.losses}
                </dd>
              </div>
            </dl>
          </>
        ) : (
          <p className="rqp-new">New Player · no settled Matches yet</p>
        )}
      </div>
      <footer className="rqp-d-stub">
        <Ask entry={p.r.entry} label="Entry" />
        {p.action}
      </footer>
    </article>
  );
}
