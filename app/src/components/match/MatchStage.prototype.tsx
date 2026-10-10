"use client";

/**
 * PROTOTYPE ONLY: the Match screens around play (waiting for an opponent, getting ready, ready,
 * saving, waiting for the result) for all three Games, drawn three ways and switched by
 * `?variant=`. Question: what should these screens show so they are short, clear and alive instead
 * of a card of paragraphs? Throwaway: fold the winner into the Match views properly, delete this.
 */
import Image from "next/image";
import { useEffect, useState, type ReactNode } from "react";
import { Check, Clock, Copy, EyeOff, Hourglass, Link2, Lock, Swords } from "lucide-react";
import { Busy, GemaAmount, GemaMark } from "@/components/ui";
import { Bust, type BustName } from "@/components/ui/Character";
import { PlayerAvatar } from "@/components/account/Player";
import { PrototypeSwitcher, usePrototypeVariant } from "@/components/prototype/PrototypeSwitcher";
import { art } from "@/lib/art";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import type { GameId } from "@/lib/mock";
import "./match-stage.prototype.css";

export const STAGE_VARIANTS = [
  { key: "A", name: "Versus arena" },
  { key: "B", name: "Poster + journey" },
  { key: "C", name: "Character + one figure" },
  { key: "now", name: "Current" },
] as const;
export type StageVariant = (typeof STAGE_VARIANTS)[number]["key"];

export type StageKind = "waiting" | "waiting-run" | "setup" | "ready" | "saving-run" | "awaiting" | "closing" | "backer-watch";

export type StageAction = { label: string; onClick: () => void; busy?: string | false; disabled?: boolean };

export interface StageModel {
  game: GameId;
  kind: StageKind;
  entry: number;
  /** What the winner takes: both entries minus Fees. */
  pot: number;
  me: string | null;
  opponent: string | null;
  /** Trading Duel asset symbol. */
  asset?: string;
  /** Block Puzzle: your score, once the run is over. */
  score?: number | null;
  /** The busy line while the chain works. */
  step?: string;
  /** Unix seconds: an unpaired Match can be refunded after this. */
  deadline?: number;
  challengeLink?: string | null;
  /** The Player is backed: their Backer funded the entry. */
  backedShareBps?: number | null;
  primary?: StageAction | null;
  /** Quiet actions: cancel, check, refunds. */
  actions?: StageAction[];
  error?: string | null;
  footer?: ReactNode;
}

export const HERO: Record<GameId, string> = { "block-puzzle": art.blockPuzzleHero, holdem: art.holdemHero, "trading-duel": art.tradingDuelHero };

const HIDDEN: Record<GameId, string> = { "block-puzzle": "Pieces hidden", holdem: "Cards hidden", "trading-duel": "Trades hidden" };

/** Title and one line per state: everything else is a chip or sits behind "How this works". */
function copy(m: StageModel): { kicker: string; title: string; line: string } {
  const g = GAME_NAMES[m.game];
  const opp = "your opponent";
  switch (m.kind) {
    case "waiting-run":
      return { kicker: `${g} · score in`, title: "Waiting for an opponent", line: "They get the same pieces and play against your score." };
    case "waiting":
      return {
        kicker: m.asset ? `${g} · ${m.asset}/USD` : g,
        title: "Waiting for an opponent",
        line: m.game === "holdem" ? "The cards are dealt the moment they sit down." : `Five minutes on ${m.asset ?? "SOL"}/USD start the moment they join.`,
      };
    case "setup":
      return {
        kicker: `${g} · opponent found`,
        title: "Get ready",
        line: m.game === "block-puzzle" ? "Your pieces are drawn in secret." : m.game === "holdem" ? "The deck is being shuffled in secret." : "You each get 10,000 Chips to trade.",
      };
    case "ready":
      return { kicker: g, title: "Your turn", line: "Same pieces as your opponent. Your clock starts when you press Start." };
    case "saving-run":
      return { kicker: `${g} · run over`, title: "Nice run", line: "Saving your last moves." };
    case "awaiting":
      return { kicker: `${g} · score in`, title: `Waiting for ${opp}`, line: "Both scores are revealed when they finish. The winner is paid at once." };
    case "closing":
      return { kicker: `${g} · Match over`, title: "Paying out the Pot", line: "Saving the result. A few seconds." };
    case "backer-watch":
      return { kicker: `${g} · you back this Player`, title: "Your Player is in", line: "You can watch, not play. The result pays out on its own." };
  }
}

