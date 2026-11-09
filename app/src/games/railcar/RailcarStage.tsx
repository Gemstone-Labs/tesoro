"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { PlayerAvatar } from "@/components/account/Player";
import { WHEEL_DEG_PER_PX, newRoll, rollFrame } from "./roll";
import type { Rider } from "./view";

/** The railcar art (art-source/railcar/round2, founder-approved prototype): the car and its window and wheel positions in source pixels. */
const ART = "/art/final/railcar";
const CAR_W = 1068;
const CAR_H = 351;
const WINDOW_X = Array.from({ length: 12 }, (_, i) => 138.5 + 71.4 * i);
const WHEEL_X = [145, 293, 768, 915];
const WHEEL_Y = 305;
/** The window the Player always sits in: the last seat, nearest the back of the car (the car rolls right, so the back is the left end). */
export const MY_WINDOW = 0;

/** Which rider each car window shows: the Player in the last seat at the back, the others aboard in seat order from the front. */
export function windowRiders(riders: Rider[]): (Rider | null)[] {
  const out: (Rider | null)[] = Array(WINDOW_X.length).fill(null);
  const me = riders.find((r) => r.me);
  if (me) out[MY_WINDOW] = me;
  const others = riders.filter((r) => !r.me);
  let k = 0;
  for (let w = WINDOW_X.length - 1; w >= 0 && k < others.length; w--) if (!out[w]) out[w] = others[k++];
  return out;
}

/** The Tell stages that change the car itself, in the order they fire (`view.tell` counts how many have). */
export const DAMAGE_STAGES = ["screws", "panel", "sparks"] as const;
export type DamageStage = (typeof DAMAGE_STAGES)[number];

/**
 * Art hook for the Tells on the train: a transparent overlay per stage, the same size and frame as `car.webp` (1068 × 351), drawn
 * over the car in place of the basic visual. Leave a stage out to keep its basic visual.
 */
export const DAMAGE_ART: Partial<Record<DamageStage, string>> = {};
/** Art hook for the crash: an overlay drawn over the stage while the car hits the wall, in place of the basic flash and debris. */
export const CRASH_ART: string | null = null;

const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface Leap {
  id: number;
  rider: Rider;
  /** Window index the Player leapt from (null when they had no window). */
  from: number;
}

/**
 * The side-view railcar in the cave. Still while Boarding; `moving` starts it rolling right (the cave scrolls left)
 * without remounting, so Boarding turns into the Ride in place. Players who leave `aboard` leap off their window.
 * The car gets faster with `rideMs` (the ride clock; see `roll.ts`); `slow` halves the speed (the Player's own Brake, ticket 11); nothing else on screen shows speed. `tell` is how many Tell stages
 * have fired: each changes the car itself (see `CarDamage`). `crash` stops the car and plays the impact (see `CrashMoment`).
 */
