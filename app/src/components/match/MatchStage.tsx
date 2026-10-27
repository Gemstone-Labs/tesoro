"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { ChartCandlestick, Check, ChevronDown, Clock, Copy, EyeOff, Hourglass, Link2, Lock, Puzzle, RotateCcw, Spade, Swords, type LucideIcon } from "lucide-react";
import { Busy, CountUp, GemaMark } from "@/components/ui";
import { PlayerAvatar } from "@/components/account/Player";
import { commitCopy, type CommitState } from "@/lib/chain/commit-pending";
import { CANCELLING_NOTE, NO_TABLE_NOTE, refundByText, tableWaitLine } from "@/lib/chain/match-status";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES, type GameId } from "@/lib/mock";
import "./match-stage.css";

/** Where a Match is before or after play: what the arena shows, not the chain phase behind it. */
export type StageKind = "waiting" | "waiting-run" | "setup" | "ready" | "saving-run" | "awaiting" | "closing" | "backer-watch";

export interface StageInfo {
  game: GameId;
  kind: StageKind;
  entry: number;
  /** What the winner takes: both entries minus Fees. */
  pot: number;
  /** The Player on the left: you, or the Player you back. */
  me: string | null;
  opponent: string | null;
  /** Trading Duel asset symbol. */
  asset?: string;
  /** Block Burst: your score, once the run is over. */
  score?: number | null;
  /** The busy line while the chain works. */
  step?: string;
  /** Unix seconds: an unpaired Match can be refunded after this. */
  deadline?: number;
  challengeLink?: string | null;
  /** The Player is backed: their Backer funded the entry. */
  backedShareBps?: number | null;
  /** Closing: the opponent never showed up, so their side stays idle instead of showing a finished run. */
  opponentAbsent?: boolean;
  /** Closing: the result is in and waiting to be committed to the chain. */
  commit?: CommitState | null;
  /** The Match is past its settle time and not settled (from `matchStanding`): it refunds by `refundBy`. */
  delayed?: { refundBy: number; refundOpen: boolean } | null;
  /** Words that replace the stage's own (Block Burst's table steps have a line of their own). */
  words?: { kicker?: string; title?: string; line?: string };
}

/** The line under "Waiting for an opponent", by Game. */
const WAITING_LINE: Record<GameId, (asset?: string | null) => string> = {
  "block-puzzle": () => "The Match starts when someone joins. You both play the same pieces at the same time.",
  holdem: () => "The cards are dealt the moment they sit down.",
  "trading-duel": (asset) => `A 30 second head start on ${asset ?? "SOL"}/USD starts the moment they join.`,
  vanguard: () => "Both armies are drawn in secret the moment they join.",
};
/** The line under "Get ready", by Game. */
const SETUP_LINE: Record<GameId, string> = {
  "block-puzzle": "Your pieces are drawn in secret.",
  holdem: "The deck is being shuffled in secret.",
  "trading-duel": "You each get 10,000 Chips to trade.",
  vanguard: "Your army is drawn in secret and the board is set.",
};

const HIDDEN: Record<GameId, string> = { "block-puzzle": "Pieces hidden", holdem: "Cards hidden", "trading-duel": "Picks hidden", vanguard: "Ranks hidden" };

/** Plain words for a Match that should have settled: the Gemas are safe and the refund has a time. */
export function delayedCopy(d: { refundBy: number; refundOpen: boolean }): { title: string; line: string } {
  return d.refundOpen
    ? { title: "Delayed, refund is open", line: "This Match should have settled by now. Your entry is safe: refund the Match to get it back, or wait for the result." }
    : {
        title: "Delayed",
        line: `This Match should have settled by now. Your entry is safe: if it has not settled by ${refundByText(d.refundBy, Date.now())}, it is refunded. You can leave this page.`,
      };
}

/** Title and one line per state: everything else is a chip or sits behind "How this works". */
function copy(m: StageInfo): { kicker: string; title: string; line: string } {
  return { ...stock(m), ...m.words };
}