/** Long-form detail, out of the way. */
function details(m: StageModel): string[] {
  const out = [
    m.backedShareBps != null ? `Your Backer's ${fmtGemas(m.entry)} Gemas are your entry. Win and you keep ${m.backedShareBps / 100}% of what is won above it; lose and it costs you nothing.` : `Your ${fmtGemas(m.entry)} Gemas are held for the Match. The winner takes ${fmtGemas(m.pot)}.`,
  ];
  if (m.game === "block-puzzle") out.push("You and your opponent get the same pieces, 90 seconds each, one after the other. Nobody sees a move until both runs are closed.");
  if (m.game === "holdem") out.push("1,500 Chips each, blinds rise every hand, 30 seconds per action. Your cards stay hidden from your opponent, and from us.");
  if (m.game === "trading-duel") out.push("Long or short, 1 to 20x, one position at a time. Higher final equity takes the Pot. Your trades stay hidden until the end.");
  if (m.deadline && (m.kind === "waiting" || m.kind === "waiting-run")) out.push(`If nobody joins by ${new Date(m.deadline * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}, your entry is refunded. You can leave this page and come back from the Lobby.`);
  return out;
}

function useNow(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

function left(deadline: number, now: number) {
  const s = Math.max(0, Math.floor(deadline - now / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${m}:${String(ss).padStart(2, "0")}`;
}

const isWaiting = (k: StageKind) => k === "waiting" || k === "waiting-run" || k === "awaiting" || k === "backer-watch";

/* ——— shared pieces ——— */

function Facts({ m, now }: { m: StageModel; now: number }) {
  return (
    <ul className="ms-facts">
      <li>
        <GemaMark size={14} />
        <b>{fmtGemas(m.pot)}</b> to the winner
      </li>
      <li>
        <EyeOff aria-hidden="true" />
        {HIDDEN[m.game]}
      </li>
      {m.kind === "ready" && (
        <li>
          <Clock aria-hidden="true" />
          90 s
        </li>
      )}
      {m.deadline && (m.kind === "waiting" || m.kind === "waiting-run") ? (
        <li>
          <Hourglass aria-hidden="true" />
          Refund in <b className="tnum">{left(m.deadline, now)}</b>
        </li>
      ) : null}
      {m.backedShareBps != null && (
        <li>
          <Lock aria-hidden="true" />
          Backed · you keep {m.backedShareBps / 100}%
        </li>
      )}
    </ul>
  );
}

function ChallengeLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  const short = link.replace(/^https?:\/\//, "");
  return (
    <div className="ms-link">
      <span className="ms-link-label">
        <Link2 aria-hidden="true" />
        Send this link to your friend
      </span>
      <div className="cut ms-link-row">
        <code>{short}</code>
        <button type="button" className="cut cut-btn btn neutral" onClick={() => void navigator.clipboard?.writeText(link).then(() => setCopied(true))}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function Actions({ m }: { m: StageModel }) {
  return (
    <>
      {m.step && <Busy>{m.step}…</Busy>}
      {m.primary && (
        <button type="button" className="cut cut-btn btn money lg block ms-primary" disabled={m.primary.disabled || !!m.primary.busy} onClick={m.primary.onClick}>
          {m.primary.busy || m.primary.label}
        </button>
      )}
      {m.actions && m.actions.length > 0 && (
        <div className="ms-quiet">
          {m.actions.map((a) => (
            <button key={a.label} type="button" disabled={a.disabled || !!a.busy} onClick={a.onClick}>
              {a.busy || a.label}
            </button>
          ))}
        </div>
      )}
      {m.error && <p className="status err" role="alert">{m.error}</p>}
    </>
  );
}

function HowItWorks({ m }: { m: StageModel }) {
  return (
    <details className="ms-how">
      <summary>How this works</summary>
      {details(m).map((d) => (
        <p key={d}>{d}</p>
      ))}
    </details>
  );
}

function Seat({ account, label, seeking, score }: { account: string | null; label: string; seeking?: boolean; score?: ReactNode }) {
  return (
    <figure className={`ms-seat${seeking ? " seeking" : ""}`}>
      <span className="cut ms-av">{account ? <PlayerAvatar account={account} size={128} /> : <span className="ms-q">?</span>}</span>
      <figcaption>{label}</figcaption>
      {score}
    </figure>
  );
}

/* ——— the switch ——— */

export function MatchStage({ model, current }: { model: StageModel; current: ReactNode }) {
  const v = usePrototypeVariant(STAGE_VARIANTS.map((x) => x.key));
  return (
    <>
      {v === "A" ? <StageArena m={model} /> : v === "B" ? <StagePoster m={model} /> : v === "C" ? <StageCharacter m={model} /> : current}
      <PrototypeSwitcher variants={STAGE_VARIANTS} />
    </>
  );
}

/* ——— A: versus arena ——— */

export function StageArena({ m }: { m: StageModel }) {
  const now = useNow(!!m.deadline);
  const c = copy(m);
  const you = m.score != null ? <span className="ms-score tnum">{m.score}</span> : m.kind === "awaiting" ? <span className="ms-score-q">Score in</span> : null;
  const oppScore = m.kind === "awaiting" ? <span className="ms-score-q"><Hourglass aria-hidden="true" /> Playing</span> : null;
  const seeking = m.kind === "waiting" || m.kind === "waiting-run";
  return (
    <section className="ms ms-a" aria-label={c.title}>
      <header className="ms-head">
        <span className="ms-kicker">{c.kicker}</span>
        <h1 className="ms-title">{c.title}</h1>
        <p className="ms-line">{c.line}</p>
      </header>
      <div className="ms-arena">
        <Seat account={m.me} label={m.kind === "backer-watch" ? "Your Player" : "You"} score={you} />
        <div className="cut cut-card ms-plaque">
          <span className="ms-label">Pot</span>
          <GemaAmount value={m.pot} size="lg" />
          <small>{fmtGemas(m.entry)} each · after Fees</small>
        </div>
        <Seat account={m.opponent} label={m.opponent ? "Opponent" : m.challengeLink ? "Your friend" : "Open seat"} seeking={seeking} score={oppScore} />
      </div>
      <div className="ms-foot">
        <Actions m={m} />
        {m.challengeLink && <ChallengeLink link={m.challengeLink} />}
        <Facts m={m} now={now} />
        <HowItWorks m={m} />
        {m.footer}
      </div>
    </section>
  );
}

/* ——— B: poster + journey ——— */

const JOURNEY: Record<GameId, string[]> = {
  "block-puzzle": ["Entered", "Your run", "Opponent", "Result"],
  holdem: ["Entered", "Opponent", "Play", "Result"],
  "trading-duel": ["Entered", "Opponent", "Trade", "Result"],
};

function journeyAt(m: StageModel): number {
  if (m.game === "block-puzzle") {
    if (m.kind === "setup" || m.kind === "ready") return 1;
    if (m.kind === "saving-run") return 1;
    if (m.kind === "waiting-run" || m.kind === "awaiting" || m.kind === "backer-watch") return 2;
    return 3;
  }
  if (m.kind === "waiting") return 1;
  if (m.kind === "setup") return 2;
  return 3;
}

export function StagePoster({ m }: { m: StageModel }) {
  const now = useNow(!!m.deadline);
  const c = copy(m);
  const at = journeyAt(m);
  return (
    <section className="ms ms-b" aria-label={c.title}>
      <div className="cut cut-frame ms-poster">
        <Image className="ms-poster-art" src={HERO[m.game]} alt="" fill sizes="(min-width: 1024px) 1100px, 100vw" priority />
        <div className="ms-poster-body">
          <span className="ms-kicker">{c.kicker}</span>
          <h1 className="ms-title">{c.title}</h1>
          <p className="ms-line">{c.line}</p>
          {m.score != null && (
            <p className="ms-poster-score">
              <span className="ms-label">Your score</span>
              <b className="tnum">{m.score}</b>
            </p>
          )}
          <Facts m={m} now={now} />
        </div>
      </div>
      <ol className="ms-journey" aria-label="Match progress">
        {JOURNEY[m.game].map((s, i) => (
          <li key={s} className={i < at ? "done" : i === at ? "now" : ""} aria-current={i === at ? "step" : undefined}>
            <span className="ms-dot">{i < at ? <Check aria-hidden="true" /> : i + 1}</span>
            <span>{s}</span>
          </li>
        ))}
      </ol>
      <div className="ms-foot">
        <Actions m={m} />
        {m.challengeLink && <ChallengeLink link={m.challengeLink} />}
        <HowItWorks m={m} />
        {m.footer}
      </div>
    </section>
  );
}

/* ——— C: character + one figure ——— */

function bustFor(m: StageModel): BustName {
  if (m.kind === "backer-watch") return "herBacking";
  if (m.kind === "ready") return "himExplain";
  if (m.kind === "setup") return "himWelcome";
  if (m.kind === "closing" || m.kind === "saving-run") return "himWin";
  return "himWaiting";
}

export function StageCharacter({ m }: { m: StageModel }) {
  const now = useNow(!!m.deadline);
  const c = copy(m);
  const figure: { label: string; value: ReactNode; money?: boolean } =
    m.score != null && m.kind !== "ready"
      ? { label: "Your score", value: <span className="tnum">{m.score}</span> }
      : (m.kind === "waiting" || m.kind === "waiting-run") && m.deadline
        ? { label: "Refund if nobody joins in", value: <span className="tnum">{left(m.deadline, now)}</span> }
        : {
            label: m.backedShareBps != null ? "The Pot · you keep " + m.backedShareBps / 100 + "%" : "Winner takes",
            value: (
              <>
                <GemaMark size={52} />
                <span className="tnum">{fmtGemas(m.pot)}</span>
              </>
            ),
            money: true,
          };
  return (
    <section className="ms ms-c" aria-label={c.title}>
      <span className="ms-kicker">{c.kicker}</span>
      <div className="ms-c-stage">
        <Bust name={bustFor(m)} width={260} className="ms-c-bust" priority />
        <div className="ms-c-talk">
          <div className="cut cut-card ms-bubble">
            <h1 className="ms-title">{c.title}</h1>
            <p className="ms-line">{c.line}</p>
          </div>
          <div className={`ms-figure${figure.money ? " money" : ""}`}>
            <span className="ms-label">{figure.label}</span>
            <b>{figure.value}</b>
          </div>
        </div>
      </div>
      <div className="ms-foot">
        <Actions m={m} />
        {m.challengeLink && <ChallengeLink link={m.challengeLink} />}
        <p className="ms-c-vs">
          <Swords aria-hidden="true" />
          {m.opponent ? (
            <>
              vs <PlayerAvatar account={m.opponent} size={28} className="ms-c-opp" /> {m.kind === "closing" ? "done" : m.kind === "setup" || m.kind === "ready" ? "ready" : isWaiting(m.kind) ? "playing now" : ""}
            </>
          ) : (
            "Opponent: still open"
          )}
          <span aria-hidden="true">·</span>
          <EyeOff aria-hidden="true" /> {HIDDEN[m.game]}
          {m.deadline && (m.kind === "waiting" || m.kind === "waiting-run") && m.score != null ? (
            <>
              <span aria-hidden="true">·</span>
              <Hourglass aria-hidden="true" /> Refund in <b className="tnum">{left(m.deadline, now)}</b>
            </>
          ) : null}
        </p>
        <HowItWorks m={m} />
        {m.footer}
      </div>
    </section>
  );
}
