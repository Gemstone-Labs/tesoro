"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useState } from "react";
import { GemaMark } from "@/components/ui/gema";
import { art } from "@/lib/art";

const NAMES = ["DA9K…P1bS", "qeE4…x7Hd", "Y8tw…UrXq", "7zr1…qh7M", "G7zD…cTYP", "AXwY…m3Kc", "4z6C…Nv2e", "H1pT…8bRa", "Lm5Q…d0Zs", "3cVj…yW9u"];
const GAMES: [string, number[]][] = [
  ["Block Puzzle", [900, 1800, 2400, 4500]],
  ["Hold'em", [600, 1000, 2000, 3500]],
  ["Trading Duel", [1200, 2500, 5000]],
];
type Win = { id: number; av: number; name: string; game: string; amt: number; at: number };

// Fixture data. Real data would be a cached server route over the settled-Match scan (see the report).
let seq = 0;
function make(ageS: number): Win {
  const n = seq++;
  const [game, amts] = GAMES[(n * 7 + 1) % GAMES.length];
  return { id: n, av: (n * 5 + 2) % 12, name: NAMES[(n * 3) % NAMES.length], game, amt: amts[(n * 11) % amts.length], at: Date.now() - ageS * 1000 };
}
const ago = (at: number, now: number) => {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  return s < 8 ? "just now" : s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
};

export function LiveWins() {
  const [wins, setWins] = useState<Win[]>(() => [make(94), make(61), make(33), make(17), make(6), make(1)].reverse());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const clock = setInterval(() => setNow(Date.now()), 1000);
    const feed = still ? undefined : setInterval(() => setWins((w) => [make(0), ...w].slice(0, 7)), 3400);
    return () => (clearInterval(clock), feed && clearInterval(feed));
  }, []);

  return (
    <div className="pl-a-box">
      <p className="pl-a-tag">
        <i className="pl-dot" aria-hidden /> Live wins
      </p>
      <ul className="pl-a-list" aria-label="Recent wins">
        {wins.map((w, i) => (
          <li key={w.id} className="pl-a-item" data-new={i === 0 && w.id > 5 ? "" : undefined}>
            <div className="pl-a-in cut cut-card">
              <img src={art.avatars[w.av]} alt="" width={34} height={34} />
              <div className="pl-a-who">
                <b>{w.name}</b>
                <span>
                  {w.game} · {ago(w.at, now)}
                </span>
              </div>
              <strong className="pl-a-amt">
                <GemaMark size={15} />+{w.amt.toLocaleString("en-US")}
              </strong>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