function stock(m: StageInfo): { kicker: string; title: string; line: string } {
  const g = GAME_NAMES[m.game];
  const opp = "your opponent";
  if (m.delayed && (m.kind === "awaiting" || m.kind === "closing")) return { kicker: `${g} · Match delayed`, ...delayedCopy(m.delayed) };
  switch (m.kind) {
    case "waiting-run":
      return { kicker: `${g} · score in`, title: "Waiting for an opponent", line: "They get the same pieces and play against your score." };
    case "waiting":
      return {
        kicker: m.asset ? `${g} · ${m.asset}/USD` : g,
        title: "Waiting for an opponent",
        line: WAITING_LINE[m.game](m.asset),
      };
    case "setup":
      if (m.step === CANCELLING_NOTE) return { kicker: g, title: "Cancelling", line: `Your ${fmtGemas(m.entry)} Gemas are on their way back.` };
      if (m.step === NO_TABLE_NOTE) return { kicker: `${g} · opponent found`, title: "Waiting for a table", line: tableWaitLine(m.deadline, Date.now()) };
      return {
        kicker: `${g} · opponent found`,
        title: "Get ready",
        line: SETUP_LINE[m.game],
      };
    case "ready":
      return { kicker: g, title: "Your turn", line: "Same pieces as your opponent. Your clock starts when you press Start." };
    case "saving-run":
      return { kicker: `${g} · run over`, title: "Nice run", line: "Saving your last moves." };
    case "awaiting":
      return { kicker: `${g} · score in`, title: `Waiting for ${opp}`, line: "Both scores are revealed when they finish. The winner is paid at once." };
    case "closing":
      if (m.commit) return { kicker: `${g} · Match over`, ...commitCopy(m.commit) };
      return { kicker: `${g} · Match over`, title: "Paying out the Pot", line: "Saving the result. A few seconds." };
    case "backer-watch":
      return { kicker: `${g} · you back this Player`, title: "Your Player is in", line: "You can watch, not play. The result pays out on its own." };
  }
}

/** Long-form detail, out of the way. */
const GAME_ICON: Record<GameId, LucideIcon> = { "block-puzzle": Puzzle, holdem: Spade, "trading-duel": ChartCandlestick, vanguard: Swords };

