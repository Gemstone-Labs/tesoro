"use client";

import { useEffect, useState, useSyncExternalStore, type PointerEvent } from "react";
import { ChevronLeft, ChevronRight, Play } from "lucide-react";
import { Button, Sheet } from "@/components/ui";
import { useReducedMotion } from "@/games/fx/reduced-motion";
import { GUIDE_STEPS, clipPaths, type ClipSet } from "@/lib/how-to-play";
import { GAME_NAMES } from "@/lib/mock";
import type { GameId } from "@/lib/mock";
import { lastStepButtons, stepAfterKey } from "./guide-nav";
import "./how-to-play.css";

/**
 * Where the guide was opened from, which decides the last step's buttons:
 * game-page: Practice free + Done · first-practice: Start practice · practice-menu: Done (back to the pause card).
 */
export type GuideEnd = "game-page" | "first-practice" | "practice-menu";

const DESKTOP = "(min-width: 1024px)";
const subscribeDesktop = (cb: () => void) => {
  const mq = window.matchMedia(DESKTOP);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
const isDesktop = () => window.matchMedia(DESKTOP).matches;

function useClipSet(): ClipSet {
  return useSyncExternalStore(subscribeDesktop, () => (isDesktop() ? "desktop" : "phone"), () => "phone");
}

const SWIPE_PX = 48;

export interface HowToPlayProps {
  game: GameId;
  open: boolean;
  /** Close, by Done, Start practice, the close button, Esc or the backdrop. */
  onClose: () => void;
  end: GuideEnd;
  /** The Practice link of the "game-page" end. */
  practiceHref?: string;
}

/** Step-by-step guide with a looping clip per step: a bottom sheet on phones, a centred modal on wide screens. */
export function HowToPlay({ game, open, onClose, end, practiceHref }: HowToPlayProps) {
  return (
    <Sheet open={open} onClose={onClose} title={`How to play ${GAME_NAMES[game]}`} className="htp-sheet">
      <Guide game={game} end={end} practiceHref={practiceHref} onClose={onClose} />
    </Sheet>
  );
}

function Guide({ game, end, practiceHref, onClose }: Omit<HowToPlayProps, "open">) {
  const steps = GUIDE_STEPS[game];
  const set = useClipSet();
  const reduced = useReducedMotion();
  const [i, setI] = useState(0);
  const last = i === steps.length - 1;
  const step = steps[i];
  const go = (next: number) => setI(Math.min(steps.length - 1, Math.max(0, next)));

  // The next step's poster is fetched ahead; its video only loads once it is shown.
  useEffect(() => {
    if (i + 1 >= steps.length) return;
    const img = new Image();
    img.src = clipPaths(game, i + 2, set).poster;
  }, [game, i, set, steps.length]);

  const [downX, setDownX] = useState<number | null>(null);
  const onPointerDown = (e: PointerEvent) => { if (e.pointerType === "touch") setDownX(e.clientX); };
  const onPointerUp = (e: PointerEvent) => {
    if (downX === null) return;
    const dx = e.clientX - downX;
    setDownX(null);
    if (Math.abs(dx) >= SWIPE_PX) go(i + (dx < 0 ? 1 : -1));
  };
  // On the window: when the sheet opens, focus sits on its close button, outside the guide.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      setI((at) => stepAfterKey(e.key, at, steps.length));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [steps.length]);

  const [progress, setProgress] = useState({ step: 0, p: 0 });
  const onProgress = (p: number) => setProgress({ step: i, p });
  const fill = (n: number) => (n < i ? 1 : n > i ? 0 : progress.step === i && progress.p > 0 ? progress.p : playingStatic ? 1 : 0);
  const playingStatic = reduced;

  return (
    <div className="htp">
      <div className="cut cut-frame htp-stage" onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => setDownX(null)} data-set={set}>
        <Clip key={`${game}:${i}:${set}`} game={game} n={i + 1} set={set} onProgress={onProgress} />
        <div className="htp-bars" role="img" aria-label={`Step ${i + 1} of ${steps.length}`}>
          {steps.map((s, n) => <i key={s.title}><b style={{ transform: `scaleX(${fill(n)})` }} /></i>)}
        </div>
        <button type="button" className="htp-tap htp-tap-l" tabIndex={-1} aria-hidden="true" onClick={() => go(i - 1)} />
        <button type="button" className="htp-tap htp-tap-r" tabIndex={-1} aria-hidden="true" onClick={() => go(i + 1)} />
        <div className="htp-cap" aria-live="polite">
          <span className="htp-count">{i + 1} of {steps.length}</span>
          <h3 className="htp-title">{step.title}</h3>
          <p className="htp-line">{step.line}</p>
        </div>
      </div>
      <div className="htp-nav">
        {i > 0 && !last && <Button onClick={() => go(i - 1)} icon={<ChevronLeft aria-hidden="true" />}>Back</Button>}
        {!last ? (
          <Button variant="light" onClick={() => go(i + 1)}>Next <ChevronRight aria-hidden="true" /></Button>
        ) : (
          <>
            {end === "game-page" && practiceHref && <Button href={practiceHref}>Practice free</Button>}
            <Button variant="light" onClick={onClose}>{lastStepButtons(end).at(-1)}</Button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One step's clip: a looping muted video over its poster. Reduced motion shows the poster until tapped. A clip that fails
 * to load leaves the poster, and a missing poster leaves a plain frame, never a broken box.
 */
function Clip({ game, n, set, onProgress }: { game: GameId; n: number; set: ClipSet; onProgress: (p: number) => void }) {
  const reduced = useReducedMotion();
  const [tapped, setTapped] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);
  const { webm, mp4, poster } = clipPaths(game, n, set);
  const playing = (!reduced || tapped) && !videoFailed;
  return (
    <div className="htp-clip">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {!posterFailed && <img className="htp-poster" src={poster} alt="" onError={() => setPosterFailed(true)} />}
      {playing && (
        <video className="htp-video" autoPlay loop muted playsInline preload="auto" poster={posterFailed ? undefined : poster} aria-hidden="true" onTimeUpdate={(e) => { const v = e.currentTarget; if (v.duration) onProgress(v.currentTime / v.duration); }}>
          <source src={webm} type="video/webm" />
          <source src={mp4} type="video/mp4" onError={() => setVideoFailed(true)} />
        </video>
      )}
      {reduced && !tapped && !videoFailed && (
        <button type="button" className="cut cut-chip htp-play" onClick={() => setTapped(true)} aria-label="Play clip">
          <Play aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
