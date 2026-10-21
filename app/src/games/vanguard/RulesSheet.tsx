"use client";

import { useEffect, useRef } from "react";
import { NAMES } from "./rules";
import { POWER_LINES } from "./powers-ui";

const art = (rank: string) => `url(/art/vanguard/faces/us-${rank}.webp)`;

/** The in-game ranks sheet: each rank's marker as it looks on the board, its name and its power in one line, strongest first. */
/** `onClose` should be stable (the screen re-renders every frame while the clock runs). */
export function RulesSheet({ onClose }: { onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="vg-rules" role="dialog" aria-label="Ranks and powers">
      <header className="vg-rules-head">
        <h3>Ranks and powers</h3>
        <button ref={close} type="button" className="vg-rules-x" onClick={onClose} aria-label="Close ranks and powers">
          Close
        </button>
      </header>
      <p className="vg-rules-legend">
        <span className="vg-rules-coin seen" aria-hidden="true">
          <span style={{ backgroundImage: art("F") }} />
        </span>
        <span>A red glow round one of your pieces means the enemy has seen it face up.</span>
      </p>
      <ol className="vg-rules-list">
        {POWER_LINES.map(([rank, line]) => (
          <li key={rank}>
            <span className="vg-rules-coin" aria-hidden="true">
              <span style={{ backgroundImage: art(rank) }} />
              <b>{rank}</b>
            </span>
            <span className="vg-rules-text">
              <span className="vg-rules-name">{NAMES[rank]}</span>
              <span>{line}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
