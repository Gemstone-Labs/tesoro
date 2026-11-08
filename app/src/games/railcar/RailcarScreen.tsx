"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { BookOpen, ChevronLeft, CircleMinus, Hexagon, UserPlus, Vibrate, VibrateOff, Zap, type LucideIcon } from "lucide-react";
import { PlayerAvatar, PlayerName } from "@/components/account/Player";
import { Button, GemaAmount, GemaMark } from "@/components/ui";
import { fmtGemas } from "@/lib/format";
import { GameMenu, type GameMenuItem } from "../fx";
import type { BrakeStatus } from "./brake";
import { RailcarStage } from "./RailcarStage";
import { railcarHaptics } from "./tells";
import type { RailcarView, ResultRow, Rider } from "./view";
import { clock } from "./words";
import "./railcar.css";

export { clock };
const g = (v: bigint) => Number(v);

export const TELLS: { name: string; Icon: LucideIcon }[] = [
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
  /** A signed-out Spectator's way in before boarding. */
  onSignIn?: () => void;
}

/** Someone watching a car they are not in: whether they can board now, and how many have boarded the next car (null: none yet). */
export interface RailcarWatch {
  signedIn: boolean;
  nextSeated: number | null;
}

export interface RailcarBrake {
  /** Where my Brake is (`brakeState`); without it, ready while one is left. */
  status?: BrakeStatus;
  /** Brakes left this ride (1 or 0). */
  left: number;
  /** Ms left of the Player's own slow period (0 when none runs). */
  activeMs: number;
  onBrake?: () => void;
}

const statusOf = (b: RailcarBrake): BrakeStatus => b.status ?? (b.activeMs > 0 ? "on" : b.left === 0 ? "used" : "ready");

/** The Brake button: one per ride, my own state only. */
function BrakeButton({ brake }: { brake: RailcarBrake }) {
  const status = statusOf(brake);
  const state = status === "ready" ? "1 left" : status === "sign" ? "sign first" : status === "sending" ? "sending" : status === "on" ? `${Math.ceil(brake.activeMs / 1000)}s` : status === "used" ? "used" : "soon";
  return (
    <div className={`rc-brake ${status}`}>
      <Button size="lg" block onClick={brake.onBrake} disabled={status !== "ready" && status !== "sign"} title="Halves the car for 5 s. Only you see it.">
        Brake <small className={status === "on" ? "mono" : undefined}>{state}</small>
      </Button>
    </div>
  );
}

/** An accepted Offer this page boards with (`/play/railcar?backing=<offer>`). */
export interface RailcarOffer {
  /** The Backer's core Account (base58). */
  backer: string;
  /** The Player's share of the winnings, in percent. */
  sharePct: number;
  /** Why it cannot board now (the Backer is in this car, the Offer is used or expired); the Board button then waits. */
  blocked?: string;
}

/**
 * The one Railcar screen. Boarding and the Ride share the stage, so when the car leaves the layout turns into the Ride in
 * place: no navigation, no loading, the car starts rolling right. The Result follows. `busy` names the step being sent.
 */
