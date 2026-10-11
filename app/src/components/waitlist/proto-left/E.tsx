"use client";

import { useEffect, useState } from "react";

/** Wall clip number (clips.ts) -> the name shown while that game's tiles lift. */
const GAMES: [number, string][] = [
  [1, "Block Puzzle"], [2, "Hold'em"], [3, "Trading Duel"], [4, "2048"], [5, "Match-3"], [6, "Bubbles"],
  [7, "Breakout"], [8, "Fruit Match"], [9, "Snake"], [10, "Plinko"], [11, "Color Flood"],
];
const HOLD = 2400;

const Word = ({ text, out }: { text: string; out?: boolean }) => (
  <span className="pl-e-line">
    {[...text].map((ch, i) => (
      <span key={i} className="pl-e-ch" data-out={out ? "" : undefined} style={{ ["--i" as string]: i }}>
        {ch === " " ? " " : ch}
      </span>
    ))}
  </span>
);

export function KineticType() {
  const [i, setI] = useState(0);
  const [prev, setPrev] = useState<number | null>(null);

  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setI((c) => (setPrev(c), (c + 1) % GAMES.length)), HOLD);
    return () => clearInterval(t);
  }, []);

  const [clip, name] = GAMES[i];
  const words = name.toUpperCase().split(" ");
  const longest = Math.max(...words.map((w) => w.length));
  const size = Math.min(34, 96 / (longest * 0.43));

  return (
    <div className="pl-e-box">
      {/* the wall's tiles for this game lift, the rest sink back */}
      <style>{`.wl .vw-clip{transition:filter .6s,opacity .6s;filter:brightness(.62) saturate(.85)}.wl .vw-clip[data-clip="${clip}"]{filter:brightness(1.22) saturate(1.1);outline:2px solid rgba(234,239,236,.7);outline-offset:-2px}`}</style>
      <p className="pl-e-tag">
        On the wall <span>{String(i + 1).padStart(2, "0")} / {GAMES.length}</span>
      </p>
      <div className="pl-e-stage" style={{ ["--fs" as string]: `${size}cqw` }}>
        {prev !== null && prev !== i && (
          <h2 key={`o${prev}`} className="pl-e-name pl-e-prev" aria-hidden>
            {GAMES[prev][1].toUpperCase().split(" ").map((w, k) => <Word key={k} text={w} out />)}
          </h2>
        )}
        <h2 key={`n${i}`} className="pl-e-name" aria-label={name}>
          {words.map((w, k) => <Word key={k} text={w} />)}
        </h2>
      </div>
    </div>
  );
}
