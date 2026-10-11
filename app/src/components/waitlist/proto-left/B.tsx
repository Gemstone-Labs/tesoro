"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { art } from "@/lib/art";

type Seat = { id: number; av: number; p: number };
const PITCH = 52;

/** Seat p -> position on a snake (left to right, then right to left), seats at PITCH apart. */
const at = (p: number, cols: number) => {
  const row = Math.floor(p / cols);
  const c = p % cols;
  return { x: (row % 2 ? cols - 1 - c : c) * PITCH, y: row * PITCH };
};

export function TheLine() {
  const box = useRef<HTMLDivElement>(null);
  const [dim, setDim] = useState({ cols: 6, rows: 3 });
  const [line, setLine] = useState<Seat[]>([]);
  const [joined, setJoined] = useState(false);
  const next = useRef(0);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setDim({ cols: Math.max(3, Math.floor((el.clientWidth + 6) / PITCH)), rows: Math.max(1, Math.floor((el.clientHeight - 30) / PITCH)) });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const total = dim.cols * dim.rows; // the last seat is yours
  const ahead = total - 1;

  // The line fills up, then moves: the head goes in to play, a new face joins the back.
  useEffect(() => {
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const mk = (p: number): Seat => ({ id: next.current++, av: (next.current * 5 + 3) % 12, p });
    setLine(Array.from({ length: ahead }, (_, p) => mk(p)));
    if (still) return;
    const t = setInterval(() => {
      setLine((l) => {
        const moved = l.filter((s) => s.p > 0).map((s) => ({ ...s, p: s.p - 1 }));
        return [...l.filter((s) => s.p === 0).map((s) => ({ ...s, p: -1, gone: true })), ...moved, mk(ahead - 1)] as Seat[];
      });
      setTimeout(() => setLine((l) => l.filter((s) => s.p >= 0)), 900);
    }, 2600);
    return () => clearInterval(t);
  }, [ahead]);

  // A successful Join (the real Server Action still runs) fills your seat.
  useEffect(() => {
    const main = document.querySelector(".wl-main");
    if (!main) return;
    const mo = new MutationObserver(() => setJoined(!!main.querySelector(".wl-done")));
    mo.observe(main, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);

  const you = at(total - 1, dim.cols);
  const path = Array.from({ length: total }, (_, p) => at(p, dim.cols)).map((q, i) => `${i ? "L" : "M"}${q.x + 22} ${q.y + 22}`).join(" ");
  return (
    <div className="pl-b-box" ref={box}>
      <p className="pl-b-tag">
        The line <span>{joined ? "You're in" : `${ahead} ahead of you`}</span>
      </p>
      <div className="pl-b-snake" style={{ width: dim.cols * PITCH - 6, height: dim.rows * PITCH - 6 }}>
        <svg className="pl-b-path" width={dim.cols * PITCH} height={dim.rows * PITCH} aria-hidden>
          <path d={path} />
        </svg>
        {line.map((s) => {
          const q = at(Math.max(0, s.p), dim.cols);
          return (
            <img
              key={s.id}
              className="pl-b-av"
              data-leaving={s.p < 0 ? "" : undefined}
              data-first={s.p === 0 ? "" : undefined}
              src={art.avatars[s.av]}
              alt=""
              width={44}
              height={44}
              style={{ transform: `translate(${q.x}px, ${q.y}px)`, ["--d" as string]: `${s.p * 40}ms` }}
            />
          );
        })}
        <div className="pl-b-you" data-joined={joined ? "" : undefined} style={{ transform: `translate(${you.x}px, ${you.y}px)` }}>
          {joined ? <img src={art.avatars[7]} alt="" width={44} height={44} /> : <span>You</span>}
          {joined && <i className="pl-b-burst" aria-hidden />}
          <em>{joined ? "You're #1,203" : "Your seat"}</em>
        </div>
      </div>
    </div>
  );
}
