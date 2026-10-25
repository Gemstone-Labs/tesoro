"use client";

import { useState } from "react";
import { Pause, Play } from "lucide-react";
import { createPracticeClock } from "./practice-clock";
import { GameActions, type GameActionsProps } from "./GameActions";
import "./practice-pause.css";

export function usePracticePause(source?: () => number) {
  const [clock] = useState(() => createPracticeClock(source));
  const [paused, setPaused] = useState(false);
  const toggle = () => {
    if (paused) clock.resume();
    else clock.pause();
    setPaused(!paused);
  };
  return { paused, toggle, now: clock.now };
}

export function PracticePauseButton({ paused, onToggle, disabled }: { paused: boolean; onToggle: () => void; disabled?: boolean }) {
  return <button type="button" className="cut cut-chip gmenu-btn practice-pause" aria-label={paused ? "Resume" : "Pause"} aria-pressed={paused} disabled={disabled} onClick={onToggle}>
    {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
  </button>;
}

export function PracticePauseOverlay({ onResume, items, leaveHref }: GameActionsProps & { onResume: () => void }) {
  return <div className="practice-paused" role="dialog" aria-modal="true" aria-label="Paused">
    <div className="cut cut-card practice-paused-card">
      <span className="label">Paused</span>
      <button type="button" className="cut cut-btn btn neutral lg" onClick={onResume} autoFocus><Play aria-hidden="true" /> Resume</button>
      <div className="practice-paused-actions"><GameActions items={items} leaveHref={leaveHref} /></div>
    </div>
  </div>;
}
