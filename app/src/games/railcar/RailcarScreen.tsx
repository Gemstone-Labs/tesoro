"use client";

import Link from "next/link";
import { ChevronLeft, CircleMinus, Hexagon, Info, UserPlus, Zap, type LucideIcon } from "lucide-react";
import { PlayerAvatar, PlayerName } from "@/components/account/Player";
import { Button, GemaAmount, GemaMark } from "@/components/ui";
import { fmtGemas } from "@/lib/format";
import { RailcarStage } from "./RailcarStage";
import type { RailcarView, ResultRow, Rider } from "./view";
import { clock } from "./words";
import "./railcar.css";

export { clock };
const g = (v: bigint) => Number(v);

const TELLS: { name: string; Icon: LucideIcon }[] = [
  { name: "Screws", Icon: CircleMinus },
  { name: "Panel", Icon: Hexagon },
  { name: "Sparks", Icon: Zap },
];

export interface RailcarActions {
  onBoard?: () => void;
  onStepOff?: () => void;
  onJump?: () => void;
  onPlayAgain?: () => void;
  onShare?: () => void;
  onAddFriend?: (account: string) => void;
}

export interface RailcarBrake {
  /** Brakes left this ride (1 or 0). */
  left: number;
  /** Ms left of the Player's own slow period (0 when none runs). */
  activeMs: number;
  onBrake?: () => void;
}

/**
 * The one Railcar screen. Boarding and the Ride share the stage, so when the car leaves the layout turns into the Ride in
 * place: no navigation, no loading, the car starts rolling right. The Result follows. `busy` names the step being sent.
 */