function details(m: StageInfo): { icon: LucideIcon; title: string; text: string }[] {
  const out = [
    m.backedShareBps != null
      ? { icon: Lock, title: "Your entry", text: `Your Backer's ${fmtGemas(m.entry)} Gemas are your entry. Win and you keep ${m.backedShareBps / 100}% of what is won above it; lose and it costs you nothing.` }
      : { icon: Lock, title: "Your entry", text: `Your ${fmtGemas(m.entry)} Gemas are held for the Match. The winner takes ${fmtGemas(m.pot)}.` },
  ];
  const play = {
    "block-puzzle": "You and your opponent play the same pieces at the same time for 90 seconds. You see their last score until the final 10 seconds, when both scores are hidden. Higher score wins.",
    holdem: "1,500 Chips each, blinds rise every hand, 30 seconds per action. Your cards stay hidden from your opponent, and from us.",
    "trading-duel": "Pick a box in each of 12 columns; the live line passing through it scores 100 points. More points takes the Pot. Your picks stay hidden until each column locks.",
    vanguard: "Blitz Stratego: 20 pieces each, 10 seconds a move, every rank has a power, capture the enemy Supply Truck to win. Only you can see your pieces' ranks; an enemy piece shows its rank only once it has fought.",
  }[m.game];
  out.push({ icon: GAME_ICON[m.game], title: "The game", text: play });
  if (m.deadline && (m.kind === "waiting" || m.kind === "waiting-run"))
    out.push({ icon: RotateCcw, title: "If nobody joins", text: `By ${new Date(m.deadline * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} your entry is refunded. You can leave this page and come back from the Lobby.` });
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

function Facts({ m, now }: { m: StageInfo; now: number }) {
  return (
    <ul className="stage-facts">
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
      {m.delayed && !m.delayed.refundOpen ? (
        <li>
          <Hourglass aria-hidden="true" />
          Refunds by <b className="tnum">{refundByText(m.delayed.refundBy, now)}</b>
        </li>
      ) : null}
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
    <div className="stage-link">
      <span className="stage-link-label">
        <Link2 aria-hidden="true" />
        Send this link to your friend
      </span>
      <div className="cut stage-link-row">
        <code>{short}</code>
        <button type="button" className="cut cut-btn btn neutral" onClick={() => void navigator.clipboard?.writeText(link).then(() => setCopied(true))}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function HowItWorks({ m }: { m: StageInfo }) {
  return (
    <details className="stage-how">
      <summary>
        How this works <ChevronDown aria-hidden="true" />
      </summary>
      <ul className="cut stage-how-list">
        {details(m).map(({ icon: Icon, title, text }) => (
          <li key={title}>
            <Icon aria-hidden="true" />
            <b>{title}</b>
            <p>{text}</p>
          </li>
        ))}
      </ul>
    </details>
  );
}

type SeatState = "idle" | "seeking" | "working" | "ready" | "playing" | "done";
type RailFlow = "in" | "out" | "scan" | "lit" | "off";

/** What each side of the arena is doing in this state: drives the rings, rails and particles. */
function arenaMotion(m: StageInfo): { me: SeatState; opp: SeatState; left: RailFlow; right: RailFlow; fountain: boolean } {
  const opp = !!m.opponent;
  switch (m.kind) {
    case "waiting":
    case "waiting-run":
      return { me: m.score != null ? "done" : "idle", opp: opp ? "idle" : "seeking", left: "in", right: opp ? "in" : "scan", fountain: false };
    case "setup":
      return { me: "working", opp: opp ? "working" : "seeking", left: "out", right: opp ? "out" : "scan", fountain: false };
    case "ready":
      return { me: "ready", opp: opp ? "idle" : "seeking", left: "lit", right: opp ? "lit" : "scan", fountain: false };
    case "saving-run":
      return { me: "working", opp: opp ? "idle" : "seeking", left: "in", right: opp ? "lit" : "off", fountain: false };
    case "awaiting":
      return { me: "done", opp: opp ? "playing" : "seeking", left: "lit", right: opp ? "in" : "scan", fountain: false };
    case "backer-watch":
      return { me: "playing", opp: opp ? "playing" : "seeking", left: "lit", right: opp ? "in" : "scan", fountain: false };
    case "closing":
      return m.opponentAbsent
        ? { me: "done", opp: "idle", left: "lit", right: "off", fountain: true }
        : { me: "done", opp: "done", left: "lit", right: "lit", fountain: true };
  }
}

const TOKEN: Record<GameId, string> = { "block-puzzle": "bp", holdem: "deal", "trading-duel": "chip", vanguard: "chip" };

/** The line between a seat and the Pot: Gemas flow in, hidden pieces are dealt out, or a scan looks for the opponent. */
function Rail({ flow, side, game }: { flow: RailFlow; side: "l" | "r"; game: GameId }) {
  return (
    <span className={`stage-rail ${side} ${flow}`} aria-hidden="true">
      <span className="stage-rail-line" />
      {flow === "in" && [0, 1, 2].map((i) => <i key={i} style={{ animationDelay: `${i * 0.7}s` }}><GemaMark size={14} /></i>)}
      {flow === "out" && [0, 1, 2, 3].map((i) => <i key={i} className={`stage-tok ${TOKEN[game]}`} style={{ animationDelay: `${i * 0.45}s` }} />)}
      {flow === "scan" && <b />}
    </span>
  );
}

function ArenaSeat({ account, label, state, side, score }: { account: string | null; label: string; state: SeatState; side: "l" | "r"; score?: ReactNode }) {
  return (
    <figure className={`stage-seat ${side} ${state}`}>
      <span className="stage-av-wrap">
        <span className="stage-ring" aria-hidden="true" />
        {state === "seeking" && (
          <span className="stage-radar" aria-hidden="true">
            <i />
            <i />
          </span>
        )}
        <span className="cut stage-av">
          {account ? <PlayerAvatar account={account} size={128} /> : <span className="stage-q">?</span>}
          {state === "seeking" && <span className="stage-sweep" aria-hidden="true" />}
        </span>
        {state === "done" && (
          <span className="stage-badge" aria-hidden="true">
            <Check />
          </span>
        )}
      </span>
      <figcaption>
        {label}
        {state === "playing" && (
          <span className="stage-dots" aria-label="playing">
            <i />
            <i />
            <i />
          </span>
        )}
      </figcaption>
      {score}
    </figure>
  );
}


/**
 * The Match screens around play, for every Game: you and your opponent's seat with the Pot
 * between, one title, one line, one main action. The motion says what is happening (Gemas flow
 * into the Pot, hidden pieces are dealt, the empty seat scans) so the copy can stay short; the
 * long rules sit behind "How this works".
 */
export function MatchStage({
  start,
  actions,
  error,
  children,
  ...m
}: StageInfo & {
  /** The one big button (Start). */
  start?: ReactNode;
  /** Quiet text actions: cancel, check, refunds. */
  actions?: ReactNode;
  error?: string | null;
  /** Under everything: receipts, the test-mode note. */
  children?: ReactNode;
}) {
  const now = useNow(!!m.deadline);
  const c = copy(m);
  const mo = arenaMotion(m);
  const you =
    m.score != null ? (
      <span className="stage-score tnum">
        <CountUp value={m.score} from={0} format={String} duration={1100} />
      </span>
    ) : m.kind === "awaiting" ? (
      <span className="stage-score-q">Score in</span>
    ) : null;
  const oppScore =
    m.kind === "awaiting" ? (
      <span className="stage-score-q">
        <Hourglass className="stage-glass" aria-hidden="true" /> Playing
      </span>
    ) : null;
  return (
    // Keyed by kind so the entrance plays again at every step of the Match.
    <section key={m.kind} className={`stage k-${m.kind}`} aria-label={c.title}>
      <header className="stage-head">
        <span className="stage-kicker">{c.kicker}</span>
        <h1 className="stage-title">{c.title}</h1>
        <p className="stage-line">{c.line}</p>
      </header>
      <div className="stage-arena">
        <ArenaSeat account={m.me} label={m.kind === "backer-watch" ? "Your Player" : "You"} state={mo.me} side="l" score={you} />
        <Rail flow={mo.left} side="l" game={m.game} />
        <div className="stage-pot">
          <div className="cut cut-card stage-plaque">
            <span className="stage-sheen" aria-hidden="true" />
            <span className="stage-label">Winner takes</span>
            <span className="gema-amount lg">
              <GemaMark size={20} glint />
              <span>
                <CountUp value={m.pot} from={0} duration={1400} />
                <span className="sr-only"> Gemas</span>
              </span>
            </span>
            <small>{fmtGemas(m.entry)} each · after Fees</small>
          </div>
          {mo.fountain && (
            <span className="stage-fountain" aria-hidden="true">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <i key={i} style={{ "--x": `${(i - 2.5) * 22}px`, animationDelay: `${i * 0.28}s` } as CSSProperties}>
                  <GemaMark size={16} />
                </i>
              ))}
            </span>
          )}
        </div>
        <Rail flow={mo.right} side="r" game={m.game} />
        <ArenaSeat account={m.opponent} label={m.opponent ? "Opponent" : m.challengeLink ? "Your friend" : "Open seat"} state={mo.opp} side="r" score={oppScore} />
      </div>
      <div className="stage-foot">
        {m.step && <Busy>{m.step}…</Busy>}
        {start && <span className="stage-go">{start}</span>}
        <div className="stage-quiet">{actions}</div>
        {error && (
          <p className="status err" role="alert">
            {error}
          </p>
        )}
        {m.challengeLink && <ChallengeLink link={m.challengeLink} />}
        <Facts m={m} now={now} />
        <HowItWorks m={m} />
        {children}
      </div>
    </section>
  );
}

