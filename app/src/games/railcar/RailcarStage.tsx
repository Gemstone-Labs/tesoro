"use client";

import { useEffect, useRef, useState } from "react";
import { avatarFor } from "@/lib/art";
import type { Rider } from "./view";

/** The railcar art (art-source/railcar/round2, founder-approved prototype): the car and its window and wheel positions in source pixels. */
const ART = "/art/final/railcar";
const CAR_W = 1068;
const CAR_H = 351;
const WINDOW_X = Array.from({ length: 12 }, (_, i) => 137 + 71.4 * i);
const WHEEL_X = [145, 293, 768, 915];
const WHEEL_Y = 305;
/** The window the Player's own avatar rides in. */
const MY_WINDOW = 4;
/** Background scroll at full speed, px/s, far to near (the "speeds up" look is presentation only). */
const SPEED = { far: 14, mid: 40, trk: 130 };

/** Which rider each car window shows: the Player in their window, the others aboard in seat order. */
export function windowRiders(riders: Rider[]): (Rider | null)[] {
  const out: (Rider | null)[] = Array(WINDOW_X.length).fill(null);
  const me = riders.find((r) => r.me);
  if (me) out[MY_WINDOW] = me;
  const others = riders.filter((r) => !r.me);
  let k = 0;
  for (let w = 0; w < out.length && k < others.length; w++) if (!out[w]) out[w] = others[k++];
  return out;
}

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
 * `slow` halves the scroll (the Player's own Brake, ticket 11); nothing else on screen shows speed.
 */
export function RailcarStage({ aboard, moving, slow = false }: { aboard: Rider[]; moving: boolean; slow?: boolean }) {
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

  // The roll: CSS variables moved once a frame, no React render per frame.
  useEffect(() => {
    const el = root.current;
    if (!el || !moving || reduced()) return;
    let raf = 0;
    let lastT = 0;
    let speed = 0;
    const off = { far: 0, mid: 0, trk: 0 };
    const tick = (t: number) => {
      const dt = lastT ? Math.min((t - lastT) / 1000, 0.1) : 0;
      lastT = t;
      const target = slow ? 0.5 : 1;
      speed += (target - speed) * Math.min(dt * 2.5, 1);
      off.far -= SPEED.far * speed * dt;
      off.mid -= SPEED.mid * speed * dt;
      off.trk -= SPEED.trk * speed * dt;
      el.style.setProperty("--rc-far", `${off.far}px`);
      el.style.setProperty("--rc-mid", `${off.mid}px`);
      el.style.setProperty("--rc-trk", `${off.trk}px`);
      el.style.setProperty("--rc-wheel", `${off.trk * 1.4}deg`);
      el.style.setProperty("--rc-bob", `${Math.sin(t / 90) * 0.6 * speed}px`);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [moving, slow]);

  return (
    <div ref={root} className={`rc-stage${moving ? " moving" : ""}${moving && slow ? " slow" : ""}`} aria-hidden="true">
      <div className="rc-lay rc-far" style={{ backgroundImage: `url(${ART}/far.webp)` }} />
      <div className="rc-lay rc-mid" style={{ backgroundImage: `url(${ART}/mid.webp)` }} />
      <div className="rc-lay rc-trk" style={{ backgroundImage: `url(${ART}/track.webp)` }} />
      <div className="rc-car">
        {/* eslint-disable-next-line @next/next/no-img-element -- a sprite drawn over by the windows and wheels */}
        <img className="rc-car-art" src={`${ART}/car.webp`} alt="" width={CAR_W} height={CAR_H} draggable={false} />
        {windows.map((r, i) => (
          <span key={i} className={`rc-win${r ? " on" : ""}${r?.me ? " me" : ""}`} style={{ left: `${(WINDOW_X[i] / CAR_W) * 100}%` }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- small avatar sprite in a window */}
            {r && <img src={avatarFor(r.account)} alt="" draggable={false} />}
          </span>
        ))}
        {WHEEL_X.map((x) => (
          <span key={x} className="rc-wheel" style={{ left: `${(x / CAR_W) * 100}%`, top: `${(WHEEL_Y / CAR_H) * 100}%`, backgroundImage: `url(${ART}/wheel.webp)` }} />
        ))}
        {leaps.map((l) => (
          <LeapOff key={l.id} leap={l} onDone={() => setLeaps((all) => all.filter((x) => x.id !== l.id))} />
        ))}
      </div>
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
      {/* eslint-disable-next-line @next/next/no-img-element -- avatar sprite */}
      <img src={avatarFor(leap.rider.account)} alt="" />
    </span>
  );
}