export function RailcarScreen({
  view,
  actions = {},
  busy = null,
  error = null,
  brake = null,
  offer = null,
  watch = null,
}: {
  view: RailcarView;
  actions?: RailcarActions;
  busy?: string | null;
  error?: string | null;
  brake?: RailcarBrake | null;
  offer?: RailcarOffer | null;
  watch?: RailcarWatch | null;
}) {
  if (view.phase === "result") return <RailcarResult view={view} actions={actions} watch={watch} />;
  const riding = view.phase === "ride";
  const aboard = riding ? view.aboard : view.riders;
  const meAboard = riding ? view.me?.aboard === true : view.mySeat !== null;
  return (
    <section className={`rc${riding ? " riding" : " boarding"}`} aria-label="Railcar">
      <Header entry={view.entry} />
      {riding ? (
        <div className="rc-top" key="ride">
          {watch && (
            <span className="cut cut-chip rc-live">
              <i aria-hidden="true" />
              Live
            </span>
          )}
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
        <RailcarStage aboard={aboard} moving={riding} slow={riding && meAboard && !!brake && brake.activeMs > 0} />
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
        {riding && watch && !view.me ? (
          <NextRide watch={watch} actions={actions} busy={busy} />
        ) : riding ? (
          view.me?.aboard ? (
            <>
              <Button variant="money" size="lg" block onClick={actions.onJump} disabled={!!busy}>
                {busy === "jump" ? "Jumping…" : "Jump"}
              </Button>
              {brake && <BrakeButton brake={brake} />}
              {brake && statusOf(brake) === "sign" && <p className="rc-brake-note">Sign once so your Brake stays secret on this device</p>}
            </>
          ) : view.me ? (
            <p className="cut cut-card rc-jumped">
              You jumped at <span className="mono">{clock(view.me.jumpMs)}</span> · at least
              <GemaAmount value={g(view.me.back)} size="md" /> back{view.me.backer && <> to <PlayerName account={view.me.backer} /></>}
            </p>
          ) : null
        ) : view.mySeat !== null ? (
          <>
            <Button size="lg" block onClick={actions.onStepOff} disabled={!!busy}>
              {busy === "step-off" ? "Stepping off…" : "Step off"}
            </Button>
            <p className="rc-caption">
              Full <GemaMark size={12} /> {fmtGemas(g(view.entry))} back{view.myBacker && <> to <PlayerName account={view.myBacker} /></>}
            </p>
          </>
        ) : (
          <>
            {offer && <BackedBy offer={offer} entry={view.entry} />}
            <Button variant="money" size="lg" block onClick={actions.onBoard} disabled={!!busy || !actions.onBoard || !!offer?.blocked}>
              {busy === "board" ? "Boarding…" : (
                <>
                  Board · <GemaMark size={16} /> {fmtGemas(g(view.entry))}
                </>
              )}
            </Button>
            <p className="rc-caption">
              {!actions.onBoard
                ? "Sign in to board"
                : offer
                  ? offer.blocked ?? "Until it leaves you can step off: the full entry goes back to your Backer"
                  : "Until it leaves you can step off and get your full entry back"}
            </p>
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

/** A Spectator's way into the next car: board it (signed in) or sign in first. */
function NextRide({ watch, actions, busy }: { watch: RailcarWatch; actions: RailcarActions; busy?: string | null }) {
  return (
    <>
      <Button variant="money" size="lg" block onClick={watch.signedIn ? actions.onBoard : actions.onSignIn} disabled={!!busy}>
        {busy === "board" ? "Boarding…" : "Play the next ride"}
      </Button>
      <p className="rc-caption">
        {watch.nextSeated === null ? "Boarding next: no car yet, you open it" : `Boarding next: ${watch.nextSeated} aboard`}
        {!watch.signedIn && <> · Sign in to board</>}
      </p>
    </>
  );
}

/** Before boarding with an Offer: whose Gemas board and how a ride splits. */
function BackedBy({ offer, entry }: { offer: RailcarOffer; entry: bigint }) {
  return (
    <div className="cut cut-card rc-backed" role="note" aria-label="Backing">
      <span className="cut rc-av sm">
        <PlayerAvatar account={offer.backer} size={32} />
      </span>
      <p className="rc-backed-body">
        <b>
          <PlayerName account={offer.backer} /> funds your entry
        </b>
        <span>
          Their <GemaMark size={11} /> {fmtGemas(g(entry))} board for you. Place and you keep {offer.sharePct}% of the winnings; you never owe anything.
        </span>
      </p>
    </div>
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
      <RailcarMenu />
    </header>
  );
}

/** The game menu: how Railcar works, vibration for the Tells (where the phone can), sound, full screen. */
function RailcarMenu() {
  const vibration = useSyncExternalStore(railcarHaptics.subscribe, railcarHaptics.enabled, () => true);
  const canVibrate = useSyncExternalStore(railcarHaptics.subscribe, railcarHaptics.supported, () => false);
  const items: GameMenuItem[] = [
    { label: "How Railcar works", icon: <BookOpen aria-hidden="true" />, href: "/docs/railcar" },
    ...(canVibrate
      ? [
          {
            label: vibration ? "Vibration on" : "Vibration off",
            icon: vibration ? <Vibrate aria-hidden="true" /> : <VibrateOff aria-hidden="true" />,
            checked: vibration,
            keepOpen: true,
            onSelect: () => {
              railcarHaptics.setEnabled(!vibration);
              if (!vibration) railcarHaptics.pulse([18]);
            },
          },
        ]
      : []),
  ];
  return <GameMenu className="rc-menu" items={items} leaveHref="/play" />;
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

function RailcarResult({ view, actions, watch }: { view: Extract<RailcarView, { phase: "result" }>; actions: RailcarActions; watch: RailcarWatch | null }) {
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
        {mine?.backer && (
          <p className="rc-res-backer">
            <PlayerName account={mine.backer.account} /> gets <GemaAmount value={g(mine.backer.gets)} size="sm" />
            <span className="rc-res-backer-note">{mine.backer.gets === 0n ? "Your Backer bears the loss" : "Your Backer's entry comes back first"}</span>
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
              {r.backing && <BackedSplit b={r.backing} me={r.me} />}
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
        {watch && !mine ? (
          <Button variant="money" size="lg" block onClick={watch.signedIn ? actions.onBoard : actions.onSignIn}>
            Play the next ride
          </Button>
        ) : (
          <Button variant="money" size="lg" block onClick={actions.onPlayAgain}>
            {mine ? "Play again" : "Play Railcar"}
          </Button>
        )}
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
      {r.backing && <BackedSplit b={r.backing} me={r.me} />}
    </li>
  );
}

/** A Backed seat's line under its amount: the Backer's part and the Player's. */
function BackedSplit({ b, me }: { b: NonNullable<ResultRow["backing"]>; me: boolean }) {
  return (
    <span className="rc-split">
      <PlayerName account={b.backer} /> <GemaAmount value={g(b.backerGets)} size="sm" /> <span aria-hidden="true">·</span> {me ? "you" : "Player"} <GemaAmount value={g(b.playerGets)} size="sm" />
    </span>
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