/**
 * The stage before the Match has been read: the same header, seats, Pot and busy line, with the
 * parts not known yet left blank, so the screen does not jump when the Match arrives.
 */
export function MatchStageLoading({ game, me, step = "Loading the Match" }: { game?: GameId; me: string | null; step?: string }) {
  return (
    <section className="stage k-loading" aria-label="Loading the Match" aria-busy="true">
      <header className="stage-head">
        <span className="stage-kicker">{game ? GAME_NAMES[game] : "Match"}</span>
        <h1 className="stage-title">One moment</h1>
        <p className="stage-line">Finding your seat at this Match.</p>
      </header>
      <div className="stage-arena">
        <ArenaSeat account={me} label="You" state="idle" side="l" />
        <Rail flow="off" side="l" game={game ?? "block-puzzle"} />
        <div className="stage-pot">
          <div className="cut cut-card stage-plaque">
            <span className="stage-label">Winner takes</span>
            <span className="gema-amount lg">
              <GemaMark size={20} />
              <span className="stage-wait" />
            </span>
            <small>after Fees</small>
          </div>
        </div>
        <Rail flow="off" side="r" game={game ?? "block-puzzle"} />
        <ArenaSeat account={null} label="Opponent" state="idle" side="r" />
      </div>
      <div className="stage-foot">
        <Busy>{step}…</Busy>
      </div>
    </section>
  );
}

/** A quiet text action under the arena: cancel, check, refunds. */
export function StageAction({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