export function RailcarScreen({ view, actions = {}, busy = null, error = null, brake = null }: { view: RailcarView; actions?: RailcarActions; busy?: string | null; error?: string | null; brake?: RailcarBrake | null }) {
  if (view.phase === "result") return <RailcarResult view={view} actions={actions} />;
  const riding = view.phase === "ride";
  const aboard = riding ? view.aboard : view.riders;
  const meAboard = riding ? view.me?.aboard === true : view.mySeat !== null;
  return (
    <section className={`rc${riding ? " riding" : " boarding"}`} aria-label="Railcar">
      <Header entry={view.entry} />
      {riding ? (
        <div className="rc-top" key="ride">
          <p className="rc-clock mono" role="timer" aria-label={`Ride time ${clock(view.clockMs)}`}>
            {clock(view.clockMs)}
          </p>
          <ol className="rc-tells" aria-label="Tells">
            {TELLS.map(({ name, Icon }, i) => (
              <li key={name} className={`cut cut-chip rc-tell${view.tell > i ? " on" : ""}`} aria-current={view.tell === i + 1 ? "step" : undefined}>
                <Icon aria-hidden="true" />
                {name}
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <div className="rc-top" key="board">
          <div className="cut cut-card rc-count">
            {view.leavesInSec !== null ? (
              <>
                <span className="rc-count-label">Leaves in</span>
                <span className="rc-count-big mono" role="timer">
                  {clock(view.leavesInSec * 1000)}
                </span>
              </>
            ) : (
              <>
                <span className="rc-count-label">Waiting for {view.minSeats} Players</span>
                <span className="rc-count-sub">The countdown starts when {view.minSeats} have boarded</span>
              </>
            )}
          </div>
          <p className="cut cut-chip rc-aboard-n">
            <strong>{view.seated} aboard</strong> of {view.maxSeats} seats
          </p>
        </div>
      )}
      <div className="rc-stage-wrap">
        <RailcarStage aboard={aboard} moving={riding} slow={!!brake && brake.activeMs > 0} />
        {riding && brake && meAboard && brake.activeMs > 0 && (
          <p className="cut cut-chip rc-brake-tag">
            Your Brake <b className="mono">{Math.ceil(brake.activeMs / 1000)}s</b> · only you see this
          </p>
        )}
      </div>
      {riding && (
        <div className="cut cut-card rc-stake">
          <span>At stake</span>
          <GemaAmount value={g(view.stake)} size="lg" />
        </div>
      )}
      <Riders riders={aboard} label={riding ? `Aboard ${aboard.length}` : "Aboard"} note={riding ? "Names leave when they Jump" : undefined} />
      {!riding && view.mySeat !== null && <p className="cut cut-card rc-seat">Your seat {view.mySeat}</p>}
      <div className="rc-acts">
        {riding ? (
          view.me?.aboard ? (
            <>
              <Button variant="money" size="lg" block onClick={actions.onJump} disabled={!!busy}>
                {busy === "jump" ? "Jumping…" : "Jump"}
              </Button>
              {brake && (
                <div className="rc-brake">
                  <Button size="lg" block onClick={brake.onBrake} disabled={brake.left === 0 || brake.activeMs > 0}>
                    Brake <small>{brake.left} left</small>
                  </Button>
                </div>
              )}
            </>
          ) : view.me ? (
            <p className="cut cut-card rc-jumped">
              You jumped at <span className="mono">{clock(view.me.jumpMs)}</span>
              <GemaAmount value={g(view.me.back)} size="md" /> back
            </p>
          ) : null
        ) : view.mySeat !== null ? (
          <>
            <Button size="lg" block onClick={actions.onStepOff} disabled={!!busy}>
              {busy === "step-off" ? "Stepping off…" : "Step off"}
            </Button>
            <p className="rc-caption">
              Full <GemaMark size={12} /> {fmtGemas(g(view.entry))} back
            </p>
          </>
        ) : (
          <>
            <Button variant="money" size="lg" block onClick={actions.onBoard} disabled={!!busy || !actions.onBoard}>
              {busy === "board" ? "Boarding…" : (
                <>
                  Board · <GemaMark size={16} /> {fmtGemas(g(view.entry))}
                </>
              )}
            </Button>
            <p className="rc-caption">{actions.onBoard ? "Until it leaves you can step off and get your full entry back" : "Sign in to board"}</p>
          </>
        )}
      </div>
      {error && (
        <p className="rc-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function Header({ entry }: { entry: bigint }) {
  return (
    <header className="rc-head">
      <Link href="/play" className="cut cut-btn rc-ibtn" aria-label="Back to games">
        <ChevronLeft aria-hidden="true" />
      </Link>
      <div className="rc-title">
        <h1>Railcar</h1>
        <span className="cut cut-chip rc-entry">
          <GemaMark size={12} /> {fmtGemas(g(entry))}
        </span>
      </div>
      <Link href="/docs/railcar" className="cut cut-btn rc-ibtn" aria-label="How Railcar works">
        <Info aria-hidden="true" />
      </Link>
    </header>
  );
}

const SHOWN = 6;

function Riders({ riders, label, note }: { riders: Rider[]; label: string; note?: string }) {
  const mine = riders.filter((r) => r.me);
  const ordered = [...mine, ...riders.filter((r) => !r.me)];
  const shown = ordered.slice(0, SHOWN);
  const more = ordered.length - shown.length;
  return (
    <div className="rc-riders">
      <h2 className="rc-riders-h">
        <span>{label}</span>
        {note && <span className="rc-riders-note">{note}</span>}
      </h2>
      <ul className="rc-strip">
        {shown.map((r) => (
          <li key={r.account} className={`rc-rider${r.me ? " me" : ""}`}>
            <span className="cut rc-av">
              <PlayerAvatar account={r.account} size={44} />
            </span>
            {r.me ? <span className="rc-name">You</span> : <PlayerName account={r.account} className="rc-name" />}
          </li>
        ))}
        {more > 0 && (
          <li className="rc-rider">
            <span className="cut rc-av rc-more">+{more}</span>
          </li>
        )}
      </ul>
    </div>
  );
}

// ---- Result (re1 Podium) -------------------------------------------------------------------------------------------

function RailcarResult({ view, actions }: { view: Extract<RailcarView, { phase: "result" }>; actions: RailcarActions }) {
  const places = view.rows.filter((r) => r.kind === "place");
  const rest = view.rows.filter((r) => r.kind !== "place");
  const mine = view.mine;
  return (
    <section className="rc rc-result" aria-label="Railcar result">
      <header className="rc-res-head">
        <p className="rc-res-game">Railcar</p>
        <h1 className="rc-res-title">{mine?.headline ?? "Ride over"}</h1>
        {mine && (
          <p className={`rc-res-gets${mine.gets === 0n ? " lost" : ""}`}>
            You get <GemaAmount value={g(mine.gets)} size="xl" />
            {mine.won > 0n && (
              <span className="cut cut-chip rc-res-won">
                <GemaAmount value={g(mine.won)} size="sm" sign />
              </span>
            )}
          </p>
        )}
      </header>
      <Track wallMs={view.wallMs} jumps={view.jumps} outcome={view.outcome} />
      <p className="rc-res-facts">
        {view.rows.length} Players · Entry <GemaAmount value={g(view.entry)} size="sm" /> <span aria-hidden="true">|</span> Pot <GemaAmount value={g(view.pot)} size="sm" />
      </p>
      {places.length > 0 && (
        <ol className="rc-podium">
          {places.map((r) => (
            <li key={r.account} className={`cut cut-card rc-plate p${r.place}${r.me ? " me" : ""}`}>
              <span className="cut rc-av">
                <PlayerAvatar account={r.account} size={48} />
              </span>
              <span className="rc-plate-n">{r.place}</span>
              <span className="rc-plate-who">{r.me ? "You" : <PlayerName account={r.account} />}</span>
              {!r.me && actions.onAddFriend ? (
                <button type="button" className="cut cut-btn rc-friend" aria-label="Add friend" title="Add friend" onClick={() => actions.onAddFriend?.(r.account)}>
                  <UserPlus aria-hidden="true" />
                </button>
              ) : (
                <span />
              )}
              <GemaAmount value={g(r.gets)} size="lg" />
            </li>
          ))}
        </ol>
      )}
      <ul className="rc-rows">
        {rest.map((r) => (
          <ResultLine key={r.account} r={r} />
        ))}
        {view.outcome === "placed" && (
          <li className="cut cut-card rc-row fees">
            <span>Fees</span>
            <GemaAmount value={g(view.fees)} size="md" />
          </li>
        )}
      </ul>
      <div className="rc-res-acts">
        <Button variant="money" size="lg" block onClick={actions.onPlayAgain}>
          Play again
        </Button>
        <Button size="lg" block onClick={actions.onShare}>
          Share
        </Button>
      </div>
    </section>
  );
}

const ROW_WORD: Record<ResultRow["kind"], string> = { early: "jumped early", aboard: "aboard", refund: "refunded", place: "" };

function ResultLine({ r }: { r: ResultRow }) {
  return (
    <li className={`cut cut-card rc-row ${r.kind}${r.me ? " me" : ""}`}>
      <span className="cut rc-av sm">
        <PlayerAvatar account={r.account} size={32} />
      </span>
      <span className="rc-row-who">
        {r.me ? "You" : <PlayerName account={r.account} />} <span className="rc-row-word">{ROW_WORD[r.kind]}</span>
      </span>
      <GemaAmount value={g(r.gets)} size="md" />
    </li>
  );
}

/** Where the wall stood and when each Player Jumped, on one strip from 0:00 to the end. */
function Track({ wallMs, jumps, outcome }: { wallMs: number; jumps: { account: string; ms: number; me: boolean }[]; outcome: "placed" | "refund" }) {
  const end = Math.max(wallMs, ...jumps.map((j) => j.ms), 1);
  const at = (ms: number) => `${(ms / end) * 100}%`;
  return (
    <figure className="rc-track" aria-label={`The wall at ${clock(wallMs)}`}>
      <div className="rc-track-line">
        {jumps.map((j) => (
          <span key={j.account} className={`rc-track-jump${j.me ? " me" : ""}`} style={{ left: at(j.ms) }} title={clock(j.ms)} />
        ))}
        {outcome === "placed" && <span className="rc-track-wall" style={{ left: "100%" }} />}
      </div>
      <figcaption className="rc-track-ends">
        <span className="mono">0:00</span>
        <span className="mono">{outcome === "placed" ? `Wall ${clock(wallMs)}` : clock(wallMs)}</span>
      </figcaption>
    </figure>
  );
}
