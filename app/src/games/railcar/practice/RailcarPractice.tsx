"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { HowToPlay } from "@/components/how-to-play";
import { brakeState, tellCues } from "../brake";
import { RailcarScreen, type RailcarBrake } from "../RailcarScreen";
import { playTells } from "../tells";
import { newPractice, practiceBrake, practiceImpactMs, practiceJump, practiceTells, practiceView, type Practice } from "./session";

/** How often the screen reads the ride: the clock shows seconds, the Tells and Jumps land within a tenth. */
const FRAME_MS = 100;

const freshDraw = () => crypto.getRandomValues(new Uint8Array(32));

/**
 * Railcar Practice: you and 9 simulated riders, the real engine and odds, nothing staked and nothing sent. The boarding
 * countdown is skipped: the car leaves as the page opens, and Play again starts a new car at once. The menu's How to play
 * stops the ride until the guide closes.
 */
export function RailcarPractice({ draw }: { draw?: Uint8Array }) {
  // The crash point is drawn on mount (a draw on the server would mismatch hydration and show up in the page).
  const [ride, setRide] = useState<{ p: Practice; start: number } | null>(null);
  const [now, setNow] = useState(0);
  const heard = useRef<{ tell: number; falseScrews: number } | null>(null);
  // While the guide is open the ride stands still: closing it moves the start on by the time it was open.
  const [howAt, setHowAt] = useState<number | null>(null);
  const openHow = () => setHowAt(performance.now());
  const closeHow = () => {
    if (howAt === null) return;
    const at = performance.now();
    setRide((r) => (r ? { ...r, start: r.start + (at - howAt) } : r));
    setNow(at);
    setHowAt(null);
  };

  const start = useCallback((d: Uint8Array) => {
    heard.current = null;
    const at = performance.now();
    setNow(at);
    setRide({ p: newPractice(d), start: at });
  }, []);
  useEffect(() => {
    const id = setTimeout(() => start(draw ?? freshDraw()), 0);
    return () => clearTimeout(id);
  }, [draw, start]);

  const over = !!ride && now - ride.start >= practiceImpactMs(ride.p);
  const paused = howAt !== null;
  useEffect(() => {
    if (!ride || over || paused) return;
    const id = setInterval(() => setNow(performance.now()), FRAME_MS);
    return () => clearInterval(id);
  }, [ride, over, paused]);

  const t = ride ? Math.max(0, now - ride.start) : 0;
  // Each new Tell stage and false screw plays once, as on a real ride.
  useEffect(() => {
    if (!ride || over) return;
    const next = practiceTells(ride.p, t);
    playTells(tellCues(heard.current, next));
    heard.current = next;
  }, [ride, t, over]);

  if (!ride) return <p className="meta" role="status">Boarding…</p>;

  const view = practiceView(ride.p, t);
  const act = (f: (p: Practice, at: number) => Practice) => setRide((r) => (r ? { ...r, p: f(r.p, performance.now() - r.start) } : r));
  const mine = brakeState({ aboard: view.phase === "ride" && view.me?.aboard === true, allBound: true, myBound: true, canSign: true, walletCopied: true, pressMs: ride.p.brakeMs, pending: false, rideMs: t });
  const brake: RailcarBrake | null = mine && { ...mine, onBrake: () => act(practiceBrake) };

  return (
    <>
      <RailcarScreen
        view={view}
        practice
        paused={paused}
        brake={brake}
        actions={{ onJump: () => act(practiceJump), onPlayAgain: () => start(freshDraw()), onHowTo: openHow }}
      />
      <HowToPlay game="railcar" open={paused} onClose={closeHow} end="practice-menu" />
    </>
  );
}