export function RailcarStage({ aboard, moving, slow = false, tell = 0, crash = false, rideMs = 0 }: { aboard: Rider[]; moving: boolean; slow?: boolean; tell?: number; crash?: boolean; rideMs?: number }) {
  const root = useRef<HTMLDivElement>(null);
  const windows = windowRiders(aboard);
  const [leaps, setLeaps] = useState<Leap[]>([]);
  const last = useRef<{ aboard: Rider[]; windows: (Rider | null)[] }>({ aboard, windows });
  const nextId = useRef(0);

  // A rider who was aboard and is not any more leapt off: from their window when they had one.
  useEffect(() => {
    const before = last.current;
    last.current = { aboard, windows };
    if (!moving) return;
    const gone = before.aboard.filter((r) => !aboard.some((a) => a.account === r.account));
    if (!gone.length) return;
    setLeaps((l) => [...l, ...gone.map((rider) => ({ id: nextId.current++, rider, from: Math.max(0, before.windows.findIndex((w) => w?.account === rider.account)) }))]);
  }, [aboard, windows, moving]);

  // The roll: CSS variables moved once a frame, no React render per frame. The roll state and the Brake live in refs, so
  // a Brake starting or ending changes the next frame's speed and never restarts the drawing.
  const roll = useRef(newRoll());
  const slowNow = useRef(slow);
  // The ride clock as the page last read it, and when: frames count on from it so the speed climbs smoothly between reads.
  const clock = useRef({ rideMs, at: 0 });
  useEffect(() => {
    slowNow.current = slow;
  });
  useEffect(() => {
    clock.current = { rideMs, at: performance.now() };
  }, [rideMs]);
  useEffect(() => {
    const el = root.current;
    if (!el || !moving || reduced()) return;
    roll.current = { ...roll.current, t: null };
    let raf = 0;
    const tick = (t: number) => {
      const r = (roll.current = rollFrame(roll.current, t, slowNow.current, clock.current.rideMs + Math.max(0, t - clock.current.at)));
      el.style.setProperty("--rc-far", `${r.far}px`);
      el.style.setProperty("--rc-mid", `${r.mid}px`);
      el.style.setProperty("--rc-trk", `${r.trk}px`);
      el.style.setProperty("--rc-wheel", `${-r.trk * WHEEL_DEG_PER_PX}deg`);
      el.style.setProperty("--rc-bob", `${Math.sin(t / 90) * 0.6 * r.speed}px`);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [moving]);

  return (
    <div ref={root} className={`rc-stage${moving ? " moving" : ""}${moving && slow ? " slow" : ""}${crash ? " crash" : ""}`} aria-hidden="true">
      <div className="rc-lay rc-far" style={{ backgroundImage: `url(${ART}/far.webp)` }} />
      <div className="rc-lay rc-mid" style={{ backgroundImage: `url(${ART}/mid.webp)` }} />
      <div className="rc-lay rc-trk" style={{ backgroundImage: `url(${ART}/track.webp)` }} />
      <div className="rc-car">
        {/* eslint-disable-next-line @next/next/no-img-element -- a sprite drawn over by the windows and wheels */}
        <img className="rc-car-art" src={`${ART}/car.webp`} alt="" width={CAR_W} height={CAR_H} draggable={false} />
        {windows.map((r, i) => (
          <span key={i} className={`rc-win${r ? " on" : ""}${r?.me ? " me" : ""}`} style={{ left: `${(WINDOW_X[i] / CAR_W) * 100}%` }}>
            {r && <PlayerAvatar account={r.account} size={56} />}
          </span>
        ))}
        {WHEEL_X.map((x) => (
          <span key={x} className="rc-wheel" style={{ left: `${(x / CAR_W) * 100}%`, top: `${(WHEEL_Y / CAR_H) * 100}%`, backgroundImage: `url(${ART}/wheel.webp)` }} />
        ))}
        <CarDamage tell={tell} />
        {leaps.map((l) => (
          <LeapOff key={l.id} leap={l} onDone={() => setLeaps((all) => all.filter((x) => x.id !== l.id))} />
        ))}
      </div>
      {crash && <CrashMoment />}
    </div>
  );
}

/** Screws: loose rivets along the sill under the windows, x in car art px. */
const SCREW_X = [190, 330, 480, 640, 790, 930];
/** The panel that works loose: a plate in the lower body, x and width in car art px. */
const PANEL = { x: 575, y: 208, w: 120, h: 36 };

/**
 * The Tells on the train: from the moment each Tell fires until the end of the ride the car itself shows it (screws popping from
 * the frame, a panel hanging loose, sparks at the wheels). `tell` is how many stages have fired (`view.tell`). Each stage is
 * one element in the car's frame, so the basic visual swaps for an image overlay through `DAMAGE_ART` without touching the rest.
 */
export function CarDamage({ tell, art = DAMAGE_ART }: { tell: number; art?: Partial<Record<DamageStage, string>> }) {
  return (
    <>
      {DAMAGE_STAGES.map((stage, i) => {
        if (tell <= i) return null;
        const overlay = art[stage];
        if (overlay) {
          return (
            // eslint-disable-next-line @next/next/no-img-element -- art overlay, the car's size
            <img key={stage} className={`rc-dmg rc-dmg-art rc-dmg-${stage}`} data-tell={stage} src={overlay} alt="" draggable={false} />
          );
        }
        return (
          <span key={stage} className={`rc-dmg rc-dmg-${stage}`} data-tell={stage}>
            {stage === "screws" && SCREW_X.map((x, k) => <i key={x} style={{ left: `${(x / CAR_W) * 100}%`, animationDelay: `${k * 0.07}s` }} />)}
            {stage === "panel" && <b style={{ left: `${(PANEL.x / CAR_W) * 100}%`, top: `${(PANEL.y / CAR_H) * 100}%`, width: `${(PANEL.w / CAR_W) * 100}%`, height: `${(PANEL.h / CAR_H) * 100}%` }} />}
            {stage === "sparks" &&
              WHEEL_X.flatMap((x) =>
                [0, 1, 2].map((k) => <i key={`${x}-${k}`} style={{ left: `${(x / CAR_W) * 100}%`, top: `${((WHEEL_Y + 30) / CAR_H) * 100}%`, animationDelay: `${k * 0.18 + (x % 7) * 0.03}s` }} />)
              )}
          </span>
        );
      })}
    </>
  );
}

/**
 * The crash: the car stops against the wall, the stage shakes, a flash and debris. Shown for `CRASH_MS` before the Result. The
 * picked art plugs in through `CRASH_ART` (an overlay over the whole stage); without it the basic flash and debris play.
 */
export function CrashMoment({ art = CRASH_ART }: { art?: string | null }) {
  return (
    <div className="rc-crash" data-testid="rc-crash">
      {art ? (
        // eslint-disable-next-line @next/next/no-img-element -- art overlay, the stage's size
        <img className="rc-crash-art" src={art} alt="" draggable={false} />
      ) : (
        <>
          <i className="rc-crash-flash" />
          {[0, 1, 2, 3, 4, 5, 6].map((k) => (
            <b key={k} className="rc-crash-bit" style={{ "--k": k } as CSSProperties} />
          ))}
        </>
      )}
    </div>
  );
}

/** One avatar leaping off backward and down to the track, then gone. */
function LeapOff({ leap, onDone }: { leap: Leap; onDone: () => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  useEffect(() => {
    const el = ref.current;
    if (!el || reduced() || typeof el.animate !== "function") {
      done.current();
      return;
    }
    const frames: Keyframe[] = [];
    const T = 1.6;
    for (let i = 0; i <= 16; i++) {
      const u = i / 16;
      const s = u * T;
      // Up and off the car, then the cave carries them away behind it (x in px, y in % of the car's height).
      const x = (leap.rider.me ? 46 : 30) * s - 95 * s * s;
      const y = 120 * u * u - 90 * Math.sin(Math.PI * u);
      frames.push({ transform: `translate(${x}px, ${y}%) rotate(${u * (leap.rider.me ? 300 : 200)}deg) scale(${1 + 0.2 * Math.sin(Math.PI * u)})`, opacity: u > 0.8 ? (1 - u) / 0.2 : 1 });
    }
    const a = el.animate(frames, { duration: T * 1000, easing: "linear", fill: "forwards" });
    a.onfinish = () => done.current();
    return () => a.cancel();
  }, [leap]);
  return (
    <span ref={ref} className="rc-leap" style={{ left: `${(WINDOW_X[leap.from] / CAR_W) * 100}%` }}>
      <PlayerAvatar account={leap.rider.account} size={64} />
    </span>
  );
}
