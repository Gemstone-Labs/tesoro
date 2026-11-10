"use client";

import Link from "next/link";
import { useSyncExternalStore, type ReactNode } from "react";
import { BookOpen, ChevronLeft, CircleMinus, Dumbbell, Hexagon, ScrollText, UserPlus, Vibrate, VibrateOff, X, Zap, type LucideIcon } from "lucide-react";
import { HowToPlayTab } from "@/components/how-to-play";
import { PlayerAvatar, PlayerName } from "@/components/account/Player";
import { Button, GemaAmount, GemaMark } from "@/components/ui";
import { fmtGemas } from "@/lib/format";
import { practiceHref } from "@/lib/game-params";
import { Arena, GameMenu, type GameMenuItem } from "../fx";
import type { BrakeStatus } from "./brake";
import { useCrashMoment } from "./crash";
import { RailcarStage } from "./RailcarStage";
import { railcarHaptics } from "./tells";
import type { RailcarView, ResultRow, Rider } from "./view";
import { clock } from "./words";
import "./railcar.css";

export { clock };
const g = (v: bigint) => Number(v);

/** The Tells: the line icon (history) and the picked image (`public/art/final/railcar/tell-*.webp`) the chips show. */
export const TELLS: { name: string; Icon: LucideIcon; art: string }[] = [
  { name: "Screws", Icon: CircleMinus, art: "/art/final/railcar/tell-screws.webp" },
  { name: "Panel", Icon: Hexagon, art: "/art/final/railcar/tell-panel.webp" },
  { name: "Sparks", Icon: Zap, art: "/art/final/railcar/tell-sparks.webp" },
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
  /** Opens the How to play guide: the tab on the car while boarding, and the menu item (never while aboard a real ride). */
  onHowTo?: () => void;
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

/** The guide opens anywhere but a real ride the Player is in (never during a Match); Practice can stop for it. */
export const guideOpens = (view: RailcarView, practice: boolean): boolean => practice || view.phase !== "ride" || !view.me;

const statusOf = (b: RailcarBrake): BrakeStatus => b.status ?? (b.activeMs > 0 ? "on" : b.left === 0 ? "used" : "ready");

/** The Brake button: one per ride, my own state only. */
function BrakeButton({ brake }: { brake: RailcarBrake }) {
  const status = statusOf(brake);
  const state = status === "ready" ? "5s" : status === "sign" ? "sign first" : status === "sending" ? "sending" : status === "on" ? `${Math.ceil(brake.activeMs / 1000)}s` : status === "used" ? "used" : "soon";
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
 * `practice`: a Practice ride (the PRACTICE tag, and the Result says what a real entry would have paid).
 */
export function RailcarScreen(props: RailcarScreenProps) {
  const { view, crash } = useCrashMoment(props.view);
  return <RailcarBody {...props} view={view} crash={crash} />;
}

interface RailcarScreenProps {
  view: RailcarView;
  actions?: RailcarActions;
  busy?: string | null;
  error?: string | null;
  brake?: RailcarBrake | null;
  offer?: RailcarOffer | null;
  watch?: RailcarWatch | null;
  practice?: boolean;
  /** A Practice ride stopped while the guide is open: the car stands still. */
  paused?: boolean;
  /** Under the Result's amount: the Gemas this ride left waiting for room, with Claim (the live page's `RailcarWaiting`; Practice and history pass none). */
  waiting?: ReactNode;
}

function RailcarBody({
  view,
  actions = {},
  busy = null,
  error = null,
  brake: brakeProp = null,
  offer = null,
  watch = null,
  practice = false,
  paused = false,
  waiting = null,
  crash = false,
}: RailcarScreenProps & { crash?: boolean }) {
  // While the car hits the wall the ride is over: nothing left to press.
  const brake = crash ? null : brakeProp;
  if (view.phase === "result") return <RailcarResult view={view} actions={actions} watch={watch} practice={practice} waiting={waiting} />;
  const riding = view.phase === "ride";
  const aboard = riding ? view.aboard : view.riders;
  const meAboard = riding ? view.me?.aboard === true : view.mySeat !== null;
  // The window cover (never the browser's own full screen): a Player's ride covers from departure until the Result;
  // Boarding and watching stay in the shell. The ⋯ menu's Full screen and F toggle the same cover in every phase.
  return (
    <Arena game="railcar" autoFull={riding && view.me !== null}>
      <section className={`rc${riding ? " riding" : " boarding"}${practice ? " practice" : ""}`} aria-label="Railcar">
        <Header entry={view.entry} practice={practice} onHowTo={guideOpens(view, practice) ? actions.onHowTo : undefined} />
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
              {TELLS.map(({ name, art }, i) => (
                <li key={name} className={`cut cut-chip rc-tell${view.tell > i ? " on" : ""}`} aria-current={view.tell === i + 1 ? "step" : undefined}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- small picked image, 2x file */}
                  <img src={art} alt="" width={34} height={34} draggable={false} />
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
                </>
              )}
            </div>
            <p className="cut cut-chip rc-aboard-n">
              <strong>{view.seated} aboard</strong> of {view.maxSeats} seats
              {view.mySeat !== null && (
                <>
                  <span aria-hidden="true"> · </span>
                  <b className="rc-seat">Your seat {view.mySeat}</b>
                </>
              )}
            </p>
          </div>
        )}
        <div className="rc-stage-wrap">
          {!riding && actions.onHowTo && <HowToPlayTab name="Railcar" className="rc-how" onClick={actions.onHowTo} />}
          <RailcarStage aboard={aboard} moving={riding && !crash && !paused} slow={riding && meAboard && !!brake && brake.activeMs > 0} tell={riding ? view.tell : 0} rideMs={riding ? view.clockMs : 0} crash={crash} />
          {riding && brake && meAboard && brake.activeMs > 0 && (
            <p className="cut cut-chip rc-brake-tag">
              Your Brake <b className="mono">{Math.ceil(brake.activeMs / 1000)}s</b> · only you see this
            </p>
          )}
        </div>
        {riding && !practice && (
          <div className="cut cut-card rc-stake">
            <span>At stake</span>
            <GemaAmount value={g(view.stake)} size="lg" />
          </div>
        )}
        <Riders riders={aboard} label={riding ? `Aboard ${aboard.length}` : null} />
        <div className="rc-acts">
          {riding && watch && !view.me ? (
            <NextRide watch={watch} actions={actions} busy={busy} />
          ) : riding ? (
            view.me?.aboard ? (
              <>
                <Button variant="money" size="lg" block onClick={actions.onJump} disabled={!!busy || crash}>
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
              <div className="rc-act-stepoff">
                <Button size="lg" block onClick={actions.onStepOff} disabled={!!busy}>
                  {busy === "step-off" ? "Stepping off…" : "Step off"}
                  <small>
                    Full <GemaMark size={11} /> {fmtGemas(g(view.entry))} back{view.myBacker && <> to <PlayerName account={view.myBacker} /></>}
                  </small>
                </Button>
              </div>
            </>
          ) : (
            <>
              {offer && <BackedBy offer={offer} entry={view.entry} />}
              <div className="rc-act-main">
                <Button variant="money" size="lg" block onClick={actions.onBoard} disabled={!!busy || !actions.onBoard || !!offer?.blocked}>
                  {busy === "board" ? "Boarding…" : (
                    <>
                      Board · <GemaMark size={16} /> {fmtGemas(g(view.entry))}
                    </>
                  )}
                </Button>
              </div>
              {(!actions.onBoard || offer) && (
                <p className="rc-caption">{!actions.onBoard ? "Sign in to board" : (offer?.blocked ?? "Until it leaves you can step off: the full entry goes back to your Backer")}</p>
              )}
              <div className="rc-act-side">
                <Button size="lg" block href={practiceHref("railcar")} icon={<Dumbbell aria-hidden="true" />}>
                  Practice free
                </Button>
              </div>
            </>
          )}
        </div>
        {error && (
          <p className="rc-error" role="alert">
            {error}
          </p>
        )}
      </section>
    </Arena>
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

function Header({ entry, practice, onHowTo }: { entry: bigint; practice: boolean; onHowTo?: () => void }) {
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
        {practice && <span className="cut cut-chip game-tag">Practice</span>}
      </div>
      <RailcarMenu onHowTo={onHowTo} />
    </header>
  );
}

/** The game menu: How to play, the rulebook, vibration for the Tells (where the phone can), sound, full screen. */
function RailcarMenu({ onHowTo }: { onHowTo?: () => void }) {
  const vibration = useSyncExternalStore(railcarHaptics.subscribe, railcarHaptics.enabled, () => true);
  const canVibrate = useSyncExternalStore(railcarHaptics.subscribe, railcarHaptics.supported, () => false);
  const items: GameMenuItem[] = [
    ...(onHowTo ? [{ label: "How to play", icon: <BookOpen aria-hidden="true" />, onSelect: onHowTo }] : []),
    { label: "How Railcar works", icon: <ScrollText aria-hidden="true" />, href: "/docs/railcar" },
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

/** "You", a simulated Practice rider's name, or a Player's own name. */
function Who({ r, className }: { r: Rider; className?: string }) {
  if (r.me || r.name) return <span className={className}>{r.me ? "You" : r.name}</span>;
  return <PlayerName account={r.account} className={className} />;
}

const SHOWN = 6;

/** The riders row. Boarding has no label (the count above says it) and shows nothing until someone is aboard. */
function Riders({ riders, label }: { riders: Rider[]; label: string | null }) {
  if (!riders.length) return null;
  const mine = riders.filter((r) => r.me);
  const ordered = [...mine, ...riders.filter((r) => !r.me)];
  const shown = ordered.slice(0, SHOWN);
  const more = ordered.length - shown.length;
  return (
    <div className="rc-riders">
      {label && <h2 className="rc-riders-h">{label}</h2>}
      <ul className="rc-strip">
        {shown.map((r) => (
          <li key={r.account} className={`rc-rider${r.me ? " me" : ""}`}>
            <span className="cut rc-av">
              <PlayerAvatar account={r.account} size={44} />
            </span>
            <Who r={r} className="rc-name" />
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

function RailcarResult({ view, actions, watch, practice, waiting }: { view: Extract<RailcarView, { phase: "result" }>; actions: RailcarActions; watch: RailcarWatch | null; practice: boolean; waiting: ReactNode }) {
  const places = view.rows.filter((r) => r.kind === "place");
  const rest = view.rows.filter((r) => r.kind !== "place");
  const mine = view.mine;
  return (
    <section className="rc rc-result" aria-label="Railcar result">
      <header className="rc-res-head">
        <div className="rc-res-top">
          <p className="rc-res-game">
            Railcar{practice && <span className="cut cut-chip game-tag">Practice</span>}
          </p>
          <Link href="/play" className="cut cut-btn rc-ibtn" aria-label="Back to games" title="Back to games">
            <X aria-hidden="true" />
          </Link>
        </div>
        <h1 className="rc-res-title">{mine?.headline ?? "Ride over"}</h1>
        {mine && practice && (
          <p className="rc-res-would">
            A <GemaMark size={12} /> {fmtGemas(g(view.entry))} entry would have paid
          </p>
        )}
        {mine && (
          <p className={`rc-res-gets${mine.gets === 0n ? " lost" : ""}`}>
            {!practice && "You get "}
            <GemaAmount value={g(mine.gets)} size="xl" />
            {mine.won > 0n && (
              <span className="cut cut-chip rc-res-won">
                <GemaAmount value={g(mine.won)} size="sm" sign />
              </span>
            )}
          </p>
        )}
        {mine && !practice && waiting}
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
              <span className="rc-plate-who">
                <Who r={r} />
              </span>
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
      <div className={`rc-res-acts${practice ? " practice" : ""}`}>
        {watch && !mine ? (
          <Button variant="money" size="lg" block onClick={watch.signedIn ? actions.onBoard : actions.onSignIn}>
            Play the next ride
          </Button>
        ) : (
          <Button variant="money" size="lg" block onClick={actions.onPlayAgain}>
            {mine ? "Play again" : "Play Railcar"}
          </Button>
        )}
        {practice ? (
          <Button size="lg" block href="/play/railcar">
            Ride for real
          </Button>
        ) : (
          <Button size="lg" block onClick={actions.onShare}>
            Share
          </Button>
        )}
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
        <Who r={r} /> <span className="rc-row-word">{ROW_WORD[r.kind]}</span>
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
